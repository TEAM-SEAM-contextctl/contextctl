/** Thrown when a request carries no query text to select against. */
export class EmptyQueryError extends Error {
  constructor() {
    super("Query text must not be empty.");
    this.name = "EmptyQueryError";
  }
}
