/** Deterministic ID source so identifiers are controllable in tests. */
export interface IdGenerator {
  nextId(): string;
}
