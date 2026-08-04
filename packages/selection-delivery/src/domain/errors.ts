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

/** Thrown when an evidence budget cannot be satisfied without violating its own limits. */
export class EvidenceBudgetInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceBudgetInvariantError";
  }
}

/** Thrown when a selected Scope cannot be resolved into a retrievable target. */
export class SelectionScopeInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelectionScopeInvariantError";
  }
}
