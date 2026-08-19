import type { ContextResolution } from "../domain/context-resolution.js";
import {
  DEFAULT_CONTEXT_BUDGET,
  type ContextBudget,
} from "../domain/context-assembly.js";
import { InvalidContextBudgetError } from "./errors.js";

/**
 * The whole of what a query surface is allowed to reach.
 *
 * Selection, execution and assembly are three steps now, and only one party is
 * entitled to run all three: the Composition Root, which is the only place that
 * may bind a store and name a security domain. A protocol handler is not that
 * party. It decodes a request, calls this one method, and encodes what comes
 * back.
 *
 * One method, deliberately. It used to have two: `listApprovedCards` fed a
 * catalog listing on both surfaces, and both listings are gone — a consumer that
 * can enumerate the approved Cards can map the catalog without ever asking a
 * question, and the listing answered nothing a resolution does not answer
 * already. Removing the method is what makes that structural: a handler cannot
 * list Cards a resolution would not have selected because there is nothing left
 * to call. It cannot hold a managed search port either, so it cannot cause a
 * read outside a plan.
 */
export interface ResolveContextApplication {
  resolveContext(request: ResolveContextRequest): Promise<ContextResolution>;
}

/**
 * One resolution request, reduced to what a caller is entitled to state.
 *
 * A caller may narrow the context budget and nothing else. Thresholds decide
 * what a query is allowed to reach and the per-Scope bound decides how much of
 * an index is touched; letting either cross the wire would turn a selection
 * policy into a request parameter.
 *
 * The narrowing is one number rather than a whole budget, because a whole budget
 * is a shape a caller could fill in every field of — including `maxChunks`,
 * which is an assembly decision about how many separate citations an answer
 * carries, and including a `maxTotalCharacters` above the configured one.
 */
export interface ResolveContextRequest {
  readonly query: string;
  /** A ceiling at or below the configured one. Never above it. */
  readonly maxContextCharacters?: number;
}

/**
 * Applies a caller's ceiling to the configured budget, or refuses the request.
 *
 * `min(configured, requested)` rather than "whichever the request named": the
 * configured ceiling is an operator's decision about what this deployment will
 * emit, and a request is a consumer asking for less. A value above the
 * configured one is refused rather than silently clamped, because a caller that
 * asked for 40000 and received 8000 without being told has no way to know its
 * request was not honoured — and the difference matters precisely when it is
 * budgeting a context window.
 *
 * Only `maxTotalCharacters` moves. `maxChunks` stays whatever the deployment was
 * assembled with, so a caller cannot widen — or narrow — a limit it was never
 * given control of.
 *
 * Every rejection here happens before a plan exists, which is what makes it a
 * request-level `ResolveContextError` rather than an item-level failure: nothing
 * was read, so there is no partial answer to report it against.
 */
export function narrowContextBudget(
  configured: ContextBudget | undefined,
  requested: number | undefined,
): ContextBudget {
  const base = configured ?? DEFAULT_CONTEXT_BUDGET;
  if (requested === undefined) {
    return base;
  }
  // `isSafeInteger` covers a non-number arriving through an untyped surface,
  // NaN, Infinity and a fraction in one check. A fractional ceiling has no
  // meaning against a character count that is always whole, and a non-finite one
  // would make every comparison against it false.
  if (typeof requested !== "number" || !Number.isSafeInteger(requested)) {
    throw new InvalidContextBudgetError(
      `maxContextCharacters must be a safe integer, received ${String(requested)}`,
    );
  }
  if (requested <= 0) {
    throw new InvalidContextBudgetError(
      `maxContextCharacters must be greater than zero, received ${requested}`,
    );
  }
  if (requested > base.maxTotalCharacters) {
    throw new InvalidContextBudgetError(
      `maxContextCharacters ${requested} is above the configured ceiling ${base.maxTotalCharacters}; a request may only narrow it`,
    );
  }

  return {
    maxTotalCharacters: Math.min(base.maxTotalCharacters, requested),
    maxChunks: base.maxChunks,
  };
}
