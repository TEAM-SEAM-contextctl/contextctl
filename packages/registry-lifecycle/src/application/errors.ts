/** Thrown when a claimed Publication ID cannot be resolved to an immutable Publication. */
export class PublicationNotFoundError extends Error {
  constructor(publicationId: string) {
    super(`publication ${publicationId} was not found`);
    this.name = "PublicationNotFoundError";
  }
}
