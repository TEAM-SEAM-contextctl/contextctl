import { ManagedResolutionInvariantError } from "./errors.js";

/**
 * What one managed document target's read produced.
 *
 * This is not a port. Nothing in this package searches anything: the plan names
 * targets, something outside executes them, and these are the finished results
 * coming back. The distinction is the whole point of the split — a Delivery
 * that held a search port would decide when a read happens, and a read is an
 * access rather than a detail of formatting.
 *
 * The shape is structurally identical to what Indexing's batch search answers
 * with, and that identity is deliberate but uncompiled: this package declares no
 * dependency on Indexing and Indexing knows nothing of this domain, so the
 * translation is one field-by-field copy in the Composition Root and no type
 * flows between the two. Sharing the declaration would put a domain package's
 * vocabulary in another domain package's build, which the boundary test forbids
 * and ADR 0004 already refused once.
 */
export type ManagedResolutionOutcome =
  | {
      readonly targetKey: string;
      readonly status: "fulfilled";
      readonly chunks: readonly ResolvedDocumentChunk[];
    }
  | {
      readonly targetKey: string;
      readonly status: "failed";
      readonly failure: ManagedResolutionFailure;
    };

/**
 * One chunk a completed read returned, carrying enough identity to cite it.
 *
 * `rank` is a 1-based position within this one target's answer, and it is the
 * only ordering signal that crosses: a provider's own similarity is not
 * comparable between two indexes, two profiles, or two versions of one model,
 * so a number claiming to be a score would be a number no consumer could use.
 * Fusing ranks is what `context-assembly.ts` does instead.
 */
export interface ResolvedDocumentChunk {
  readonly rank: number;
  readonly chunkId: string;
  readonly chunkRevisionId: string;
  readonly semanticUnitId: string;
  readonly documentId: string;
  readonly text: string;
  readonly contentDigest: string;
}

/**
 * Why one target could not be read.
 *
 * `stage` says where the attempt stopped, which is the one thing a consumer can
 * act on without knowing our internals: `managed_search` means the search
 * answered with a failure, `deadline` means it never answered at all. The two
 * are different facts and collapsing them would tell a consumer a search
 * rejected a request it never received.
 *
 * `code` is an opaque token, and Delivery treats it as one — see
 * `assertOpaqueFailure`.
 */
export interface ManagedResolutionFailure {
  readonly stage: ManagedResolutionStage;
  readonly code: string;
  readonly retriable: boolean;
}

export type ManagedResolutionStage = "managed_search" | "deadline";

/**
 * The grammar a failure code has to fit, and the whole of what Delivery checks.
 *
 * Lowercase, underscore-separated, starting with a letter, at most 64
 * characters. Deliberately a grammar rather than a list: the executor's own
 * error vocabulary is the executor's to version, and copying it here would
 * create a second copy that goes stale the first time a code is added — at
 * which point Delivery would reject a perfectly valid answer, or worse, fold it
 * into a code of our own.
 *
 * The bound matters as much as the shape. A code reaches a consumer, so an
 * unbounded string from an adapter is an unbounded string in a response.
 */
export const MANAGED_FAILURE_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;

/**
 * Refuses an outcome Delivery cannot honestly report, and nothing else.
 *
 * There is no branch on the code's value here and there must not be one. A
 * `switch` over an executor's codes would make Delivery a second place that
 * decides what a search failure means, and the two places would disagree the
 * first time either one changed. What Delivery is entitled to check is that the
 * code is a token it can print and that `retriable` is a boolean a consumer can
 * branch on — both are facts about the shape of the answer, not about its
 * meaning.
 *
 * It throws rather than substituting a placeholder, because an outcome outside
 * the grammar is our own bug in the translation step, not an upstream failure
 * mode, and a resolution that quietly renamed it would hide the bug behind a
 * plausible answer.
 */
export function assertOpaqueFailure(failure: ManagedResolutionFailure): void {
  if (!MANAGED_FAILURE_CODE_PATTERN.test(failure.code)) {
    throw new ManagedResolutionInvariantError(
      `failure code ${JSON.stringify(failure.code)} is not a permitted opaque token`,
    );
  }
  if (typeof failure.retriable !== "boolean") {
    throw new ManagedResolutionInvariantError(
      `failure ${failure.code} must state retriable as a boolean`,
    );
  }
}
