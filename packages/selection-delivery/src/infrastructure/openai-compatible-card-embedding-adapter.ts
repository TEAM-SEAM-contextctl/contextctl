import {
  assertValidCardSelectionProfile,
  cardSelectionProfilesMatch,
  cardSelectionVectorMatchesProfile,
  isCardSelectionEmbeddingProfile,
  type CardSelectionEmbeddingProfile,
} from "../domain/card-selection-profile.js";
import {
  CardEmbeddingFault,
  type CardEmbeddingOutput,
  type CardEmbeddingPort,
  type CardEmbeddingRequest,
} from "../ports/card-embedding.js";

/**
 * A `CardEmbeddingPort` over an OpenAI-compatible `/embeddings` endpoint.
 *
 * A translation of Indexing's `OpenAiCompatibleEmbeddingAdapter` into this
 * package's types, and deliberately not an import of it: the boundary test
 * forbids one domain package from depending on another, and the two ports
 * differ in exactly the things an adapter carries — the profile it is bound to,
 * the fault vocabulary it speaks, and whether a request may be unabortable.
 * What is the same is every rule about talking to a provider, and those rules
 * are restated here line for line so that a deployment that binds both
 * families to one endpoint gets one behaviour.
 *
 * The endpoint is the whole URL, path included. The adapter appends nothing:
 * which path a provider serves embeddings under is the provider's business,
 * and an adapter that assumed `/v1/embeddings` would turn a host that already
 * says so into a doubled path and a 404 that names neither.
 *
 * What leaves the process is the model name and the selection texts, nothing
 * else. What is accepted back is checked against the profile before it is
 * returned: the provider has to echo the model it was asked for, answer every
 * input exactly once, and return vectors of the declared width at unit length.
 * Anything else is `invalid_response`, and nothing of the provider's own text
 * — a body, a transport error, a header — reaches a fault message, because a
 * provider's error detail may quote the request it was answering.
 */
export interface OpenAiCompatibleCardEmbeddingAdapterOptions {
  /** The full request URL, path included. HTTPS, or HTTP on the local machine only. */
  readonly endpoint: string;
  /** The exact remote family this binding serves. */
  readonly profile: CardSelectionEmbeddingProfile;
  /** Sent on every request, typically an `Authorization` header. Never logged. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch?: typeof globalThis.fetch;
  /** The most inputs one physical provider request may carry. Defaults to 64. */
  readonly maxBatchSize?: number;
}

const FORBIDDEN_HEADERS = new Set([
  "connection",
  "content-length",
  "content-type",
  "host",
  "transfer-encoding",
]);
const DEFAULT_MAX_BATCH_SIZE = 64;
const MAX_CONFIGURED_BATCH_SIZE = 2_048;
const MAX_LOGICAL_INPUTS = 10_000;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export class OpenAiCompatibleCardEmbeddingAdapter implements CardEmbeddingPort {
  readonly providerKind = "remote" as const;
  readonly profile: CardSelectionEmbeddingProfile;

  readonly #endpoint: string;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #fetch: typeof globalThis.fetch;
  readonly #maxBatchSize: number;
  readonly #model: string;

  constructor(options: OpenAiCompatibleCardEmbeddingAdapterOptions) {
    assertValidCardSelectionProfile(options.profile);
    if (
      !isCardSelectionEmbeddingProfile(options.profile) ||
      options.profile.execution.kind !== "remote"
    ) {
      throw new TypeError("remote Card embedding adapter requires a remote profile");
    }
    this.#model = options.profile.execution.model;
    this.profile = freezeProfile(options.profile);
    this.#endpoint = validateEndpoint(options.endpoint);
    this.#headers = validateHeaders(options.headers ?? {});
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (
      options.maxBatchSize !== undefined &&
      (!Number.isSafeInteger(options.maxBatchSize) ||
        options.maxBatchSize <= 0 ||
        options.maxBatchSize > MAX_CONFIGURED_BATCH_SIZE)
    ) {
      throw new TypeError("remote Card embedding batch size is invalid");
    }
    this.#maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
  }

  async embed(
    request: CardEmbeddingRequest,
  ): Promise<readonly CardEmbeddingOutput[]> {
    request.signal?.throwIfAborted();
    if (!cardSelectionProfilesMatch(request.profile, this.profile)) {
      // The caller asked for a vector space this binding does not serve.
      // Answering in the space it does serve would put two families' vectors
      // in one index.
      throw new CardEmbeddingFault("invalid_request", false);
    }
    if (request.inputs.length === 0) {
      return [];
    }
    if (
      request.inputs.length > MAX_LOGICAL_INPUTS ||
      new Set(request.inputs.map((input) => input.key)).size !==
        request.inputs.length ||
      request.inputs.some(
        (input) => input.key.trim() === "" || input.text.trim() === "",
      )
    ) {
      // Refused before any byte leaves: a duplicated key could not be joined
      // back to its output, and an empty text has no vector to ask for.
      throw new CardEmbeddingFault("invalid_request", false);
    }
    const outputs: CardEmbeddingOutput[] = [];
    for (let offset = 0; offset < request.inputs.length; offset += this.#maxBatchSize) {
      request.signal?.throwIfAborted();
      const inputs = request.inputs.slice(offset, offset + this.#maxBatchSize);
      outputs.push(...(await this.#embedBatch(request, inputs)));
    }
    return outputs;
  }

  async #embedBatch(
    request: CardEmbeddingRequest,
    inputs: CardEmbeddingRequest["inputs"],
  ): Promise<readonly CardEmbeddingOutput[]> {
    const body = JSON.stringify({
      model: this.#model,
      input: inputs.map((input) => input.text),
    });
    if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) {
      throw new CardEmbeddingFault("input_limit_exceeded", false);
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
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } catch (error) {
      if (request.signal?.aborted) {
        throw error;
      }
      throw new CardEmbeddingFault("provider_unavailable", true);
    }

    if (!response.ok) {
      throw mapHttpFailure(response.status);
    }

    let payload: unknown;
    try {
      payload = await readBoundedJson(response);
    } catch (error) {
      if (request.signal?.aborted) {
        throw request.signal.reason;
      }
      if (error instanceof ResponseTransportFailure) {
        throw new CardEmbeddingFault("provider_unavailable", true);
      }
      throw new CardEmbeddingFault("invalid_response", false);
    }
    return parseResponse(payload, { ...request, inputs });
  }
}

function validateEndpoint(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new TypeError("Card embedding endpoint must be an absolute URL");
  }
  if (
    (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0
  ) {
    throw new TypeError(
      "Card embedding endpoint must be an HTTP(S) URL without credentials",
    );
  }
  if (endpoint.protocol === "http:" && !isLoopbackHost(endpoint.hostname)) {
    throw new TypeError(
      "unencrypted Card embedding endpoints are limited to the local machine",
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
      throw new TypeError("Card embedding provider header configuration is invalid");
    }
    validated[normalized] = value;
  }
  return Object.freeze(validated);
}

/**
 * Which fault an HTTP status is, and whether asking again could help.
 *
 * 401 and 403 are a credential that will keep being wrong; 429 is a quota that
 * will clear; 408 and every 5xx are the provider's own trouble; anything else
 * below 500 is a request the provider would refuse again as it stands.
 */
function mapHttpFailure(status: number): CardEmbeddingFault {
  if (status === 401 || status === 403) {
    return new CardEmbeddingFault("authentication_failed", false);
  }
  if (status === 429) {
    return new CardEmbeddingFault("rate_limited", true);
  }
  if (status === 408 || status >= 500) {
    return new CardEmbeddingFault("provider_unavailable", true);
  }
  return new CardEmbeddingFault("invalid_request", false);
}

function parseResponse(
  payload: unknown,
  request: CardEmbeddingRequest,
): readonly CardEmbeddingOutput[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new CardEmbeddingFault("invalid_response", false);
  }
  if (typeof payload.model !== "string" || payload.model !== request.profile.model) {
    // The echo is the one place a floating alias would show: a provider that
    // quietly serves a newer model under the old name answers with a name the
    // profile did not pin, and its vectors belong to another family.
    throw new CardEmbeddingFault("invalid_response", false);
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
      throw new CardEmbeddingFault("invalid_response", false);
    }
    byIndex.set(item.index as number, item.embedding as number[]);
  }
  if (byIndex.size !== request.inputs.length) {
    throw new CardEmbeddingFault("invalid_response", false);
  }
  // Joined by the provider's index and returned under the caller's key, so a
  // provider that reorders its answer cannot attach one Card's vector to
  // another Card's record.
  return request.inputs.map((input, index) => {
    const vector = byIndex.get(index);
    if (
      vector === undefined ||
      !cardSelectionVectorMatchesProfile(request.profile, vector)
    ) {
      throw new CardEmbeddingFault("invalid_response", false);
    }
    return { key: input.key, vector };
  });
}

/**
 * Reads a response body under a ceiling, rejecting what the header promises
 * before reading and what the stream delivers while reading.
 */
async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_RESPONSE_BYTES)
  ) {
    throw new Error("invalid Card embedding response length");
  }
  if (response.body === null) {
    throw new Error("Card embedding response body is missing");
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
        throw new ResponseTransportFailure();
      }
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Card embedding response is too large");
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

/** A stream that broke mid-body: the provider's trouble, not a malformed answer. */
class ResponseTransportFailure extends Error {
  constructor() {
    super("Card embedding response transport failed");
    this.name = "ResponseTransportFailure";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function freezeProfile(
  profile: CardSelectionEmbeddingProfile,
): CardSelectionEmbeddingProfile {
  return Object.freeze({
    ...structuredClone(profile),
    execution: Object.freeze({ ...profile.execution }),
    admissionLimits: Object.freeze({ ...profile.admissionLimits }),
  });
}
