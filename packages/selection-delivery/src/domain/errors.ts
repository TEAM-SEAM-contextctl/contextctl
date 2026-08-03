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
