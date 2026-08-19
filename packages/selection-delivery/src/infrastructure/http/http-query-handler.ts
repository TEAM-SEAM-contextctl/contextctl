import type {
  ResolveContextApplication,
  ResolveContextRequest,
} from "../../application/context-application.js";
import {
  resolveContextError,
  resolveContextErrorStatus,
  toResolveContextErrorCode,
  type ResolveContextErrorCode,
} from "../../application/errors.js";

/**
 * The read-only HTTP surface over this domain.
 *
 * ADR 0003 splits delivery in two: a query surface a consumer may call, and an
 * operator control plane that approves, rejects and rolls back. This file is
 * only the first half, and the `/v1/context/` namespace is what keeps the two
 * apart — a future control plane lands under its own prefix rather than beside
 * this route, so "is this endpoint a mutation" stays answerable from the path
 * alone.
 *
 * One route, and that is the whole surface. A catalog listing route used to sit
 * beside it and is gone: a caller that can enumerate the approved Cards can map
 * the catalog without ever asking a question, and it answered nothing a
 * resolution does not answer already. The resolution route was renamed after
 * the selection in the same change, because what a caller receives is the
 * resolved context and not the selection — the selection is one summary block
 * inside it now.
 *
 * ADR 0005 rules out a framework, so the request is reduced to the three fields
 * a route actually decides on and the handler is an ordinary async function.
 * Nothing here touches a socket: `node-http-server.ts` owns that translation,
 * and the daemon owns `listen`.
 */

/** One request, reduced to what routing and decoding need. */
export interface DeliveryHttpRequest {
  readonly method: string;
  /** The request target as received, query string included. */
  readonly path: string;
  /** The decoded request body; empty for a request that carries none. */
  readonly body: string;
}

/** One response. `body` is always a JSON document, including for errors. */
export interface DeliveryHttpResponse {
  readonly status: number;
  readonly body: string;
}

export type DeliveryHttpHandler = (
  request: DeliveryHttpRequest,
) => Promise<DeliveryHttpResponse>;

/** The one route this surface serves. */
export const RESOLVE_PATH = "/v1/context/resolve";

/**
 * The two failures that are about HTTP rather than about resolution.
 *
 * `ResolveContextErrorCode` names what a caller has to do differently about the
 * question it asked; neither of these is that. A wrong verb and an unknown path
 * are answered before a request body is read at all, so folding them into the
 * resolution vocabulary would hand a caller a code implying its query was
 * rejected when no query was ever parsed.
 */
type RoutingErrorCode = "method_not_allowed" | "not_found";

/**
 * Builds the handler for the query surface.
 *
 * It takes the application and nothing else. A budget default used to be handed
 * in here as well, which meant the surface knew the configured ceiling and had
 * to decide, on its own, what a caller's `maxContextCharacters` did to it — a
 * decision the MCP surface then made a second time, from its own copy. The rule
 * lives in `narrowContextBudget` now, where the configured budget actually is,
 * and both surfaces do the same thing: forward the number a caller sent.
 */
export function createHttpQueryHandler(
  application: ResolveContextApplication,
): DeliveryHttpHandler {
  return async (request: DeliveryHttpRequest): Promise<DeliveryHttpResponse> => {
    const path = stripQueryString(request.path);

    // The path is matched before the method, so a known route reached with the
    // wrong verb answers 405 rather than 404: the two say different things to a
    // caller, and collapsing them would hide a typo'd method behind a missing
    // endpoint.
    if (path === RESOLVE_PATH) {
      if (request.method !== "POST") {
        return routingError(405, "method_not_allowed");
      }
      return runResolution(application, request.body);
    }

    return routingError(404, "not_found");
  };
}

/**
 * Decodes a resolution request, runs the use case, and reduces every failure to
 * a `ResolveContextError`.
 *
 * The catch is total on purpose, and every branch of it lands on a code from one
 * closed vocabulary carrying the `retriable` that code always has. A caller
 * reading `retriable` therefore never has to know which layer failed in order to
 * decide whether sending the same request again could work.
 *
 * No exception message is ever forwarded. `unexpected_failure` in particular
 * carries no detail at all, because an exception raised deep in an adapter names
 * hosts, paths and credentials, and a delivery response is exactly the wrong
 * place for them. Item-level failures keep the same rule one level down: a Scope
 * that could not be read becomes a `failed` fulfillment carrying a code, never a
 * message.
 */
async function runResolution(
  application: ResolveContextApplication,
  body: string,
): Promise<DeliveryHttpResponse> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return errorResponse("invalid_request");
  }

  // A body that is valid JSON but not an object — a bare string, a number, an
  // array — carries no `query`, which is the same defect as omitting it.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return errorResponse("invalid_request");
  }

  const payload = parsed as Record<string, unknown>;
  const query = payload["query"];
  if (typeof query !== "string") {
    return errorResponse("invalid_request");
  }

  const requestedCharacters = payload["maxContextCharacters"];
  if (
    requestedCharacters !== undefined &&
    typeof requestedCharacters !== "number"
  ) {
    // Rejected here rather than forwarded, so a non-numeric ceiling is refused
    // by the same code as a numerically impossible one instead of reaching the
    // budget rule as a lie about its own type.
    return errorResponse("invalid_context_budget");
  }

  const request = withRequestedCeiling(query, requestedCharacters);

  try {
    // Serialized whole and unexamined. The `ContextResolution` type is what
    // decides what a consumer may see — `ManagedDocumentGuide` omits the
    // connector id and access handle on purpose, and `RetrievedDocumentChunk`
    // omits `rank` and `score` — so re-picking fields here would only create a
    // second place for that decision to drift.
    const resolution = await application.resolveContext(request);
    return { status: 200, body: JSON.stringify(resolution) };
  } catch (cause: unknown) {
    return errorResponse(toResolveContextErrorCode(cause));
  }
}

/**
 * Built by assignment rather than as one literal: `exactOptionalPropertyTypes`
 * makes `{ maxContextCharacters: undefined }` different from an absent key, and
 * an absent key is what selects the deployment's configured ceiling.
 *
 * The value is forwarded rather than applied. `narrowContextBudget` owns the
 * `min(configured, requested)` rule and the refusals around it, and it runs
 * inside the application where the configured budget actually lives — restating
 * either here would let the surface and the use case disagree about what a
 * caller is allowed to ask for.
 */
function withRequestedCeiling(
  query: string,
  requestedCharacters: number | undefined,
): ResolveContextRequest {
  return requestedCharacters === undefined
    ? { query }
    : { query, maxContextCharacters: requestedCharacters };
}

/**
 * The request target without its query string.
 *
 * Routing is on the path only; a query string is accepted and ignored rather
 * than treated as a different route, so a caller appending a cache-buster does
 * not receive a 404.
 */
function stripQueryString(path: string): string {
  const separator = path.indexOf("?");
  return separator === -1 ? path : path.slice(0, separator);
}

/** One resolution failure, with the status and `retriable` its code fixes. */
function errorResponse(code: ResolveContextErrorCode): DeliveryHttpResponse {
  return {
    status: resolveContextErrorStatus(code),
    body: JSON.stringify({ error: resolveContextError(code) }),
  };
}

/**
 * A routing failure, which states `retriable` for the same reason a resolution
 * error does: a client branching on the field must not have to know which of the
 * two vocabularies answered it.
 */
function routingError(
  status: number,
  code: RoutingErrorCode,
): DeliveryHttpResponse {
  return {
    status,
    body: JSON.stringify({ error: { code, retriable: false } }),
  };
}
