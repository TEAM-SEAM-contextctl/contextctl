import {
  CanonicalDigestInvariantError,
  CardCandidateIndexInvariantError,
  CardCatalogInvariantError,
  CardSelectionInputLimitError,
  CardSelectionProfileInvariantError,
  ContextBudgetInvariantError,
  ManagedResolutionInvariantError,
  PolicyContextInvariantError,
  SelectionCandidateInvariantError,
  SelectionModeInvariantError,
  SelectionPlanInvariantError,
  SelectionScopeInvariantError,
  SelectionThresholdsInvariantError,
} from "../domain/errors.js";
import {
  SELECTION_PLANNING_POLICY_VERSION,
  type PlanningLimitViolation,
} from "../domain/selection-plan.js";

/**
 * The request-level failure channel.
 *
 * Deliberately separate from `ManagedResolutionFailure`, which reports one
 * granted coordinate that could not be read while the rest of the answer still
 * stands. A `ResolveContextError` means there is no answer at all: the query
 * could not be planned, or the whole attempt ran out of time. The two never mix
 * — an item-level failure travels inside `fulfillment`, and a request-level one
 * replaces the payload entirely.
 */
export type ResolveContextErrorCode =
  | "invalid_request"
  | "empty_query"
  | "query_input_limit_exceeded"
  | "invalid_context_budget"
  | "overloaded"
  | "selection_catalog_unavailable"
  | "selection_catalog_invalid"
  | "selection_embedding_unavailable"
  | "selection_plan_limit_exceeded"
  | "selection_invariant_violation"
  | "deadline_exceeded"
  | "unexpected_failure";

/** One request-level failure, as a consumer receives it. */
export interface ResolveContextError {
  readonly code: ResolveContextErrorCode;
  readonly retriable: boolean;
}

/**
 * What each code means to a caller: whether the same request may be sent again,
 * and the HTTP status that says so to a client that only reads the status line.
 *
 * One table rather than two switch statements, and it is total over the code
 * union by type: a code added without a row breaks the build here instead of
 * reaching a surface that has no status for it. `retriable` is a property of the
 * code and not of the moment — an `overloaded` is always worth retrying and an
 * `empty_query` never is — so it is stated once here rather than decided by each
 * throw site, where two sites could disagree about one code.
 */
export const RESOLVE_CONTEXT_ERROR_TABLE: Readonly<
  Record<
    ResolveContextErrorCode,
    { readonly status: number; readonly retriable: boolean }
  >
> = {
  invalid_request: { status: 400, retriable: false },
  empty_query: { status: 400, retriable: false },
  query_input_limit_exceeded: { status: 400, retriable: false },
  invalid_context_budget: { status: 400, retriable: false },
  selection_plan_limit_exceeded: { status: 422, retriable: false },
  overloaded: { status: 429, retriable: true },
  selection_catalog_unavailable: { status: 503, retriable: true },
  selection_embedding_unavailable: { status: 503, retriable: true },
  selection_catalog_invalid: { status: 500, retriable: false },
  selection_invariant_violation: { status: 500, retriable: false },
  unexpected_failure: { status: 500, retriable: false },
  deadline_exceeded: { status: 504, retriable: true },
};

/** The record a surface serializes for `code`, with `retriable` filled in. */
export function resolveContextError(
  code: ResolveContextErrorCode,
): ResolveContextError {
  return { code, retriable: RESOLVE_CONTEXT_ERROR_TABLE[code].retriable };
}

/** The status a surface answers `code` with. */
export function resolveContextErrorStatus(
  code: ResolveContextErrorCode,
): number {
  return RESOLVE_CONTEXT_ERROR_TABLE[code].status;
}

/**
 * A failure that already knows which `ResolveContextErrorCode` it is.
 *
 * Carrying the code on the exception rather than mapping exception classes at
 * each surface is what keeps MCP and HTTP from drifting: both ask the error what
 * it is instead of each maintaining its own `instanceof` ladder over the same
 * classes.
 */
export class ResolveContextFailure extends Error {
  readonly code: ResolveContextErrorCode;

  constructor(code: ResolveContextErrorCode, message: string) {
    super(message);
    this.name = "ResolveContextFailure";
    this.code = code;
  }

  get retriable(): boolean {
    return RESOLVE_CONTEXT_ERROR_TABLE[this.code].retriable;
  }

  toResolveContextError(): ResolveContextError {
    return resolveContextError(this.code);
  }
}

/** Thrown when a request carries no query text to select against. */
export class EmptyQueryError extends ResolveContextFailure {
  constructor() {
    super("empty_query", "Query text must not be empty.");
    this.name = "EmptyQueryError";
  }
}

/**
 * Thrown when a request's `maxContextCharacters` is not a ceiling we may apply.
 *
 * Raised before anything is planned, because the budget decides what an answer
 * is allowed to contain and a request that misstates it has not asked a question
 * we can answer. A caller may only narrow the configured ceiling: a value above
 * it is refused rather than clamped, so a caller that believed it had widened
 * the budget is told it had not.
 */
export class InvalidContextBudgetError extends ResolveContextFailure {
  constructor(message: string) {
    super("invalid_context_budget", message);
    this.name = "InvalidContextBudgetError";
  }
}

/**
 * Thrown when a query is longer than the embedding profile admits.
 *
 * A request-level refusal rather than a degradation, and the asymmetry with
 * `CardEmbeddingUnavailableError` below is the point. A provider that is down is
 * our problem and a caller can do nothing about it, so answering with a lexical
 * ranking is a service. A query that is too long is something the caller can fix
 * by sending a shorter one, and silently answering it under a different scoring
 * family would hide the one fact it needs to know.
 *
 * Never truncation. Embedding the first 480 units of a longer question would
 * answer a question nobody asked, and the response would carry no sign of it.
 */
export class QueryInputLimitExceededError extends ResolveContextFailure {
  constructor(message: string) {
    super("query_input_limit_exceeded", message);
    this.name = "QueryInputLimitExceededError";
  }
}

/**
 * Thrown when a plan is over one or more `selection-planning-v2` ceilings.
 *
 * Raised after merging and before anything is executed, which is the only
 * honest moment: earlier, the plan's real size is not known; later, a read has
 * already been issued on a plan that policy says may not run. Nothing is
 * trimmed to fit. A Guide list cut to size would tell a consumer it had every
 * Scope the query selected when it did not, and a `selectedBy` cut to size
 * would erase which Card authorised a read — both quieter than a refusal and
 * both wrong. 422 and not retriable: the same query against the same catalog
 * plans the same size.
 *
 * Every crossed ceiling travels on the error, so an operator sees the whole
 * picture once rather than one dimension per attempt.
 */
export class SelectionPlanLimitExceededError extends ResolveContextFailure {
  readonly violations: readonly PlanningLimitViolation[];

  constructor(violations: readonly PlanningLimitViolation[]) {
    super(
      "selection_plan_limit_exceeded",
      `plan exceeds ${SELECTION_PLANNING_POLICY_VERSION}: ${violations
        .map((violation) => `${violation.limit} ${violation.actual} > ${violation.allowed}`)
        .join(", ")}`,
    );
    this.name = "SelectionPlanLimitExceededError";
    this.violations = violations;
  }
}

/**
 * Thrown when the semantic path is unusable and the policy does not permit a
 * lexical answer.
 *
 * The refusal exists so that "degrade to lexical" stays a decision somebody
 * made. A deployment that has to answer under hybrid semantics — because its
 * Cards are written for meaning rather than for keywords — would otherwise get a
 * lexical ranking labelled correctly and still wrong for its catalog, and the
 * only visible symptom would be a quietly emptier answer.
 *
 * What it never does is admit anything on the strength of the failure. Both arms
 * of the branch produce a ranking or no answer at all; neither widens what a
 * query may reach.
 */
export class CardEmbeddingUnavailableError extends ResolveContextFailure {
  constructor(message: string) {
    super("selection_embedding_unavailable", message);
    this.name = "CardEmbeddingUnavailableError";
  }
}

/**
 * Which code a thrown failure reports as, for every surface.
 *
 * One ladder rather than one per protocol. MCP and HTTP reporting the same
 * fault under two codes would make `retriable` a property of the transport
 * instead of of the failure, and a client that switched surfaces would find its
 * retry logic quietly wrong.
 *
 * A `ResolveContextFailure` already knows its own code, which is why the
 * failures a caller can actually fix — an empty query, an unusable ceiling, an
 * over-long query — need no entry of their own. The domain invariant errors do:
 * each means a value this package produced, or was configured with, broke a rule
 * this package states, and that is a `selection_invariant_violation` rather than
 * a fault of the caller's. Everything else is `unexpected_failure`, which
 * promises nothing.
 *
 * Codes with no throw site — `overloaded`, `deadline_exceeded`,
 * `selection_catalog_unavailable` — are absent on purpose. Each is declared in
 * the vocabulary and each has a status and a `retriable`, but nothing in this
 * package raises them yet (they are the daemon's admission lane and deadline,
 * and a catalog port that cannot answer), and inventing a throw site to make
 * the mapping look complete would ship a code no condition actually stands
 * behind. `selection_plan_limit_exceeded` is raised by
 * `SelectionPlanLimitExceededError` after planning, and like every other
 * `ResolveContextFailure` it carries its own code.
 */
export function toResolveContextErrorCode(
  cause: unknown,
): ResolveContextErrorCode {
  if (cause instanceof ResolveContextFailure) {
    return cause.code;
  }
  if (cause instanceof ContextBudgetInvariantError) {
    // Reachable only for a budget the deployment was configured with: a
    // request's own ceiling is checked against the configured one first, and a
    // value that survives that check cannot break the assembly invariant.
    return "invalid_context_budget";
  }
  if (
    cause instanceof CardSelectionInputLimitError ||
    cause instanceof CardCatalogInvariantError
  ) {
    // A Card whose canonical text is longer than its own profile admits, or
    // whose policy cannot be read as one, is a catalog we cannot select over,
    // not a rule this package broke: nothing here wrote the Card, and no
    // threshold or policy of ours would make it usable.
    return "selection_catalog_invalid";
  }
  if (
    cause instanceof SelectionThresholdsInvariantError ||
    cause instanceof SelectionCandidateInvariantError ||
    cause instanceof SelectionScopeInvariantError ||
    cause instanceof SelectionPlanInvariantError ||
    cause instanceof ManagedResolutionInvariantError ||
    cause instanceof CanonicalDigestInvariantError ||
    cause instanceof CardSelectionProfileInvariantError ||
    cause instanceof CardCandidateIndexInvariantError ||
    cause instanceof SelectionModeInvariantError ||
    cause instanceof PolicyContextInvariantError
  ) {
    return "selection_invariant_violation";
  }
  return "unexpected_failure";
}
