import { embeddingVectorMatchesProfile } from "../domain/embedding-profile.js";
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

export interface OpenAiCompatibleEmbeddingAdapterOptions {
  readonly endpoint: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch?: typeof globalThis.fetch;
}

/** Configured adapter for OpenAI-compatible `/embeddings` endpoints. */
export class OpenAiCompatibleEmbeddingAdapter implements EmbeddingPort {
  readonly providerKind = "remote" as const;

  readonly #endpoint: string;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: OpenAiCompatibleEmbeddingAdapterOptions) {
    this.#endpoint = validateEndpoint(options.endpoint);
    this.#headers = validateHeaders(options.headers ?? {});
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async embed(
    request: EmbeddingProviderRequest,
  ): Promise<readonly EmbeddingProviderOutput[]> {
    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: {
          ...this.#headers,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: request.profile.model,
          input: request.inputs.map((input) => input.text),
        }),
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
      payload = await response.json();
    } catch {
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
      /[\r\n]/.test(value)
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
