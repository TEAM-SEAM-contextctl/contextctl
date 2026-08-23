import type { ContextBudget } from "../domain/context-assembly.js";
import type { SelectionPlan } from "../domain/selection-plan.js";
import {
  CONTEXT_RESOLUTION_MAXIMUM_BYTES,
  RESOLVE_REQUEST_MAXIMUM_BYTES,
  utf8ByteLength,
} from "../domain/transport-policy.js";
import {
  ResolveContextFailure,
  SelectionPlanLimitExceededError,
} from "./errors.js";

// JSON.stringify can represent one UTF-16 code unit as a six-byte `\uXXXX`
// escape. This is deliberately the worst case rather than a language-specific
// average: the check runs before retrieval and must never under-count source
// text that has not arrived yet.
const MAXIMUM_JSON_BYTES_PER_CONTEXT_CHARACTER = 6;

// A finished response adds its policy, fulfillment state and bounded chunk
// metadata while dropping the plan's private targets and candidate audit. The
// fixed allowance is intentionally generous; the variable portions below are
// counted separately so changing the configured context budget still changes
// the estimate.
const RESPONSE_SHAPE_ALLOWANCE_BYTES = 64 * 1024;
// A public chunk carries four independently bounded 256-unit identifiers. Any
// unit may need a six-byte JSON escape, so those identifiers alone can occupy
// 6 KiB before field names, digest and rank are added. Eight KiB is therefore a
// real upper bound with room for the fixed fields, not an average fixture size.
const CHUNK_METADATA_ALLOWANCE_BYTES = 8 * 1024;

// An omission carries two of the same identifiers plus one fixed reason. Four
// KiB covers the 3 KiB worst-case escaped identifiers and the object syntax.
const OMISSION_METADATA_ALLOWANCE_BYTES = 4 * 1024;

/** Refuses a decoded request before it can enter the application. */
export function assertResolveRequestPayloadWithinLimit(payload: string): void {
  if (utf8ByteLength(payload) > RESOLVE_REQUEST_MAXIMUM_BYTES) {
    throw new ResolveContextFailure(
      "invalid_request",
      "Resolve request exceeds the public UTF-8 byte limit.",
    );
  }
}

/** Refuses a fully serialized response rather than truncating it. */
export function assertContextResolutionPayloadWithinLimit(payload: string): void {
  if (utf8ByteLength(payload) > CONTEXT_RESOLUTION_MAXIMUM_BYTES) {
    throw new ResolveContextFailure(
      "unexpected_failure",
      "Context resolution exceeds the public UTF-8 byte limit.",
    );
  }
}

/** Serializes one schema-v3 response and applies the final Delivery guard. */
export function serializeContextResolutionPayload(value: unknown): string {
  const payload = JSON.stringify(value);
  assertContextResolutionPayloadWithinLimit(payload);
  return payload;
}

/**
 * Conservative pre-retrieval upper bound for one schema-v3 response.
 *
 * The complete private plan is counted even though candidate signals, target
 * keys and execution bookkeeping never leave the process. On top of that
 * over-count we reserve worst-case escaped document text, one metadata record
 * per response chunk, and one omission record for every hit the plan can ask
 * Indexing to return. A plan rejected here performs no managed search.
 */
export function maximumContextResolutionBytes(
  plan: SelectionPlan,
  budget: ContextBudget,
): number {
  const planBytes = utf8ByteLength(JSON.stringify(plan));
  const contextBytes =
    budget.maxTotalCharacters * MAXIMUM_JSON_BYTES_PER_CONTEXT_CHARACTER;
  const chunkBytes = budget.maxChunks * CHUNK_METADATA_ALLOWANCE_BYTES;
  const omissionCount = plan.managedTargets.reduce(
    (total, target) => total + target.limit,
    0,
  );
  const omissionBytes = omissionCount * OMISSION_METADATA_ALLOWANCE_BYTES;
  return (
    planBytes +
    RESPONSE_SHAPE_ALLOWANCE_BYTES +
    contextBytes +
    chunkBytes +
    omissionBytes
  );
}

/** Enforces Selection's response bound before daemon executes any target. */
export function assertContextResolutionCanFit(
  plan: SelectionPlan,
  budget: ContextBudget,
): void {
  const actual = maximumContextResolutionBytes(plan, budget);
  if (
    !Number.isSafeInteger(actual) ||
    actual > CONTEXT_RESOLUTION_MAXIMUM_BYTES
  ) {
    throw new SelectionPlanLimitExceededError([
      {
        limit: "responseBytes",
        allowed: CONTEXT_RESOLUTION_MAXIMUM_BYTES,
        actual,
      },
    ]);
  }
}
