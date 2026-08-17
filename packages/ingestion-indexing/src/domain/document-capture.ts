import { createHash } from "node:crypto";

import {
  assertValidNormalizedDocument,
  type BlockStructure,
  type DocumentBlock,
  type NormalizedDocument,
  type ParserDiagnostic,
  type TextSourceSpan,
} from "./document-model.js";
import {
  DEFAULT_LINEAGE_POLICY,
  LINEAGE_POLICY_VERSION,
} from "./document-indexing-policy.js";

export const MARKDOWN_NORMALIZATION_POLICY_VERSION = "document-normalization-v1";
export const BLOCK_LINEAGE_POLICY_VERSION = LINEAGE_POLICY_VERSION;

export interface CandidateDocument {
  readonly title?: string;
  readonly completeness: "complete" | "partial";
  readonly diagnostics: readonly ParserDiagnostic[];
  readonly coverage: readonly CandidateSourceCoverage[];
  readonly blocks: readonly CandidateDocumentBlock[];
}

export type CandidateSourceCoverage =
  | {
      readonly status: "accepted";
      readonly sourceSpan: TextSourceSpan;
    }
  | {
      readonly status: "omitted";
      readonly sourceSpan: TextSourceSpan;
      readonly diagnosticCode: string;
    };

export interface CandidateDocumentBlock {
  readonly kind: DocumentBlock["kind"];
  readonly parentIndex?: number;
  readonly sectionPath: readonly number[];
  readonly text: string;
  readonly sourceSpan: TextSourceSpan;
  readonly structure: BlockStructure;
}

export interface BlockIdSource {
  nextBlockId(): string;
}

export interface AssembleDocumentInput {
  readonly sourceId: string;
  readonly observationId: string;
  readonly documentId: string;
  readonly parser: {
    readonly id: string;
    readonly version: string;
  };
  readonly canonicalText: string;
  readonly candidate: CandidateDocument;
  readonly ids: BlockIdSource;
  readonly previousDocument?: NormalizedDocument;
}

export function assembleNormalizedMarkdownDocument(
  input: AssembleDocumentInput,
): NormalizedDocument {
  assertCandidateDocument(input.candidate, input.canonicalText);
  assertPreviousDocument(input);

  const prepared = input.candidate.blocks.map((candidate, index) => ({
    candidate,
    index,
    analysisText: toAnalysisText(candidate.text),
    contentDigest: sha256Digest(candidate.text),
  }));
  const matchedIds = matchBlockIds(prepared, input.previousDocument);
  const previousIds = new Set(
    input.previousDocument?.blocks.map((block) => block.id) ?? [],
  );
  const allocatedIds = new Set<string>();
  const blockIds = prepared.map(({ index }) => {
    const matched = matchedIds.get(index);
    if (matched !== undefined) {
      allocatedIds.add(matched);
      return matched;
    }
    const generated = nextAvailableBlockId(
      input.ids,
      allocatedIds,
      previousIds,
    );
    allocatedIds.add(generated);
    return generated;
  });

  const blocks = prepared.map(
    ({ candidate, index, analysisText, contentDigest }): DocumentBlock => {
      const id = requiredAt(blockIds, index);
      const sectionPath = candidate.sectionPath.map((headingIndex) =>
        requiredAt(blockIds, headingIndex),
      );
      const parentBlockId =
        candidate.parentIndex === undefined
          ? undefined
          : requiredAt(blockIds, candidate.parentIndex);
      /**
       * Logical identity, canonical content and structural containment only.
       * `order` and `sourceSpan` describe where the Block sits in this
       * Observation, so including them would give every Block after an edit a
       * new revision even when its content is byte-identical. Containment is
       * already carried by `sectionPath` and `parentBlockId`, which are stable
       * Block IDs rather than positions.
       */
      const revisionInput = {
        id,
        kind: candidate.kind,
        ...(parentBlockId === undefined ? {} : { parentBlockId }),
        sectionPath,
        text: candidate.text,
        analysisText,
        contentDigest,
        structure: candidate.structure,
        normalizationPolicyVersion: MARKDOWN_NORMALIZATION_POLICY_VERSION,
        lineagePolicyVersion: BLOCK_LINEAGE_POLICY_VERSION,
      };
      return {
        id,
        revisionId: revisionId("brv", revisionInput),
        kind: candidate.kind,
        order: index,
        ...(parentBlockId === undefined ? {} : { parentBlockId }),
        sectionPath,
        text: candidate.text,
        analysisText,
        contentDigest,
        sourceSpan: candidate.sourceSpan,
        structure: candidate.structure,
      } as DocumentBlock;
    },
  );

  const document: NormalizedDocument = {
    schemaVersion: 1,
    documentId: input.documentId,
    sourceId: input.sourceId,
    observationId: input.observationId,
    mediaType: "text/markdown",
    ...(input.candidate.title === undefined
      ? {}
      : { title: input.candidate.title }),
    parser: input.parser,
    normalizationPolicyVersion: MARKDOWN_NORMALIZATION_POLICY_VERSION,
    lineagePolicyVersion: BLOCK_LINEAGE_POLICY_VERSION,
    contentDigest: sha256Digest(input.canonicalText),
    completeness: {
      status: input.candidate.completeness,
      diagnostics: input.candidate.diagnostics,
    },
    blocks,
  };
  assertValidNormalizedDocument(document);
  return document;
}

export function canonicalizeDocumentText(input: string): string {
  const withoutBom = input.startsWith("\uFEFF") ? input.slice(1) : input;
  return withoutBom.replaceAll("\r\n", "\n").replaceAll("\r", "\n").normalize("NFC");
}

export function toAnalysisText(input: string): string {
  return input.normalize("NFKC").toLocaleLowerCase("und").replaceAll(/\s+/g, " ").trim();
}

export function sha256Digest(input: string): string {
  return `sha256:${createHash("sha256").update(input, "utf8").digest("hex")}`;
}

export class DocumentCaptureError extends Error {
  constructor(
    readonly code:
      | "duplicate_block_id"
      | "invalid_block_id"
      | "invalid_candidate"
      | "invalid_previous_document"
      | "unsupported_document",
    readonly diagnostics: readonly ParserDiagnostic[] = [],
  ) {
    super(`Document capture failed: ${code}`);
    this.name = "DocumentCaptureError";
  }
}

interface PreparedCandidate {
  readonly candidate: CandidateDocumentBlock;
  readonly index: number;
  readonly analysisText: string;
  readonly contentDigest: string;
}

function matchBlockIds(
  candidates: readonly PreparedCandidate[],
  previousDocument: NormalizedDocument | undefined,
): ReadonlyMap<number, string> {
  if (
    previousDocument === undefined ||
    previousDocument.mediaType !== "text/markdown" ||
    previousDocument.normalizationPolicyVersion !==
      MARKDOWN_NORMALIZATION_POLICY_VERSION ||
    previousDocument.lineagePolicyVersion !== BLOCK_LINEAGE_POLICY_VERSION
  ) {
    return new Map();
  }

  const matches = new Map<number, string>();
  const usedPreviousIds = new Set<string>();
  matchUnique(
    candidates,
    previousDocument.blocks,
    matches,
    usedPreviousIds,
    (candidate) =>
      `${candidate.candidate.kind}|${candidate.contentDigest}|${candidateSectionSignature(
        candidate,
        candidates,
      )}`,
    (block) =>
      `${block.kind}|${block.contentDigest}|${previousSectionSignature(
        block,
        previousDocument,
      )}`,
  );
  matchUnique(
    candidates,
    previousDocument.blocks,
    matches,
    usedPreviousIds,
    (candidate) => `${candidate.candidate.kind}|${candidate.contentDigest}`,
    (block) => `${block.kind}|${block.contentDigest}`,
  );
  matchPatienceSequence(
    candidates,
    previousDocument.blocks,
    matches,
    usedPreviousIds,
  );
  matchFuzzy(candidates, previousDocument.blocks, matches, usedPreviousIds);
  matchHeadingsByAnchoredContent(
    candidates,
    previousDocument.blocks,
    matches,
    usedPreviousIds,
  );
  matchAnchoredReplacements(
    candidates,
    previousDocument.blocks,
    matches,
    usedPreviousIds,
  );
  return matches;
}

/**
 * A conservative final Patience-Diff gap rule. When two stable anchors (or a
 * document edge and one anchor) enclose exactly one unmatched Block of the
 * same kind on each side, the pair is one logical replacement. Larger or
 * anchorless gaps remain deliberately unresolved instead of guessing.
 */
function matchAnchoredReplacements(
  candidates: readonly PreparedCandidate[],
  previousBlocks: readonly DocumentBlock[],
  matches: Map<number, string>,
  usedPreviousIds: Set<string>,
): void {
  const previousIndexById = new Map(
    previousBlocks.map((block, index) => [block.id, index]),
  );
  const anchors = [...matches]
    .flatMap(([candidateIndex, previousId]) => {
      const previousIndex = previousIndexById.get(previousId);
      return previousIndex === undefined
        ? []
        : [{ candidateIndex, previousIndex }];
    })
    .sort((left, right) => left.candidateIndex - right.candidateIndex);
  if (anchors.length === 0) {
    return;
  }

  const boundaries = [
    { candidateIndex: -1, previousIndex: -1 },
    ...anchors,
    {
      candidateIndex: candidates.length,
      previousIndex: previousBlocks.length,
    },
  ];
  for (let index = 1; index < boundaries.length; index += 1) {
    const left = boundaries[index - 1];
    const right = boundaries[index];
    if (
      left === undefined ||
      right === undefined ||
      left.previousIndex >= right.previousIndex
    ) {
      continue;
    }
    const currentGap = candidates.filter(
      (candidate) =>
        candidate.index > left.candidateIndex &&
        candidate.index < right.candidateIndex &&
        !matches.has(candidate.index),
    );
    const previousGap = previousBlocks.filter(
      (block, previousIndex) =>
        previousIndex > left.previousIndex &&
        previousIndex < right.previousIndex &&
        !usedPreviousIds.has(block.id),
    );
    const current = currentGap[0];
    const previous = previousGap[0];
    if (
      currentGap.length !== 1 ||
      previousGap.length !== 1 ||
      current === undefined ||
      previous === undefined ||
      current.candidate.kind !== previous.kind
    ) {
      continue;
    }
    matches.set(current.index, previous.id);
    usedPreviousIds.add(previous.id);
  }
}

function matchPatienceSequence(
  candidates: readonly PreparedCandidate[],
  previousBlocks: readonly DocumentBlock[],
  matches: Map<number, string>,
  usedPreviousIds: Set<string>,
): void {
  const availableCandidates = candidates.filter(
    ({ index }) => !matches.has(index),
  );
  const availablePrevious = previousBlocks.filter(
    ({ id }) => !usedPreviousIds.has(id),
  );
  const candidateGroups = groupBy(availableCandidates, candidateAnalysisKey);
  const previousGroups = groupBy(availablePrevious, previousAnalysisKey);
  const previousIndexes = new Map(
    previousBlocks.map((block, index) => [block.id, index]),
  );
  const pairs = [...candidateGroups]
    .flatMap(([key, candidateGroup]) => {
      const previousGroup = previousGroups.get(key);
      const candidate = candidateGroup[0];
      const previous = previousGroup?.[0];
      if (
        candidateGroup.length !== 1 ||
        previousGroup?.length !== 1 ||
        candidate === undefined ||
        previous === undefined
      ) {
        return [];
      }
      const previousIndex = previousIndexes.get(previous.id);
      return previousIndex === undefined
        ? []
        : [{ candidate, previous, previousIndex }];
    })
    .sort(
      (left, right) =>
        left.candidate.index - right.candidate.index ||
        left.previousIndex - right.previousIndex,
    );

  for (const pair of longestIncreasingPairs(pairs)) {
    matches.set(pair.candidate.index, pair.previous.id);
    usedPreviousIds.add(pair.previous.id);
  }
}

function candidateAnalysisKey(candidate: PreparedCandidate): string {
  return `${candidate.candidate.kind}|${sha256Digest(candidate.analysisText)}`;
}

function previousAnalysisKey(block: DocumentBlock): string {
  return `${block.kind}|${sha256Digest(block.analysisText)}`;
}

interface SequencePair {
  readonly candidate: PreparedCandidate;
  readonly previous: DocumentBlock;
  readonly previousIndex: number;
}

function longestIncreasingPairs(
  pairs: readonly SequencePair[],
): readonly SequencePair[] {
  if (pairs.length === 0) {
    return [];
  }
  const tails: number[] = [];
  const predecessors = pairs.map(() => -1);
  for (let pairIndex = 0; pairIndex < pairs.length; pairIndex += 1) {
    const pair = pairs[pairIndex];
    if (pair === undefined) {
      continue;
    }
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const tail = pairs[tails[middle] ?? -1];
      if (tail !== undefined && tail.previousIndex < pair.previousIndex) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    if (low > 0) {
      predecessors[pairIndex] = tails[low - 1] ?? -1;
    }
    tails[low] = pairIndex;
  }

  const selected: SequencePair[] = [];
  let pairIndex = tails.at(-1) ?? -1;
  while (pairIndex >= 0) {
    const pair = pairs[pairIndex];
    if (pair === undefined) {
      break;
    }
    selected.push(pair);
    pairIndex = predecessors[pairIndex] ?? -1;
  }
  return selected.reverse();
}

function matchHeadingsByAnchoredContent(
  candidates: readonly PreparedCandidate[],
  previousBlocks: readonly DocumentBlock[],
  matches: Map<number, string>,
  usedPreviousIds: Set<string>,
): void {
  const previousIndexById = new Map(
    previousBlocks.map((block, index) => [block.id, index]),
  );
  const proposals = new Map<string, number[]>();

  for (const candidate of candidates) {
    if (
      candidate.candidate.kind !== "heading" ||
      candidate.candidate.structure.kind !== "heading" ||
      matches.has(candidate.index)
    ) {
      continue;
    }
    const headingLevel = candidate.candidate.structure.level;
    const anchor = findSectionAnchor(
      candidate.index,
      headingLevel,
      candidates,
      matches,
    );
    const anchorId = anchor === undefined ? undefined : matches.get(anchor.index);
    const previousAnchorIndex =
      anchorId === undefined ? undefined : previousIndexById.get(anchorId);
    if (previousAnchorIndex === undefined) {
      continue;
    }
    const previousHeading = [...previousBlocks]
      .slice(0, previousAnchorIndex)
      .reverse()
      .find(
        (block) =>
          block.kind === "heading" &&
          block.structure.kind === "heading" &&
          block.structure.level === headingLevel &&
          !usedPreviousIds.has(block.id),
      );
    if (previousHeading === undefined) {
      continue;
    }
    const candidatesForPrevious = proposals.get(previousHeading.id) ?? [];
    candidatesForPrevious.push(candidate.index);
    proposals.set(previousHeading.id, candidatesForPrevious);
  }

  for (const [previousId, candidateIndexes] of proposals) {
    if (candidateIndexes.length !== 1) {
      continue;
    }
    const candidateIndex = candidateIndexes[0];
    if (candidateIndex === undefined || matches.has(candidateIndex)) {
      continue;
    }
    matches.set(candidateIndex, previousId);
    usedPreviousIds.add(previousId);
  }
}

function findSectionAnchor(
  headingIndex: number,
  headingLevel: number,
  candidates: readonly PreparedCandidate[],
  matches: ReadonlyMap<number, string>,
): PreparedCandidate | undefined {
  for (let index = headingIndex + 1; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (candidate === undefined) {
      return undefined;
    }
    if (
      candidate.candidate.structure.kind === "heading" &&
      candidate.candidate.structure.level <= headingLevel
    ) {
      return undefined;
    }
    if (
      candidate.candidate.kind !== "heading" &&
      matches.has(candidate.index)
    ) {
      return candidate;
    }
  }
  return undefined;
}

function matchUnique(
  candidates: readonly PreparedCandidate[],
  previousBlocks: readonly DocumentBlock[],
  matches: Map<number, string>,
  usedPreviousIds: Set<string>,
  candidateKey: (candidate: PreparedCandidate) => string,
  previousKey: (block: DocumentBlock) => string,
): void {
  const candidateGroups = groupBy(
    candidates.filter(({ index }) => !matches.has(index)),
    candidateKey,
  );
  const previousGroups = groupBy(
    previousBlocks.filter(({ id }) => !usedPreviousIds.has(id)),
    previousKey,
  );
  for (const [key, candidateGroup] of candidateGroups) {
    const previousGroup = previousGroups.get(key);
    if (candidateGroup.length !== 1 || previousGroup?.length !== 1) {
      continue;
    }
    const candidate = candidateGroup[0];
    const previous = previousGroup[0];
    if (candidate === undefined || previous === undefined) {
      continue;
    }
    matches.set(candidate.index, previous.id);
    usedPreviousIds.add(previous.id);
  }
}

function matchFuzzy(
  candidates: readonly PreparedCandidate[],
  previousBlocks: readonly DocumentBlock[],
  matches: Map<number, string>,
  usedPreviousIds: Set<string>,
): void {
  const unmatchedCandidates = candidates.filter(
    (candidate) =>
      !matches.has(candidate.index) && candidate.analysisText.length > 0,
  );
  const availablePrevious = previousBlocks.filter(
    (previous) =>
      !usedPreviousIds.has(previous.id) && previous.analysisText.length > 0,
  );
  const proposals = unmatchedCandidates.flatMap((candidate) => {
    const scored = availablePrevious
      .filter((previous) => previous.kind === candidate.candidate.kind)
      .map((previous) => ({
        previous,
        score: tokenJaccard(candidate.analysisText, previous.analysisText),
      }))
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.previous.id.localeCompare(right.previous.id),
      );
    const best = scored[0];
    const second = scored[1];
    return best !== undefined &&
      best.score >= DEFAULT_LINEAGE_POLICY.blockMinTokenJaccard &&
      best.score - (second?.score ?? 0) >=
        DEFAULT_LINEAGE_POLICY.blockMinRunnerUpMargin
      ? [{ candidate, previous: best.previous, score: best.score }]
      : [];
  });

  for (const proposal of proposals) {
    const competingCandidates = unmatchedCandidates
      .filter(
        (candidate) =>
          candidate.candidate.kind === proposal.previous.kind,
      )
      .map((candidate) => ({
        candidate,
        score: tokenJaccard(
          candidate.analysisText,
          proposal.previous.analysisText,
        ),
      }))
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.candidate.index - right.candidate.index,
      );
    const best = competingCandidates[0];
    const second = competingCandidates[1];
    if (
      best?.candidate.index !== proposal.candidate.index ||
      proposal.score - (second?.score ?? 0) <
        DEFAULT_LINEAGE_POLICY.blockMinRunnerUpMargin
    ) {
      continue;
    }
    matches.set(proposal.candidate.index, proposal.previous.id);
    usedPreviousIds.add(proposal.previous.id);
  }
}

function candidateSectionSignature(
  candidate: PreparedCandidate,
  candidates: readonly PreparedCandidate[],
): string {
  return candidate.candidate.sectionPath
    .map((index) => requiredAt(candidates, index).contentDigest)
    .join("/");
}

function previousSectionSignature(
  block: DocumentBlock,
  document: NormalizedDocument,
): string {
  const byId = new Map(document.blocks.map((candidate) => [candidate.id, candidate]));
  return block.sectionPath
    .map((id) => byId.get(id)?.contentDigest ?? "missing")
    .join("/");
}

function tokenJaccard(left: string, right: string): number {
  const leftTokens = new Set(left.split(/\s+/u).filter(Boolean));
  const rightTokens = new Set(right.split(/\s+/u).filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  }
  return intersection / (leftTokens.size + rightTokens.size - intersection);
}

function revisionId(prefix: string, value: unknown): string {
  const digest = createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest();
  return `${prefix}_${toBase32(digest)}`;
}

function nextAvailableBlockId(
  ids: BlockIdSource,
  allocatedIds: ReadonlySet<string>,
  previousIds: ReadonlySet<string>,
): string {
  for (let attempt = 0; attempt < 1_024; attempt += 1) {
    const generated = ids.nextBlockId();
    if (!/^blk_[a-z0-9]+(?:[a-z0-9_-]*[a-z0-9])?$/.test(generated)) {
      throw new DocumentCaptureError("invalid_block_id");
    }
    if (!allocatedIds.has(generated) && !previousIds.has(generated)) {
      return generated;
    }
  }
  throw new DocumentCaptureError("duplicate_block_id");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function toBase32(input: Uint8Array): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let output = "";
  let bits = 0;
  let value = 0;
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += alphabet[(value << (5 - bits)) & 31];
  }
  return output;
}

function assertCandidateDocument(
  candidate: CandidateDocument,
  canonicalText: string,
): void {
  candidate.blocks.forEach((block, index) => {
    const referencedHeadingsAreValid = block.sectionPath.every(
      (headingIndex) =>
        Number.isSafeInteger(headingIndex) &&
        headingIndex >= 0 &&
        headingIndex <= index &&
        candidate.blocks[headingIndex]?.kind === "heading" &&
        (headingIndex < index || block.kind === "heading"),
    );
    if (
      block.kind !== block.structure.kind ||
      block.sourceSpan.kind !== "text" ||
      block.sourceSpan.endOffset > canonicalText.length ||
      (block.text.length > 0 &&
        block.sourceSpan.endOffset === block.sourceSpan.startOffset) ||
      !referencedHeadingsAreValid ||
      (block.kind === "heading" &&
        block.sectionPath.at(-1) !== index) ||
      (block.parentIndex !== undefined &&
        (!Number.isSafeInteger(block.parentIndex) ||
          block.parentIndex < 0 ||
          block.parentIndex >= index))
    ) {
      throw new DocumentCaptureError("invalid_candidate");
    }
  });
  assertCandidateCoverage(candidate, canonicalText);
}

function assertCandidateCoverage(
  candidate: CandidateDocument,
  canonicalText: string,
): void {
  let coveredUntil = 0;
  for (const entry of candidate.coverage) {
    const span = entry.sourceSpan;
    if (
      span.kind !== "text" ||
      span.startOffset < coveredUntil ||
      span.endOffset > canonicalText.length ||
      span.endOffset <= span.startOffset ||
      canonicalText.slice(coveredUntil, span.startOffset).trim().length > 0
    ) {
      throw new DocumentCaptureError("invalid_candidate");
    }

    if (entry.status === "accepted") {
      const hasBlock = candidate.blocks.some(
        (block) =>
          block.sourceSpan.startOffset >= span.startOffset &&
          block.sourceSpan.endOffset <= span.endOffset,
      );
      if (!hasBlock) {
        throw new DocumentCaptureError("invalid_candidate");
      }
    } else {
      const hasDiagnostic = candidate.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === entry.diagnosticCode &&
          diagnostic.sourceSpan?.kind === "text" &&
          diagnostic.sourceSpan.startOffset === span.startOffset &&
          diagnostic.sourceSpan.endOffset === span.endOffset,
      );
      if (!hasDiagnostic || candidate.completeness !== "partial") {
        throw new DocumentCaptureError("invalid_candidate");
      }
    }
    coveredUntil = span.endOffset;
  }

  if (
    canonicalText.slice(coveredUntil).trim().length > 0 ||
    (candidate.completeness === "complete" &&
      candidate.diagnostics.length > 0)
  ) {
    throw new DocumentCaptureError("invalid_candidate");
  }
}

function assertPreviousDocument(input: AssembleDocumentInput): void {
  const previous = input.previousDocument;
  if (
    previous !== undefined &&
    (previous.sourceId !== input.sourceId ||
      previous.documentId !== input.documentId)
  ) {
    throw new DocumentCaptureError("invalid_previous_document");
  }
}

function groupBy<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [value]);
    } else {
      group.push(value);
    }
  }
  return groups;
}

function requiredAt<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) {
    throw new DocumentCaptureError("invalid_candidate");
  }
  return value;
}
