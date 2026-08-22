/**
 * Process facts a Delivery transport can observe but must not interpret.
 *
 * The transport records when a request reached the process and when its caller
 * left. The injected executor decides what those facts mean for admission,
 * deadlines and cancellation. Keeping that decision behind this interface lets
 * Delivery own protocol handling without duplicating daemon runtime policy.
 */
export interface DeliveryRequestExecutionInput {
  readonly arrivedAt: number;
  readonly signal?: AbortSignal;
}

/**
 * Runtime control injected by the process composition root.
 *
 * `maximumInFlightRequests` is transport backpressure, not a second admission
 * queue. The daemon supplies a value large enough for its running and queued
 * Resolve requests plus the one request that observes overload. The authoritative
 * accept, queue and refuse decision remains inside `runRequest`.
 */
export interface DeliveryRequestExecution {
  readonly maximumInFlightRequests: number;
  now(): number;
  runRequest<T>(
    input: DeliveryRequestExecutionInput,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T>;
  /** Re-checks a fully serialized successful response immediately before write. */
  assertResponseCanCommit(): void;
}
