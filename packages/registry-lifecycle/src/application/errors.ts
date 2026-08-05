/** Thrown when a claimed Publication ID cannot be resolved to an immutable Publication. */
export class PublicationNotFoundError extends Error {
  constructor(publicationId: string) {
    super(`publication ${publicationId} was not found`);
    this.name = "PublicationNotFoundError";
  }
}

/** Thrown when an operator decision names a Card or version that does not exist. */
export class CardNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CardNotFoundError";
  }
}
