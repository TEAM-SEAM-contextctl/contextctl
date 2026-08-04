/**
 * The subset of JSON-RPC 2.0 the MCP surface needs, parsed and formatted by
 * hand.
 *
 * ADR 0005 keeps this domain free of npm dependencies, so the wire format is
 * maintained here rather than delegated to an SDK. Nothing in this file knows
 * about MCP: it answers "is this a well-formed request, and if not what do we
 * reply?" and leaves every method name to the server above it.
 */

/**
 * A request identifier as it travels on the wire.
 *
 * `null` is a legal id in JSON-RPC 2.0 and is what an error response carries
 * when the request was too malformed to have one. It is deliberately distinct
 * from `undefined`, which means the id field was absent — that is a
 * notification, and a notification is never answered.
 */
export type JsonRpcId = string | number | null;

/** A well-formed call. `id === undefined` marks it as a notification. */
export interface JsonRpcRequest {
  readonly id: JsonRpcId | undefined;
  readonly method: string;
  readonly params: unknown;
}

/**
 * What one raw message turned into.
 *
 * A rejected message carries the response text rather than an error object,
 * because the id needed to address that response is only known here — the
 * caller that failed to parse the message cannot reconstruct it.
 */
export type JsonRpcParseResult =
  | { readonly kind: "request"; readonly request: JsonRpcRequest }
  | { readonly kind: "invalid"; readonly response: string | undefined };

export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;

const JSON_RPC_VERSION = "2.0";

/**
 * Parses one raw message into a request, or into the response that rejects it.
 *
 * Envelope validation stops at the three fields the transport owns —
 * `jsonrpc`, `method`, `id`. `params` is passed through untouched, because what
 * shape it should have depends on the method, and that is the server's
 * question, not this file's.
 */
export function parseJsonRpcMessage(raw: string): JsonRpcParseResult {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    // The id is unknowable when the text is not JSON at all, so the spec's
    // `null` stands in for it.
    return {
      kind: "invalid",
      response: formatJsonRpcError(
        null,
        JSON_RPC_PARSE_ERROR,
        "Message is not valid JSON.",
      ),
    };
  }

  if (!isRecord(message)) {
    return {
      kind: "invalid",
      response: formatJsonRpcError(
        null,
        JSON_RPC_INVALID_REQUEST,
        "Message must be a JSON object.",
      ),
    };
  }

  // Read before the version check: an otherwise invalid request should still be
  // answered on the id it was sent with, when it sent a usable one.
  const id = readId(message);

  if (message["jsonrpc"] !== JSON_RPC_VERSION) {
    return {
      kind: "invalid",
      response: formatJsonRpcError(
        id ?? null,
        JSON_RPC_INVALID_REQUEST,
        `Field "jsonrpc" must be "${JSON_RPC_VERSION}".`,
      ),
    };
  }

  const method = message["method"];
  if (typeof method !== "string") {
    return {
      kind: "invalid",
      response: formatJsonRpcError(
        id ?? null,
        JSON_RPC_INVALID_REQUEST,
        'Field "method" must be a string.',
      ),
    };
  }

  return {
    kind: "request",
    request: { id, method, params: message["params"] },
  };
}

export function formatJsonRpcResult(id: JsonRpcId, result: unknown): string {
  return JSON.stringify({ jsonrpc: JSON_RPC_VERSION, id, result });
}

export function formatJsonRpcError(
  id: JsonRpcId,
  code: number,
  message: string,
): string {
  return JSON.stringify({
    jsonrpc: JSON_RPC_VERSION,
    id,
    error: { code, message },
  });
}

/**
 * The id as sent, or `undefined` when the field is absent.
 *
 * An id of an unusable type — an object, say — is reported as `null` rather
 * than as a notification: the sender expects an answer, and answering on the
 * spec's placeholder id is closer to that expectation than staying silent.
 */
function readId(message: Readonly<Record<string, unknown>>): JsonRpcId | undefined {
  if (!Object.hasOwn(message, "id")) {
    return undefined;
  }

  const id = message["id"];
  if (typeof id === "string" || typeof id === "number" || id === null) {
    return id;
  }
  return null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
