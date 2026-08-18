import {
  isId,
  isIsoTimestamp,
  isRevisionId,
} from "./model-validation.js";
import type {
  IndexStagingAttempt,
  IndexStagingAttemptKey,
} from "../ports/index-staging-attempt.js";

export function assertValidIndexStagingAttemptKey(
  input: IndexStagingAttemptKey,
): void {
  if (
    !isId(input.documentIndexId, "didx") ||
    !isRevisionId(input.indexVersion, "idxv")
  ) {
    throw new TypeError("invalid Index staging attempt key");
  }
}

export function assertValidIndexStagingAttempt(
  attempt: IndexStagingAttempt,
): void {
  assertValidIndexStagingAttemptKey(attempt);
  const validState =
    attempt.state === "pending" ||
    attempt.state === "publishing" ||
    attempt.state === "cleaning";
  const ownsLease = attempt.state !== "pending";
  if (
    !validState ||
    attempt.connectorId.trim() === "" ||
    attempt.accessHandle.trim() === "" ||
    !isIsoTimestamp(attempt.firstAttemptedAt) ||
    !isIsoTimestamp(attempt.lastAttemptedAt) ||
    Date.parse(attempt.firstAttemptedAt) > Date.parse(attempt.lastAttemptedAt) ||
    ownsLease !== (attempt.ownerLeaseId !== undefined) ||
    ownsLease !== (attempt.ownerExpiresAt !== undefined) ||
    (attempt.ownerLeaseId !== undefined &&
      !isId(attempt.ownerLeaseId, "lease")) ||
    (attempt.ownerExpiresAt !== undefined &&
      (!isIsoTimestamp(attempt.ownerExpiresAt) ||
        Date.parse(attempt.ownerExpiresAt) <=
          Date.parse(attempt.lastAttemptedAt)))
  ) {
    throw new TypeError("invalid Index staging attempt");
  }
}

export function expirationAfter(timestamp: string, durationMs: number): string {
  if (
    !isIsoTimestamp(timestamp) ||
    !Number.isSafeInteger(durationMs) ||
    durationMs <= 0
  ) {
    throw new TypeError("invalid Index staging lease duration");
  }
  return new Date(Date.parse(timestamp) + durationMs).toISOString();
}
