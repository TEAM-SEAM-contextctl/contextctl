import {
  QdrantVectorIndexAdapter,
  type QdrantVectorIndexAdapterOptions,
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

const QDRANT_URL_VARIABLE = "CONTEXTCTL_QDRANT_URL";
const QDRANT_API_KEY_VARIABLE = "CONTEXTCTL_QDRANT_API_KEY";
const QDRANT_TIMEOUT_VARIABLE = "CONTEXTCTL_QDRANT_TIMEOUT_MS";

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
  const url = readNonEmpty(environment, QDRANT_URL_VARIABLE);
  if (url === undefined) {
    throw new VectorBackendConfigurationError();
  }

  const apiKey = readNonEmpty(environment, QDRANT_API_KEY_VARIABLE);
  const timeoutMs = readTimeoutMs(environment);
  const options: QdrantVectorIndexAdapterOptions = {
    url,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };

  // Construction validates transport safety before the URL can be reported as
  // accepted. It does not dial Qdrant; operation and CI integration tests own
  // reachability.
  const vectorIndex = new QdrantVectorIndexAdapter(options);
  return { kind: "qdrant", vectorIndex, endpoint: diagnosticEndpoint(url) };
}

function diagnosticEndpoint(value: string): string {
  const url = new URL(value);
  return `${url.protocol}//${url.host}${url.pathname}`;
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
