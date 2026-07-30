/** Deterministic time source so timestamps are controllable in tests. */
export interface Clock {
  now(): string;
}
