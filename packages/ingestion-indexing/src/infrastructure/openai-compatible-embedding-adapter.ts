import {
  assertValidEmbeddingProfile,
  embeddingProfilesMatch,
  embeddingVectorMatchesProfile,
  type DocumentRetrievalEmbeddingProfile,
} from "../domain/embedding-profile.js";
import {
  EmbeddingProviderFault,
  type EmbeddingPort,
  type EmbeddingProviderOutput,
  type EmbeddingProviderRequest,
} from "../ports/embedding.js";

const FORBIDDEN_HEADERS = new Set([
  "connection",
  "content-length",
  "content-type",
  "host",
  "transfer-encoding",
]);
const DEFAULT_REMOTE_EMBEDDING_MAX_BATCH_SIZE = 64;
const MAX_CONFIGURED_REMOTE_EMBEDDING_BATCH_SIZE = 2_048;
const MAX_REMOTE_EMBEDDING_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_REMOTE_EMBEDDING_RESPONSE_BYTES = 16 * 1024 * 1024;

export interface OpenAiCompatibleEmbeddingAdapterOptions {
  readonly endpoint: string;
  /** Exact immutable vector family served by this binding. */
  readonly profile: DocumentRetrievalEmbeddingProfile;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch?: typeof globalThis.fetch;
  readonly maxBatchSize?: number;
}

/** Configured adapter for OpenAI-compatible `/embeddings` endpoints. */
export class OpenAiCompatibleEmbeddingAdapter implements EmbeddingPort {
  readonly providerKind = "remote" as const;
  readonly embeddingProfile: DocumentRetrievalEmbeddingProfile;

  readonly #endpoint: string;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #fetch: typeof globalThis.fetch;
  readonly #maxBatchSize: number;
  readonly #model: string;

  constructor(options: OpenAiCompatibleEmbeddingAdapterOptions) {
    assertValidEmbeddingProfile(options.profile);
    if (options.profile.execution.kind !== "remote") {
      throw new TypeError("remote embedding adapter requires a remote profile");
    }
    this.#model = options.profile.execution.model;
    this.embeddingProfile = freezeProfile(options.profile);
    this.#endpoint = validateEndpoint(options.endpoint);
    this.#headers = validateHeaders(options.headers ?? {});
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (
      options.maxBatchSize !== undefined &&
      (!Number.isSafeInteger(options.maxBatchSize) ||
        options.maxBatchSize <= 0 ||
        options.maxBatchSize > MAX_CONFIGURED_REMOTE_EMBEDDING_BATCH_SIZE)
    ) {
      throw new TypeError("remote embedding batch size is invalid");
    }
    this.#maxBatchSize =
      options.maxBatchSize ?? DEFAULT_REMOTE_EMBEDDING_MAX_BATCH_SIZE;
  }

  async embed(
    request: EmbeddingProviderRequest,
  ): Promise<readonly EmbeddingProviderOutput[]> {
    request.signal.throwIfAborted();
    if (!embeddingProfilesMatch(request.profile, this.embeddingProfile)) {
      throw new EmbeddingProviderFault("invalid_request", false);
    }
    if (request.inputs.length === 0) return [];
    if (
      request.inputs.length > this.#maxBatchSize ||
      new Set(request.inputs.map((input) => input.key)).size !==
        request.inputs.length ||
      request.inputs.some(
        (input) => input.key.trim() === "" || input.text.trim() === "",
      )
    ) {
      throw new EmbeddingProviderFault("invalid_request", false);
    }
    const body = JSON.stringify({
      model: this.#model,
      input: request.inputs.map((input) => input.text),
    });
    if (
      new TextEncoder().encode(body).byteLength >
      MAX_REMOTE_EMBEDDING_REQUEST_BYTES
    ) {
      throw new EmbeddingProviderFault("input_limit_exceeded", false);
    }
    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: {
          ...this.#headers,
          "content-type": "application/json",
        },
        body,
        redirect: "error",
        signal: request.signal,
      });
    } catch (error) {
      if (request.signal.aborted) {
        throw error;
      }
      throw new EmbeddingProviderFault("provider_unavailable", true);
    }

    if (!response.ok) {
      throw mapHttpFailure(response.status);
    }

    let payload: unknown;
    try {
      payload = await readBoundedJson(response);
    } catch (error) {
      if (request.signal.aborted) throw request.signal.reason;
      if (error instanceof EmbeddingResponseTransportFailure) {
        throw new EmbeddingProviderFault("provider_unavailable", true);
      }
      throw new EmbeddingProviderFault("invalid_response", false);
    }
    return parseResponse(payload, request);
  }
}

function validateEndpoint(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new TypeError("embedding endpoint must be an absolute URL");
  }
  if (
    (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0
  ) {
    throw new TypeError(
      "embedding endpoint must be an HTTP(S) URL without credentials",
    );
  }
  if (endpoint.protocol === "http:" && !isLoopbackHost(endpoint.hostname)) {
    throw new TypeError(
      "unencrypted embedding endpoints are limited to the local machine",
    );
  }
  return endpoint.toString();
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  );
}

function validateHeaders(
  headers: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const validated: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.trim().toLowerCase();
    if (
      !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(normalized) ||
      FORBIDDEN_HEADERS.has(normalized) ||
      /[\r\n]/.test(value) ||
      Object.hasOwn(validated, normalized)
    ) {
      throw new TypeError("embedding provider header configuration is invalid");
    }
    validated[normalized] = value;
  }
  return Object.freeze(validated);
}

function mapHttpFailure(status: number): EmbeddingProviderFault {
  if (status === 401 || status === 403) {
    return new EmbeddingProviderFault("authentication_failed", false);
  }
  if (status === 408 || status === 429) {
    return new EmbeddingProviderFault(
      status === 429 ? "rate_limited" : "provider_unavailable",
      true,
    );
  }
  if (status >= 500) {
    return new EmbeddingProviderFault("provider_unavailable", true);
  }
  return new EmbeddingProviderFault("invalid_request", false);
}

function parseResponse(
  payload: unknown,
  request: EmbeddingProviderRequest,
): readonly EmbeddingProviderOutput[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new EmbeddingProviderFault("invalid_response", false);
  }
  if (
    typeof payload.model !== "string" ||
    payload.model !== request.profile.model
  ) {
    throw new EmbeddingProviderFault("invalid_response", false);
  }
  const byIndex = new Map<number, readonly number[]>();
  for (const item of payload.data) {
    if (
      !isRecord(item) ||
      !Number.isSafeInteger(item.index) ||
      !Array.isArray(item.embedding) ||
      item.embedding.some((component) => typeof component !== "number") ||
      byIndex.has(item.index as number)
    ) {
      throw new EmbeddingProviderFault("invalid_response", false);
    }
    byIndex.set(item.index as number, item.embedding as number[]);
  }
  if (byIndex.size !== request.inputs.length) {
    throw new EmbeddingProviderFault("invalid_response", false);
  }
  return request.inputs.map((input, index) => {
    const vector = byIndex.get(index);
    if (
      vector === undefined ||
      !embeddingVectorMatchesProfile(request.profile, vector)
    ) {
      throw new EmbeddingProviderFault("invalid_response", false);
    }
    return { key: input.key, vector };
  });
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) ||
      Number(declaredLength) > MAX_REMOTE_EMBEDDING_RESPONSE_BYTES)
  ) {
    throw new Error("invalid embedding response length");
  }
  if (response.body === null) {
    throw new Error("embedding response body is missing");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      let next;
      try {
        next = await reader.read();
      } catch {
        throw new EmbeddingResponseTransportFailure();
      }
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_REMOTE_EMBEDDING_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("embedding response is too large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

class EmbeddingResponseTransportFailure extends Error {
  constructor() {
    super("embedding response transport failed");
    this.name = "EmbeddingResponseTransportFailure";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function freezeProfile(
  profile: DocumentRetrievalEmbeddingProfile,
): DocumentRetrievalEmbeddingProfile {
  return Object.freeze({
    ...structuredClone(profile),
    execution: Object.freeze({ ...profile.execution }),
    admissionLimit: Object.freeze({ ...profile.admissionLimit }),
  });
}
