import type { ApprovedScopeReference } from "./card-catalog.js";
import { ContextBudgetInvariantError } from "./errors.js";

/** Identifies the assembly rules an evidence record was produced under. */
export const CONTEXT_ASSEMBLY_POLICY_VERSION = "context-assembly-v2" as const;

/**
 * Identifies the rule that turns per-target ranks into one order.
 *
 * Named separately from the assembly policy because the two change for
 * different reasons: fusion is about how positions combine, assembly is about
 * what happens afterwards to repeats and to the budget. A response records the
 * assembly version, and this constant is what that version's fusion step is.
 */
export const CONTEXT_FUSION_POLICY_VERSION = "rrf-v1" as const;

/**
 * The rank offset in Reciprocal Rank Fusion.
 *
 * 60 is the value the original RRF paper reports, and it is kept rather than
 * tuned because the number is doing one specific job: it flattens the top of
 * the curve so that first place is worth about 1.6% more than second rather
 * than twice as much. A small constant would let a single target's first hit
 * outrank a chunk that two targets both ranked highly, which is the exact
 * agreement fusion exists to reward.
 */
export const RRF_RANK_CONSTANT = 60;

/**
 * One chunk a completed read returned, stamped with the item it belongs to.
 *
 * A candidate rather than an outcome: the same `chunkRevisionId` can arrive
 * from several targets, so this is one occurrence of a chunk and not yet the
 * chunk's place in the answer. `rank` is that occurrence's 1-based position in
 * its own target's answer, which is the only ordering signal that survives a
 * boundary — see `ResolvedDocumentChunk`.
 */
export interface ContextCandidate {
  /** The planned item this occurrence was retrieved for. */
  readonly itemKey: string;
  readonly scopeRef: ApprovedScopeReference;
  readonly rank: number;
  readonly chunkId: string;
  readonly chunkRevisionId: string;
  readonly semanticUnitId: string;
  readonly documentId: string;
  readonly contentDigest: string;
  readonly text: string;
}

/**
 * One chunk in the answer, with the fused score that placed it there.
 *
 * `rank` narrows to the best position any target gave it, and `score` is the
 * sum of every target's reciprocal — so the two disagree on purpose whenever
 * agreement between targets outweighs a single target's ordering, which is
 * precisely what fusion is for.
 */
export interface ContextChunk extends ContextCandidate {
  readonly score: number;
}

/**
 * How much evidence one answer may carry.
 *
 * Both limits are hard ceilings, not targets: assembly stops at the first chunk
 * that would cross either one. ADR 0002 puts the budget in this domain because
 * the consumer receives whatever we assemble and has no way to renegotiate it.
 */
export interface ContextBudget {
  readonly maxTotalCharacters: number;
  readonly maxChunks: number;
}

/**
 * Starting budget.
 *
 * The character ceiling is a deliberately coarse token approximation — see
 * `assembleDocumentContext` — sized so that a full evidence set still leaves
 * room for the query and the consumer's own prompt in a typical context window.
 * The chunk ceiling exists separately because many short chunks cost attention
 * even when they are cheap in characters. Both are expected to move once real
 * query data exists.
 */
export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  maxTotalCharacters: 8000,
  maxChunks: 12,
};

/** Why a retrieved chunk did not make it into the evidence, for the audit trail. */
export interface ContextOmission {
  readonly chunkId: string;
  readonly chunkRevisionId: string;
  readonly reason:
    | "duplicate_chunk_revision"
    | "duplicate_content"
    | "budget_exhausted";
}

/**
 * One dropped occurrence with the item it was dropped from still attached.
 *
 * An `ContextOmission` identifies a chunk but does not say which item it came
 * from, and the caller has to know: assembly runs over every admitted item at
 * once, and each omission has to end up in the one item that lost something.
 * Re-joining afterwards by `chunkRevisionId` would be wrong precisely in the
 * deduplication case — the dropped copy belongs to a different item than the
 * surviving one — so the link is kept rather than reconstructed.
 */
export interface OmittedChunk {
  readonly chunk: ContextCandidate;
  readonly reason: ContextOmission["reason"];
}

/**
 * The evidence assembled for one answer, and what it cost.
 *
 * Internal to this domain: it is the raw outcome of one assembly pass, not a
 * shape any consumer receives. `assembleContext` splits it per item into the
 * `RetrievedDocumentContext` of each one, which is what leaves the package.
 *
 * The policy version and the budget deliberately do not appear here. Both are
 * facts about the whole response rather than about this pass, and they are
 * stated once on `ResolutionPolicy`; carrying them along a second time would
 * let two copies of one unvarying fact disagree.
 */
export interface AssembledContext {
  readonly chunks: readonly ContextChunk[];
  readonly omitted: readonly OmittedChunk[];
}

/** Projects an attributed omission into the record a consumer receives. */
export function toContextOmission(omitted: OmittedChunk): ContextOmission {
  return {
    chunkId: omitted.chunk.chunkId,
    chunkRevisionId: omitted.chunk.chunkRevisionId,
    reason: omitted.reason,
  };
}

/**
 * Fuses per-target ranks into one order, drops repeats, and cuts to the budget.
 *
 * The four steps run in a fixed order and each one is deterministic, so the
 * same candidates and the same budget always produce the same evidence.
 *
 * Fusion comes first because the other three depend on a single order existing.
 * Each target answers with its own 1-based ranking and nothing else — a
 * provider's similarity is not comparable across indexes, profiles or model
 * versions, so there is no shared scale to sort on. `rrf-v1` builds one:
 * `1 / (RRF_RANK_CONSTANT + rank)`, summed across every target that returned
 * the chunk. A chunk two targets both placed near the top therefore outranks a
 * chunk one target placed first, which is the only cross-target statement the
 * inputs actually support.
 *
 * Deduplication runs before the budget, so a repeat never consumes the room a
 * distinct chunk could have used, and the budget then walks the fused order
 * without backtracking, so the evidence is always a prefix of the ranking
 * rather than whichever chunks happened to fit.
 *
 * `text.length` counts UTF-16 code units, which is only an approximation of
 * token cost — it over-counts astral characters and mis-estimates every script
 * differently. It is used anyway because it needs no tokenizer and no model
 * dependency, and the budget is a safety ceiling rather than an exact accounting.
 */
export function assembleDocumentContext(
  candidates: readonly ContextCandidate[],
  budget: ContextBudget = DEFAULT_CONTEXT_BUDGET,
): AssembledContext {
  assertUsableBudget(budget);

  const omitted: OmittedChunk[] = [];
  // The caller's array is never reordered: fusion is an observation, not a
  // mutation of the input.
  const fused = fuseByChunkRevision(candidates, omitted).sort(compareChunks);
  const distinct = dropRepeatedContent(fused, omitted);
  const admitted = applyBudget(distinct, budget, omitted);

  return { chunks: admitted, omitted };
}

/**
 * Collapses every occurrence of one chunk revision into a single scored chunk.
 *
 * The surviving occurrence is the one whose target ranked it best, so the
 * chunk is attributed to the item that found it most relevant rather than to
 * whichever target happened to be executed first. A tie on rank falls back to
 * `itemKey`, which is a digest and therefore stable across machines and runs.
 *
 * The other occurrences become `duplicate_chunk_revision` omissions on their
 * own items. They are recorded rather than discarded because an item that
 * retrieved a chunk and then lost it to a better-ranked copy elsewhere has not
 * retrieved nothing, and an audit trail that said so would be wrong.
 *
 * The score is summed over every occurrence, including the omitted ones. That
 * is the point of fusion and not an oversight: the omission concerns which item
 * cites the chunk, while the score concerns how many targets agreed it matters.
 */
function fuseByChunkRevision(
  candidates: readonly ContextCandidate[],
  omitted: OmittedChunk[],
): ContextChunk[] {
  const groups = new Map<string, ContextCandidate[]>();

  for (const candidate of candidates) {
    const group = groups.get(candidate.chunkRevisionId);
    if (group === undefined) {
      groups.set(candidate.chunkRevisionId, [candidate]);
    } else {
      group.push(candidate);
    }
  }

  const fused: ContextChunk[] = [];
  for (const group of groups.values()) {
    const ordered = [...group].sort(compareOccurrences);
    const [best, ...losers] = ordered;
    if (best === undefined) {
      continue;
    }
    for (const loser of losers) {
      omitted.push({ chunk: loser, reason: "duplicate_chunk_revision" });
    }
    fused.push({
      ...best,
      score: group.reduce(
        (total, occurrence) => total + reciprocalRank(occurrence.rank),
        0,
      ),
    });
  }

  return fused;
}

/**
 * `1 / (60 + rank)`, and 0 for a rank that is not a usable position.
 *
 * A non-finite or non-positive rank contributes nothing rather than being
 * clamped to first place: an executor that reported one has broken the 1-based
 * contract, and guessing what it meant would let a malformed answer outrank a
 * well-formed one. The occurrence still travels — it may be the only copy of a
 * chunk, and evidence a consumer can read is worth more than an aborted answer.
 */
function reciprocalRank(rank: number): number {
  if (!Number.isFinite(rank) || rank < 1) {
    return 0;
  }
  return 1 / (RRF_RANK_CONSTANT + rank);
}

/**
 * Keeps the first appearance of each content digest and records every later one.
 *
 * A repeated digest is two distinct chunks that happen to say the same thing —
 * a heading echoed across sections, say. It wastes budget, and unlike a
 * repeated revision it is a fact about the documents rather than about the
 * search, which is why the two carry different reasons.
 *
 * "First" is first in fused order, so the surviving copy is always the
 * highest-scoring one.
 */
function dropRepeatedContent(
  fused: readonly ContextChunk[],
  omitted: OmittedChunk[],
): readonly ContextChunk[] {
  const seenDigests = new Set<string>();
  const distinct: ContextChunk[] = [];

  for (const chunk of fused) {
    if (seenDigests.has(chunk.contentDigest)) {
      omitted.push({ chunk, reason: "duplicate_content" });
      continue;
    }
    seenDigests.add(chunk.contentDigest);
    distinct.push(chunk);
  }

  return distinct;
}

/**
 * Takes chunks in fused order until one would cross either ceiling, then stops.
 *
 * A chunk is admitted whole or not at all: cutting one mid-text would hand the
 * consumer a citation whose digest no longer describes the text it received.
 * The walk also stops for good rather than skipping ahead to a smaller chunk
 * that would still fit — packing the budget that way would silently reorder the
 * evidence by size and destroy the meaning of the ranking.
 */
function applyBudget(
  distinct: readonly ContextChunk[],
  budget: ContextBudget,
  omitted: OmittedChunk[],
): readonly ContextChunk[] {
  const admitted: ContextChunk[] = [];
  let usedCharacters = 0;
  let exhausted = false;

  for (const chunk of distinct) {
    if (exhausted) {
      omitted.push({ chunk, reason: "budget_exhausted" });
      continue;
    }
    // Both ceilings are inclusive: landing exactly on the limit still fits.
    const nextCharacters = usedCharacters + chunk.text.length;
    if (nextCharacters > budget.maxTotalCharacters) {
      exhausted = true;
      omitted.push({ chunk, reason: "budget_exhausted" });
      continue;
    }
    if (admitted.length + 1 > budget.maxChunks) {
      exhausted = true;
      omitted.push({ chunk, reason: "budget_exhausted" });
      continue;
    }
    usedCharacters = nextCharacters;
    admitted.push(chunk);
  }

  return admitted;
}

/** Best rank first, then `itemKey` ascending. Decides which copy survives. */
function compareOccurrences(
  left: ContextCandidate,
  right: ContextCandidate,
): number {
  const leftUsable = Number.isFinite(left.rank) && left.rank >= 1;
  const rightUsable = Number.isFinite(right.rank) && right.rank >= 1;

  // An unusable rank sinks below every usable one. Subtracting a NaN would hand
  // the comparator a NaN, and a comparator that returns NaN makes the whole
  // ordering unspecified.
  if (leftUsable !== rightUsable) {
    return leftUsable ? -1 : 1;
  }
  if (leftUsable && left.rank !== right.rank) {
    return left.rank - right.rank;
  }
  return compareText(left.itemKey, right.itemKey);
}

/**
 * Higher fused score first, then `chunkRevisionId` ascending.
 *
 * The tie-break is on the revision rather than on the score's own inputs
 * because a tie means the inputs already agreed; what is left is to pick an
 * order that two machines will pick identically.
 */
function compareChunks(left: ContextChunk, right: ContextChunk): number {
  if (left.score !== right.score) {
    return right.score - left.score;
  }
  return compareText(left.chunkRevisionId, right.chunkRevisionId);
}

/**
 * `<` / `>` rather than `localeCompare`, which resolves against the runtime
 * locale and would let the same evidence assemble differently on two machines.
 */
function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

function assertUsableBudget(budget: ContextBudget): void {
  // Finiteness is checked before the sign, for the same reason a NaN threshold
  // is in `selection-verdict.ts`: every comparison against NaN is false, so a
  // NaN ceiling would pass a `<= 0` guard and then reject every chunk, and an
  // infinite ceiling would silently mean "no budget at all".
  if (
    !Number.isFinite(budget.maxTotalCharacters) ||
    !Number.isFinite(budget.maxChunks)
  ) {
    throw new ContextBudgetInvariantError(
      `budget limits must be finite, received maxTotalCharacters ${budget.maxTotalCharacters} and maxChunks ${budget.maxChunks}`,
    );
  }
  if (budget.maxTotalCharacters <= 0 || budget.maxChunks <= 0) {
    throw new ContextBudgetInvariantError(
      `budget limits must be greater than zero, received maxTotalCharacters ${budget.maxTotalCharacters} and maxChunks ${budget.maxChunks}`,
    );
  }
  // A fractional ceiling has no meaning for either limit: chunks are whole, and
  // a fractional character count would make the inclusive boundary untestable.
  if (
    !Number.isInteger(budget.maxTotalCharacters) ||
    !Number.isInteger(budget.maxChunks)
  ) {
    throw new ContextBudgetInvariantError(
      `budget limits must be integers, received maxTotalCharacters ${budget.maxTotalCharacters} and maxChunks ${budget.maxChunks}`,
    );
  }
}
