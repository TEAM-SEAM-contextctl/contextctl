import {
  resolveContext,
  type ResolveContextOptions,
  type ResolveContextPorts,
} from "../../application/resolve-context.js";
import { EmptyQueryError } from "../../application/errors.js";
import type { ApprovedCard, ApprovedScope } from "../../domain/card-catalog.js";
import { DEFAULT_EVIDENCE_BUDGET } from "../../domain/evidence-assembly.js";
import { EvidenceBudgetInvariantError } from "../../domain/errors.js";

/**
 * The read-only HTTP surface over this domain.
 *
 * ADR 0003 splits delivery in two: a query surface a consumer may call, and an
 * operator control plane that approves, rejects and rolls back. This file is
 * only the first half, and the `/v1/context/` namespace is what keeps the two
 * apart — a future control plane lands under its own prefix rather than beside
 * these routes, so "is this endpoint a mutation" stays answerable from the path
 * alone.
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

const SELECTION_PATH = "/v1/context/selection";
const CARDS_PATH = "/v1/context/cards";

/**
 * Every failure this surface can report.
 *
 * A closed set, and deliberately coarse: a code names what the caller has to do
 * differently, never what went wrong inside. `internal_error` in particular
 * carries no detail at all — see `runResolution`.
 */
type DeliveryErrorCode =
  | "invalid_json"
  | "invalid_query"
  | "empty_query"
  | "invalid_budget"
  | "method_not_allowed"
  | "not_found"
  | "internal_error";

/** What `GET /v1/context/cards` says about one approved Card. */
interface ApprovedCardSummary {
  readonly cardId: string;
  readonly description: string;
  readonly keywords: readonly string[];
  readonly scopeKinds: readonly string[];
}

/**
 * Builds the handler for the query surface.
 *
 * `options` are the defaults every request runs under. A request may narrow the
 * evidence budget but never widen anything else: thresholds decide what a query
 * is allowed to reach, and letting a caller set them over HTTP would turn a
 * selection policy into a request parameter.
 */
export function createHttpQueryHandler(
  ports: ResolveContextPorts,
  options?: ResolveContextOptions,
): DeliveryHttpHandler {
  return async (request: DeliveryHttpRequest): Promise<DeliveryHttpResponse> => {
    const path = stripQueryString(request.path);

    // The path is matched before the method, so a known route reached with the
    // wrong verb answers 405 rather than 404: the two say different things to a
    // caller, and collapsing them would hide a typo'd method behind a missing
    // endpoint.
    if (path === SELECTION_PATH) {
      if (request.method !== "POST") {
        return errorResponse(405, "method_not_allowed");
      }
      return runResolution(ports, options, request.body);
    }

    if (path === CARDS_PATH) {
      if (request.method !== "GET") {
        return errorResponse(405, "method_not_allowed");
      }
      return listCards(ports);
    }

    return errorResponse(404, "not_found");
  };
}

/**
 * Decodes a resolution request, runs the use case, and reduces every failure to
 * a code.
 *
 * The catch is total on purpose. `EmptyQueryError` and
 * `EvidenceBudgetInvariantError` are the two failures this surface can explain
 * to a caller, and anything else is a fault the caller cannot act on: it
 * becomes `internal_error` with no message attached, because an exception
 * raised deep in an adapter names hosts, paths and credentials, and a delivery
 * response is exactly the wrong place for them. `resolve-context.ts` keeps the
 * same rule for retrieval faults: a Scope that could not be read becomes a
 * `failed` item carrying a code, never a message.
 */
async function runResolution(
  ports: ResolveContextPorts,
  options: ResolveContextOptions | undefined,
  body: string,
): Promise<DeliveryHttpResponse> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return errorResponse(400, "invalid_json");
  }

  // A body that is valid JSON but not an object — a bare string, a number, an
  // array — carries no `query`, which is the same defect as omitting it.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return errorResponse(400, "invalid_query");
  }

  const payload = parsed as Record<string, unknown>;
  const query = payload["query"];
  if (typeof query !== "string") {
    return errorResponse(400, "invalid_query");
  }

  const requestedCharacters = payload["maxEvidenceCharacters"];
  if (requestedCharacters !== undefined && typeof requestedCharacters !== "number") {
    // Rejected here rather than forwarded, so a non-numeric ceiling is refused
    // by the same code as a numerically impossible one instead of reaching the
    // domain invariant as a lie about its own type.
    return errorResponse(400, "invalid_budget");
  }

  const effectiveOptions = withBudgetOverride(options, requestedCharacters);

  try {
    // Serialized whole and unexamined. The `ContextResolution` type is what
    // decides what a consumer may see — `ManagedDocumentGuide` omits the
    // connector id and access handle on purpose — so re-picking fields here
    // would only create a second place for that decision to drift.
    const resolution = await resolveContext(ports, query, effectiveOptions);
    return { status: 200, body: JSON.stringify(resolution) };
  } catch (cause: unknown) {
    if (cause instanceof EmptyQueryError) {
      return errorResponse(400, "empty_query");
    }
    if (cause instanceof EvidenceBudgetInvariantError) {
      return errorResponse(400, "invalid_budget");
    }
    return errorResponse(500, "internal_error");
  }
}

/**
 * Applies a caller's character ceiling on top of the configured budget.
 *
 * Only `maxTotalCharacters` moves: the chunk ceiling exists to cap how many
 * separate citations an answer carries, which is an assembly decision rather
 * than a caller's, and the base budget is the configured one rather than a
 * fresh default so an override does not silently discard a `maxChunks` the
 * daemon set. Whether the resulting pair is usable at all is not re-decided
 * here — `assembleDocumentEvidence` owns that invariant, and restating it would
 * let the two drift apart.
 */
function withBudgetOverride(
  options: ResolveContextOptions | undefined,
  requestedCharacters: number | undefined,
): ResolveContextOptions {
  if (requestedCharacters === undefined) {
    return options ?? {};
  }

  return {
    ...(options ?? {}),
    budget: {
      ...(options?.budget ?? DEFAULT_EVIDENCE_BUDGET),
      maxTotalCharacters: requestedCharacters,
    },
  };
}

/**
 * Lists the approved Cards a query could select over.
 *
 * A summary rather than the Card itself: `documentIndex` carries a connector id
 * and an access handle, and a catalog listing is a discovery aid, not a reason
 * to publish retrieval coordinates to anyone who asks. Scope kinds are named
 * because they tell a caller what shape of answer a Card can produce.
 */
async function listCards(
  ports: ResolveContextPorts,
): Promise<DeliveryHttpResponse> {
  try {
    const cards = await ports.catalog.listApprovedCards();
    return {
      status: 200,
      body: JSON.stringify({ cards: cards.map(summarizeCard) }),
    };
  } catch {
    return errorResponse(500, "internal_error");
  }
}

function summarizeCard(card: ApprovedCard): ApprovedCardSummary {
  return {
    cardId: card.cardId,
    description: card.meaning.description,
    keywords: [...card.meaning.keywords],
    scopeKinds: distinctScopeKinds(card.scopes),
  };
}

/**
 * Each Scope kind once, in the order the Card declares it.
 *
 * `Set` iterates in insertion order, so the result is a function of the Card
 * alone and never of a locale or a sort.
 */
function distinctScopeKinds(scopes: readonly ApprovedScope[]): readonly string[] {
  return [...new Set(scopes.map((scope) => scope.kind))];
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

function errorResponse(
  status: number,
  code: DeliveryErrorCode,
): DeliveryHttpResponse {
  return { status, body: JSON.stringify({ error: { code } }) };
}
