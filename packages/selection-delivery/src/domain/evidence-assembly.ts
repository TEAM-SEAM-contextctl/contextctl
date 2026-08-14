import type { ApprovedScopeReference } from "./card-catalog.js";
import { EvidenceBudgetInvariantError } from "./errors.js";

/** Identifies the assembly rules an evidence record was produced under. */
export const EVIDENCE_ASSEMBLY_POLICY_VERSION = "evidence-assembly-v1";

/**
 * One retrieved chunk carrying the coordinates of where it came from.
 *
 * This is a `RetrievedChunk` widened with the Card Version and the Scope
 * reference the search ran under: the retriever answers per document index and
 * cannot know which Card selected it, so the caller stamps that on before
 * assembly. Every field is needed to cite the chunk back to an approved source.
 */
export interface EvidenceChunk {
  readonly cardId: string;
  readonly versionId: string;
  readonly scopeRef: ApprovedScopeReference;
  readonly chunkId: string;
  readonly chunkRevisionId: string;
  readonly semanticUnitId: string;
  readonly documentId: string;
  readonly contentDigest: string;
  readonly text: string;
  readonly score: number;
}

/**
 * How much evidence one answer may carry.
 *
 * Both limits are hard ceilings, not targets: assembly stops at the first chunk
 * that would cross either one. ADR 0002 puts the budget in this domain because
 * the consumer receives whatever we assemble and has no way to renegotiate it.
 */
export interface EvidenceBudget {
  readonly maxTotalCharacters: number;
  readonly maxChunks: number;
}

/**
 * Starting budget.
 *
 * The character ceiling is a deliberately coarse token approximation — see
 * `assembleDocumentEvidence` — sized so that a full evidence set still leaves
 * room for the query and the consumer's own prompt in a typical context window.
 * The chunk ceiling exists separately because many short chunks cost attention
 * even when they are cheap in characters. Both are expected to move once real
 * query data exists.
 */
export const DEFAULT_EVIDENCE_BUDGET: EvidenceBudget = {
  maxTotalCharacters: 8000,
  maxChunks: 12,
};

/** Why a retrieved chunk did not make it into the evidence, for the audit trail. */
export interface EvidenceOmission {
  readonly chunkId: string;
  readonly chunkRevisionId: string;
  readonly reason:
    "duplicate_chunk_revision" | "duplicate_content" | "budget_exhausted";
}

/**
 * One dropped chunk with the chunk itself still attached.
 *
 * An `EvidenceOmission` identifies a chunk but does not say which Scope it came
 * from, and the caller has to know: assembly runs over every admitted Scope at
 * once, and each omission has to end up in the one item that Scope produced.
 * Re-joining afterwards by `chunkRevisionId` would be wrong precisely in the
 * deduplication case — the dropped copy belongs to a different Scope than the
 * surviving one — so the link is kept rather than reconstructed.
 */
export interface OmittedChunk {
  readonly chunk: EvidenceChunk;
  readonly reason: EvidenceOmission["reason"];
}

/**
 * The evidence assembled for one answer, and what it cost.
 *
 * Internal to this domain: it is the raw outcome of one assembly pass, not a
 * shape any consumer receives. `resolveContext` splits it per Scope into the
 * `RetrievedDocumentContext` of each item, which is what leaves the package.
 *
 * The policy version and the budget deliberately do not appear here. Both are
 * facts about the whole response rather than about this pass, and they are
 * stated once on `ResolutionPolicy`; carrying them along a second time would
 * let two copies of one unvarying fact disagree.
 *
 * `omitted` is part of the result rather than a side channel: a consumer that
 * sees only the surviving chunks cannot tell an exhaustive answer from a
 * clipped one, and that difference changes how the answer may be used.
 */
export interface AssembledEvidence {
  readonly chunks: readonly EvidenceChunk[];
  readonly omitted: readonly OmittedChunk[];
}

/** Projects an attributed omission into the record a consumer receives. */
export function toEvidenceOmission(omitted: OmittedChunk): EvidenceOmission {
  return {
    chunkId: omitted.chunk.chunkId,
    chunkRevisionId: omitted.chunk.chunkRevisionId,
    reason: omitted.reason,
  };
}

/**
 * Ranks retrieved chunks, drops repeats, and cuts the rest to the budget.
 *
 * The three steps run in a fixed order and each one is deterministic, so the
 * same chunks and the same budget always produce the same evidence. Ordering
 * matters twice over: deduplication runs before the budget, so a repeat never
 * consumes the room a distinct chunk could have used, and the budget walks the
 * ranked order without backtracking, so the evidence is always a prefix of the
 * ranking rather than whichever chunks happened to fit.
 *
 * `text.length` counts UTF-16 code units, which is only an approximation of
 * token cost — it over-counts astral characters and mis-estimates every script
 * differently. It is used anyway because it needs no tokenizer and no model
 * dependency, and the budget is a safety ceiling rather than an exact accounting.
 */
export function assembleDocumentEvidence(
  chunks: readonly EvidenceChunk[],
  budget: EvidenceBudget = DEFAULT_EVIDENCE_BUDGET,
): AssembledEvidence {
  assertUsableBudget(budget);

  // The caller's array is never reordered: ranking is an observation, not a
  // mutation of the input.
  const ranked = [...chunks].sort(compareChunks);

  const omitted: OmittedChunk[] = [];
  const distinct = dropRepeats(ranked, omitted);
  const admitted = applyBudget(distinct, budget, omitted);

  return { chunks: admitted, omitted };
}

/**
 * Keeps the first appearance of each chunk revision, then of each content
 * digest, and records every later one as an omission.
 *
 * The two checks are separate reasons because they mean different things: a
 * repeated revision is the same chunk returned twice, while a repeated digest
 * is two distinct chunks that happen to say the same thing — a heading echoed
 * across sections, say. Both waste budget, but only the second is a fact about
 * the document worth surfacing.
 *
 * "First" is first in ranked order, so the surviving copy is always the
 * highest-scoring one.
 */
function dropRepeats(
  ranked: readonly EvidenceChunk[],
  omitted: OmittedChunk[],
): readonly EvidenceChunk[] {
  const seenRevisions = new Set<string>();
  const seenDigests = new Set<string>();
  const distinct: EvidenceChunk[] = [];

  for (const chunk of ranked) {
    if (seenRevisions.has(chunk.chunkRevisionId)) {
      omitted.push(omission(chunk, "duplicate_chunk_revision"));
      continue;
    }
    if (seenDigests.has(chunk.contentDigest)) {
      omitted.push(omission(chunk, "duplicate_content"));
      continue;
    }
    seenRevisions.add(chunk.chunkRevisionId);
    seenDigests.add(chunk.contentDigest);
    distinct.push(chunk);
  }

  return distinct;
}

/**
 * Takes chunks in ranked order until one would cross either ceiling, then stops.
 *
 * A chunk is admitted whole or not at all: cutting one mid-text would hand the
 * consumer a citation whose digest no longer describes the text it received.
 * The walk also stops for good rather than skipping ahead to a smaller chunk
 * that would still fit — packing the budget that way would silently reorder the
 * evidence by size and destroy the meaning of the ranking.
 */
function applyBudget(
  distinct: readonly EvidenceChunk[],
  budget: EvidenceBudget,
  omitted: OmittedChunk[],
): readonly EvidenceChunk[] {
  const admitted: EvidenceChunk[] = [];
  let usedCharacters = 0;
  let exhausted = false;

  for (const chunk of distinct) {
    if (exhausted) {
      omitted.push(omission(chunk, "budget_exhausted"));
      continue;
    }
    // Both ceilings are inclusive: landing exactly on the limit still fits.
    const nextCharacters = usedCharacters + chunk.text.length;
    if (nextCharacters > budget.maxTotalCharacters) {
      exhausted = true;
      omitted.push(omission(chunk, "budget_exhausted"));
      continue;
    }
    if (admitted.length + 1 > budget.maxChunks) {
      exhausted = true;
      omitted.push(omission(chunk, "budget_exhausted"));
      continue;
    }
    usedCharacters = nextCharacters;
    admitted.push(chunk);
  }

  return admitted;
}

function omission(
  chunk: EvidenceChunk,
  reason: EvidenceOmission["reason"],
): OmittedChunk {
  return { chunk, reason };
}

function compareChunks(left: EvidenceChunk, right: EvidenceChunk): number {
  const leftFinite = Number.isFinite(left.score);
  const rightFinite = Number.isFinite(right.score);

  // A non-finite score always sinks to the bottom, exactly as in
  // `selection-verdict.ts`. Subtracting it would hand the comparator a NaN, and
  // a comparator that returns NaN makes the whole ordering unspecified. The
  // chunk is not thrown out: a score outside [0, 1] breaks the retriever's
  // contract, not the assembly, and evidence a consumer can still read is worth
  // more than an aborted answer.
  if (leftFinite !== rightFinite) {
    return leftFinite ? -1 : 1;
  }
  if (leftFinite && left.score !== right.score) {
    return right.score - left.score;
  }
  // chunkRevisionId ascending, compared with `<` / `>` rather than
  // `localeCompare`, which resolves against the runtime locale and would let
  // the same evidence assemble differently on two machines.
  if (left.chunkRevisionId < right.chunkRevisionId) {
    return -1;
  }
  if (left.chunkRevisionId > right.chunkRevisionId) {
    return 1;
  }
  return 0;
}

function assertUsableBudget(budget: EvidenceBudget): void {
  // Finiteness is checked before the sign, for the same reason a NaN threshold
  // is in `selection-verdict.ts`: every comparison against NaN is false, so a
  // NaN ceiling would pass a `<= 0` guard and then reject every chunk, and an
  // infinite ceiling would silently mean "no budget at all".
  if (
    !Number.isFinite(budget.maxTotalCharacters) ||
    !Number.isFinite(budget.maxChunks)
  ) {
    throw new EvidenceBudgetInvariantError(
      `budget limits must be finite, received maxTotalCharacters ${budget.maxTotalCharacters} and maxChunks ${budget.maxChunks}`,
    );
  }
  if (budget.maxTotalCharacters <= 0 || budget.maxChunks <= 0) {
    throw new EvidenceBudgetInvariantError(
      `budget limits must be greater than zero, received maxTotalCharacters ${budget.maxTotalCharacters} and maxChunks ${budget.maxChunks}`,
    );
  }
  // A fractional ceiling has no meaning for either limit: chunks are whole, and
  // a fractional character count would make the inclusive boundary untestable.
  if (
    !Number.isInteger(budget.maxTotalCharacters) ||
    !Number.isInteger(budget.maxChunks)
  ) {
    throw new EvidenceBudgetInvariantError(
      `budget limits must be integers, received maxTotalCharacters ${budget.maxTotalCharacters} and maxChunks ${budget.maxChunks}`,
    );
  }
}
