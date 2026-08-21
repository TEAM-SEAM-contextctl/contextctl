import {
  isDigest,
  isIsoTimestamp,
  isUuidV7Id,
} from "./model-validation.js";

export type SourceObservationPayload =
  | null
  | boolean
  | number
  | string
  | readonly SourceObservationPayload[]
  | { readonly [key: string]: SourceObservationPayload };

/** Ingestion-private immutable snapshot produced by one successful capture. */
export interface SourceObservation {
  readonly id: string;
  readonly sourceId: string;
  readonly capturedAt: string;
  readonly contentDigest: string;
  readonly payload: SourceObservationPayload;
}

export interface CreateSourceObservationInput {
  readonly id: string;
  readonly sourceId: string;
  readonly capturedAt: string;
  readonly contentDigest: string;
  readonly payload: unknown;
}

export class SourceObservationValidationError extends Error {
  readonly code = "observation_invalid";

  constructor() {
    super("Source Observation failed validation");
    this.name = "SourceObservationValidationError";
  }
}

export function createSourceObservation(
  input: CreateSourceObservationInput,
): SourceObservation {
  assertSourceObservationPayload(input.payload);
  const observation: SourceObservation = {
    id: input.id,
    sourceId: input.sourceId,
    capturedAt: input.capturedAt,
    contentDigest: input.contentDigest,
    payload: structuredClone(input.payload),
  };
  assertValidSourceObservation(observation);
  return observation;
}

export function assertValidSourceObservation(
  observation: SourceObservation,
): void {
  try {
    assertSourceObservationPayload(observation.payload);
    if (
      !isUuidV7Id(observation.id, "obs") ||
      !isUuidV7Id(observation.sourceId, "src") ||
      !isIsoTimestamp(observation.capturedAt) ||
      !isDigest(observation.contentDigest)
    ) {
      throw new SourceObservationValidationError();
    }
  } catch (error) {
    if (error instanceof SourceObservationValidationError) throw error;
    throw new SourceObservationValidationError();
  }
}

function assertSourceObservationPayload(
  payload: unknown,
): asserts payload is SourceObservationPayload {
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    ) {
      return;
    }
    if (typeof value === "number") {
      if (Number.isFinite(value)) return;
      throw new SourceObservationValidationError();
    }
    if (typeof value !== "object") {
      throw new SourceObservationValidationError();
    }
    if (seen.has(value)) {
      throw new SourceObservationValidationError();
    }
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new SourceObservationValidationError();
      }
      for (const item of Object.values(value)) visit(item);
    }
    seen.delete(value);
  };
  visit(payload);
}
