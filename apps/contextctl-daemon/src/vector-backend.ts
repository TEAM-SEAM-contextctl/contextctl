import {
  QdrantVectorIndexAdapter,
  type VectorIndexPort,
} from "@contextctl/ingestion-indexing";

import { readNonEmpty } from "./cli/paths.js";

/** The durable vector backend an operating daemon is bound to. */
export interface VectorBackend {
  readonly kind: "qdrant";
  readonly vectorIndex: VectorIndexPort;
  /** Safe diagnostic form: never includes credentials, query or fragment. */
  readonly endpoint: string;
}

/** Connection values shared by the live index and its snapshot archive. */
export interface QdrantConnectionOptions {
  readonly url: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
}

export type QdrantReadinessFailureCode =
  | "timeout"
  | "connection_refused"
  | "unauthorized"
  | "invalid_response"
  | "unknown";

export type QdrantReadiness =
  | {
      readonly status: "reachable";
      readonly endpoint: string;
      readonly elapsedMs: number;
    }
  | {
      readonly status: "unreachable";
      readonly endpoint: string;
      readonly code: QdrantReadinessFailureCode;
    };

export interface QdrantReadinessProbeOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

const QDRANT_URL_VARIABLE = "CONTEXTCTL_QDRANT_URL";
const QDRANT_API_KEY_VARIABLE = "CONTEXTCTL_QDRANT_API_KEY";
const QDRANT_TIMEOUT_VARIABLE = "CONTEXTCTL_QDRANT_TIMEOUT_MS";
export const QDRANT_STATUS_TIMEOUT_MS = 1_500;
const MAX_READINESS_RESPONSE_BYTES = 1024 * 1024;

/** A required production dependency was omitted rather than misconfigured. */
export class VectorBackendConfigurationError extends Error {
  readonly code = "qdrant_endpoint_required";

  constructor() {
    super(
      `[qdrant_endpoint_required] ${QDRANT_URL_VARIABLE}이 필요합니다. ingest, query, serve를 시작하기 전에 영속 Qdrant 인덱스를 설정하십시오.`,
    );
    this.name = "VectorBackendConfigurationError";
  }
}

/**
 * Binds the vector index used by an operating composition.
 *
 * There is no in-memory fallback. Tests that need a volatile adapter inject it
 * directly into their runtime; an absent or malformed production setting fails
 * before any domain state is opened.
 */
export function resolveVectorBackend(
  environment: Readonly<Partial<Record<string, string>>>,
): VectorBackend {
  const options = readQdrantConnectionOptions(environment);
  const vectorIndex = new QdrantVectorIndexAdapter(options);
  return {
    kind: "qdrant",
    vectorIndex,
    endpoint: diagnosticEndpoint(options.url),
  };
}

/**
 * Proves that the configured Qdrant service can answer an authenticated,
 * read-only request within a short status-command deadline.
 *
 * This is deliberately not a collection-specific check. Collection
 * compatibility belongs to daemon state readiness; this probe answers the
 * earlier question that both resolve and ingestion share: is their durable
 * vector service reachable at all? No response body or credential is returned
 * to the caller.
 */
export async function probeQdrantReadiness(
  environment: Readonly<Partial<Record<string, string>>>,
  probe: QdrantReadinessProbeOptions = {},
): Promise<QdrantReadiness> {
  // Constructing the production adapter applies the exact endpoint safety and
  // timeout validation used by ingest/query/serve. A status-only parser beside
  // it would eventually accept a configuration the product rejects.
  const backend = resolveVectorBackend(environment);
  const options = readQdrantConnectionOptions(environment);
  const fetchImplementation = probe.fetch ?? globalThis.fetch;
  const now = probe.now ?? (() => performance.now());
  const requestedTimeout = probe.timeoutMs ?? QDRANT_STATUS_TIMEOUT_MS;
  if (!Number.isSafeInteger(requestedTimeout) || requestedTimeout <= 0) {
    throw new TypeError("Qdrant readiness timeout must be a positive integer");
  }
  const timeoutMs = Math.min(
    requestedTimeout,
    options.timeoutMs ?? requestedTimeout,
  );
  const endpoint = readinessEndpoint(options.url);
  const startedAt = now();

  try {
    const response = await fetchImplementation(endpoint, {
      method: "GET",
      ...(options.apiKey === undefined
        ? {}
        : { headers: { "api-key": options.apiKey } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      return {
        status: "unreachable",
        endpoint: backend.endpoint,
        code: "unauthorized",
      };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return {
        status: "unreachable",
        endpoint: backend.endpoint,
        code: "invalid_response",
      };
    }
    const body = await readBoundedJson(response, MAX_READINESS_RESPONSE_BYTES);
    if (!isQdrantCollectionsResponse(body)) {
      return {
        status: "unreachable",
        endpoint: backend.endpoint,
        code: "invalid_response",
      };
    }
    return {
      status: "reachable",
      endpoint: backend.endpoint,
      elapsedMs: Math.max(0, now() - startedAt),
    };
  } catch (error) {
    return {
      status: "unreachable",
      endpoint: backend.endpoint,
      code: classifyReadinessFailure(error),
    };
  }
}

/**
 * Reads Qdrant wiring once for every daemon-owned adapter.
 *
 * Snapshot backup must address the same service as the vector index. Keeping
 * a second environment parser beside it would eventually let one adapter use
 * a different timeout, credential, or endpoint while both claimed to be the
 * configured Qdrant backend.
 */
export function readQdrantConnectionOptions(
  environment: Readonly<Partial<Record<string, string>>>,
): QdrantConnectionOptions {
  const url = readNonEmpty(environment, QDRANT_URL_VARIABLE);
  if (url === undefined) {
    throw new VectorBackendConfigurationError();
  }

  const apiKey = readNonEmpty(environment, QDRANT_API_KEY_VARIABLE);
  const timeoutMs = readTimeoutMs(environment);
  const options: QdrantConnectionOptions = {
    url,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };

  return options;
}

function diagnosticEndpoint(value: string): string {
  const url = new URL(value);
  return `${url.protocol}//${url.host}${url.pathname}`;
}

function readinessEndpoint(value: string): URL {
  const base = new URL(value);
  base.username = "";
  base.password = "";
  base.search = "";
  base.hash = "";
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  return new URL("collections", base);
}

async function readBoundedJson(
  response: Response,
  limit: number,
): Promise<unknown> {
  if (response.body === null) throw new TypeError("Qdrant response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) {
        throw new RangeError("Qdrant readiness response is too large");
      }
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function isQdrantCollectionsResponse(value: unknown): boolean {
  if (!isRecord(value) || value.status !== "ok" || !isRecord(value.result)) {
    return false;
  }
  return Array.isArray(value.result.collections);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function classifyReadinessFailure(error: unknown): QdrantReadinessFailureCode {
  if (isNamedError(error, "TimeoutError") || isNamedError(error, "AbortError")) {
    return "timeout";
  }
  const code = nestedErrorCode(error);
  if (code === "ECONNREFUSED") return "connection_refused";
  return error instanceof SyntaxError || error instanceof RangeError
    ? "invalid_response"
    : "unknown";
}

function isNamedError(value: unknown, name: string): boolean {
  return isRecord(value) && value.name === name;
}

function nestedErrorCode(value: unknown): unknown {
  let current = value;
  const seen = new Set<unknown>();
  while (isRecord(current) && !seen.has(current)) {
    seen.add(current);
    if (typeof current.code === "string") return current.code;
    current = current.cause;
  }
  return undefined;
}

function readTimeoutMs(
  environment: Readonly<Partial<Record<string, string>>>,
): number | undefined {
  const raw = readNonEmpty(environment, QDRANT_TIMEOUT_VARIABLE);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(
      `${QDRANT_TIMEOUT_VARIABLE} must be a positive integer number of milliseconds`,
    );
  }
  return parsed;
}
