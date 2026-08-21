/** Thrown when selection thresholds cannot form a usable admit/defer/reject band. */
export class SelectionThresholdsInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelectionThresholdsInvariantError";
  }
}

/** Thrown when the candidate set cannot be ranked deterministically. */
export class SelectionCandidateInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelectionCandidateInvariantError";
  }
}

/** Thrown when a context budget cannot be satisfied without violating its own limits. */
export class ContextBudgetInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextBudgetInvariantError";
  }
}

/**
 * Thrown when a finished plan does not hold together.
 *
 * A plan is consumed twice — by the executor that reads its targets and by the
 * assembly that files the results — and both trust its keys. A key that no
 * longer matches the fields it was derived from, a Card listed twice on one
 * item, an item selected by a Card the ranking never admitted, a target no
 * item points at: each means the plan was built or altered outside the rules
 * this domain states, and reading anything on the strength of it would be an
 * access nobody decided on.
 */
export class SelectionPlanInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelectionPlanInvariantError";
  }
}

/** Thrown when a selected Scope cannot be resolved into a retrievable target. */
export class SelectionScopeInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelectionScopeInvariantError";
  }
}

/** Thrown when a Card embedding profile's own fields contradict each other. */
export class CardSelectionProfileInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CardSelectionProfileInvariantError";
  }
}

/**
 * Thrown when a candidate index cannot identify its own records.
 *
 * A record is identified by `(cardVersionId, selectionTextDigest, profileId,
 * profileVersion)`. Two records sharing that tuple would make "the vector for
 * this Card Version" ambiguous, and a cosine taken against the wrong one is not
 * detectable afterwards — it is simply a different ranking.
 */
export class CardCandidateIndexInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CardCandidateIndexInvariantError";
  }
}

/**
 * Thrown when a response's `mode` and `scoring` do not name the same family.
 *
 * The pair is an invariant rather than two independent fields: `hybrid` requires
 * `selection-hybrid-v1` and `lexical_degraded` requires `selection-lexical-v1`.
 * A response carrying any other combination claims a ranking it did not produce,
 * so it is refused before assembly rather than emitted for a consumer to
 * discover.
 */
export class SelectionModeInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelectionModeInvariantError";
  }
}

/**
 * Thrown when a Card's canonical selection text is longer than the profile
 * admits.
 *
 * Raised rather than truncated. Silently cutting a Card's text would embed a
 * different Card than the one the digest certifies, and the resulting vector
 * would be wrong in a way no later check could detect — the digest would still
 * match the text we *meant* to embed. An over-long Card is a catalog that has to
 * be fixed, and saying so is the only honest outcome.
 */
export class CardSelectionInputLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CardSelectionInputLimitError";
  }
}

/** Thrown when a value has no canonical form and therefore no stable key. */
export class CanonicalDigestInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalDigestInvariantError";
  }
}

/**
 * Thrown when a managed resolution outcome cannot be trusted as it stands.
 *
 * Delivery does not repair an outcome. A failure code outside the token grammar
 * means whoever executed the plan handed us something we cannot put in front of
 * a consumer, and quietly substituting a code of our own would report a
 * diagnosis nobody made.
 */
export class ManagedResolutionInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedResolutionInvariantError";
  }
}

/**
 * Thrown when the approved catalog cannot be read as one.
 *
 * A Card whose policy is not the shape the read model promises — a usage list
 * that is empty or repeats itself, a sensitivity flag that is not a boolean —
 * is refused with the whole catalog rather than dropped on its own. Dropping it
 * would present the readable remainder as the approved catalog, and a consumer
 * could not tell that from a catalog that was simply small (SOT L88).
 */
export class CardCatalogInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CardCatalogInvariantError";
  }
}

/**
 * Thrown when the policy context a deployment was configured with is not one
 * this package defines. Configuration, not a request: a caller cannot state a
 * policy at all, so a bad one is the Composition Root's to fix.
 */
export class PolicyContextInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyContextInvariantError";
  }
}
