/** Thrown when a Card Version history is mutated in a way that would break append-only guarantees. */
export class CardVersionInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CardVersionInvariantError";
  }
}

/**
 * Thrown when a reachability observation gathers evidence about a Scope version
 * other than the one it claims to describe. Judging such an observation would
 * report a state for the wrong Scope, so it fails loudly instead.
 */
export class ScopeReachabilityInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeReachabilityInvariantError";
  }
}
