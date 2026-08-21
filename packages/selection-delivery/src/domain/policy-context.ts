import type { ApprovedCard } from "./card-catalog.js";
import { CardCatalogInvariantError, PolicyContextInvariantError } from "./errors.js";

/**
 * What a deployment permits a query to reach, fixed by the operator.
 *
 * Injected by the Composition Root and never carried on a request: a caller
 * that could state its own `sensitiveAccess` would be a caller granting itself
 * access, which is the one thing this type exists to make unrepresentable.
 * `usage` is the literal `"retrieval"` rather than a string because v1 defines
 * no other purpose, and a wider type would be a permission nobody decided to
 * grant (SOT L78, L88).
 */
export interface PolicyContext {
  readonly usage: "retrieval";
  readonly sensitiveAccess: "deny" | "allow";
}

/** The policy a deployment runs under unless its operator says otherwise. */
export const DEFAULT_POLICY_CONTEXT: PolicyContext = {
  usage: "retrieval",
  sensitiveAccess: "deny",
};

/**
 * Why a Card was kept out of a selection before it was scored.
 *
 * Two reasons and not a boolean, because the operator's remedy differs: a
 * usage mismatch is a Card approved for some other purpose, and a sensitivity
 * refusal is a deployment whose `sensitiveAccess` is `deny`. Neither is a
 * verdict — an excluded Card never meets a threshold, so it is never `reject`.
 */
export type PolicyExclusionReason = "usage_not_allowed" | "sensitive_denied";

export interface PolicyExclusion {
  readonly cardId: string;
  readonly versionId: string;
  readonly reason: PolicyExclusionReason;
}

/** What applying one policy to one catalog decided, both halves kept. */
export interface PolicyApplication {
  readonly context: PolicyContext;
  /** The Cards a query may be scored against, in catalog order. */
  readonly eligible: readonly ApprovedCard[];
  /** The Cards it may not, with the reason each one was kept out. */
  readonly excluded: readonly PolicyExclusion[];
}

/**
 * Splits a catalog into the Cards a policy admits to scoring and the ones it
 * keeps out.
 *
 * A closed decision taken before any score exists: a Card that is not eligible
 * is absent from both the lexical and the semantic candidate set, never
 * ranked, never counted, and never named in a response. Excluding it after
 * ranking would let it displace an eligible Card from a top-K and would leave
 * its presence legible in the counts (SOT L88, L1424, L2486).
 *
 * The catalog's shape is validated first and as a whole. A Card whose policy
 * cannot be read is not silently dropped — dropping it would make a malformed
 * catalog indistinguishable from a strict one — so the whole catalog is
 * refused instead (SOT L88).
 *
 * When a Card fails both tests the usage reason is reported: usage is the
 * broader gate, and a Card not approved for this purpose is kept out whatever
 * the deployment decides about sensitivity.
 */
export function applyPolicyContext(
  cards: readonly ApprovedCard[],
  context: PolicyContext,
): PolicyApplication {
  assertValidPolicyContext(context);
  validateCatalogPolicies(cards);

  const eligible: ApprovedCard[] = [];
  const excluded: PolicyExclusion[] = [];

  for (const card of cards) {
    const reason = exclusionReason(card, context);
    if (reason === undefined) {
      eligible.push(card);
    } else {
      excluded.push({ cardId: card.cardId, versionId: card.versionId, reason });
    }
  }

  return { context, eligible, excluded };
}

function exclusionReason(
  card: ApprovedCard,
  context: PolicyContext,
): PolicyExclusionReason | undefined {
  if (!card.policy.allowedUsage.includes(context.usage)) {
    return "usage_not_allowed";
  }
  if (card.policy.sensitive && context.sensitiveAccess !== "allow") {
    return "sensitive_denied";
  }
  return undefined;
}

/**
 * Refuses a catalog in which any Card's policy cannot be read as one.
 *
 * All offending Cards are named, not just the first: an operator fixing a
 * catalog wants the whole list, and a check that stopped early would send them
 * back once per Card. Refused as a whole rather than filtered, because a
 * policy this code cannot read is a policy it cannot enforce, and scoring the
 * readable remainder would present a partial catalog as the approved one
 * (SOT L88: `selection_catalog_invalid`, never a silent drop).
 *
 * The checks are structural — what the read model promises and a translation
 * could still break: `allowedUsage` must be a non-empty array of distinct,
 * non-blank strings, and `sensitive` must be a boolean. A `sensitive` that is
 * merely truthy would pass a loose check and be enforced as `true` or `false`
 * by accident, which is the wrong direction to be accidental in.
 */
export function validateCatalogPolicies(cards: readonly ApprovedCard[]): void {
  const problems: string[] = [];

  for (const card of cards) {
    // Read as `unknown` on purpose: the type says these are well-formed, and
    // the point of this function is to not trust that at the boundary.
    const policy: unknown = card.policy;
    const label = `${card.cardId}/${card.versionId}`;
    if (policy === null || typeof policy !== "object") {
      problems.push(`${label}: policy is not an object`);
      continue;
    }
    const { sensitive, allowedUsage } = policy as {
      readonly sensitive?: unknown;
      readonly allowedUsage?: unknown;
    };
    if (typeof sensitive !== "boolean") {
      problems.push(`${label}: sensitive is not a boolean`);
    }
    if (!Array.isArray(allowedUsage)) {
      problems.push(`${label}: allowedUsage is not an array`);
      continue;
    }
    if (allowedUsage.length === 0) {
      problems.push(`${label}: allowedUsage is empty`);
    }
    if (
      allowedUsage.some(
        (usage) => typeof usage !== "string" || usage.trim() === "",
      )
    ) {
      problems.push(`${label}: allowedUsage holds a non-string or blank entry`);
    }
    if (new Set(allowedUsage).size !== allowedUsage.length) {
      problems.push(`${label}: allowedUsage holds a duplicate`);
    }
  }

  if (problems.length > 0) {
    throw new CardCatalogInvariantError(
      `approved catalog carries ${problems.length} unreadable Card polic${problems.length === 1 ? "y" : "ies"}: ${problems.join("; ")}`,
    );
  }
}

/**
 * Refuses a context this package did not define.
 *
 * The type already says so; this says so at runtime, because the context is
 * configuration handed in by a Composition Root and a value that drifted from
 * the type would otherwise be enforced as whichever branch it happened to fall
 * through — an unknown `sensitiveAccess` must not read as `deny` by luck.
 */
export function assertValidPolicyContext(context: PolicyContext): void {
  const candidate: { readonly usage?: unknown; readonly sensitiveAccess?: unknown } =
    context;
  if (candidate.usage !== "retrieval") {
    throw new PolicyContextInvariantError(
      `policy usage must be "retrieval", received ${JSON.stringify(candidate.usage)}`,
    );
  }
  if (candidate.sensitiveAccess !== "deny" && candidate.sensitiveAccess !== "allow") {
    throw new PolicyContextInvariantError(
      `policy sensitiveAccess must be "deny" or "allow", received ${JSON.stringify(candidate.sensitiveAccess)}`,
    );
  }
}
