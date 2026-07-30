/** Thrown when a Card Version history is mutated in a way that would break append-only guarantees. */
export class CardVersionInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CardVersionInvariantError";
  }
}
