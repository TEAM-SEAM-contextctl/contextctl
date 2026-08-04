import { type DocumentBlock } from "./document-model.js";
import {
  measureText,
  type SegmentationPolicy,
  type TextMeasureProfile,
} from "./document-indexing-policy.js";

const WORD_SEGMENTER = new Intl.Segmenter("und", { granularity: "word" });

export interface LexicalBoundary {
  readonly gap: number;
  readonly strength: number;
}

/** Finds robust TextTiling-style valleys between paragraph-like Blocks. */
export function findLexicalBoundaries(
  blocks: readonly DocumentBlock[],
  policy: SegmentationPolicy,
  profile: TextMeasureProfile,
): readonly LexicalBoundary[] {
  const paragraphIndex = indexParagraphBlocks(blocks);
  const tokenPrefix = cumulativeTokenCounts(blocks, profile);
  const scored: Array<{ gap: number; similarity: number }> = [];
  for (let gap = 1; gap < blocks.length; gap += 1) {
    const beforeOrdinal = paragraphIndex.ordinalByBlockIndex[gap - 1];
    const afterOrdinal = paragraphIndex.ordinalByBlockIndex[gap];
    if (
      beforeOrdinal === undefined ||
      afterOrdinal === undefined ||
      afterOrdinal !== beforeOrdinal + 1
    ) {
      continue;
    }
    const left = paragraphIndex.blocks.slice(
      Math.max(0, beforeOrdinal - policy.lexicalWindowBlocks + 1),
      beforeOrdinal + 1,
    );
    const right = paragraphIndex.blocks.slice(
      afterOrdinal,
      afterOrdinal + policy.lexicalWindowBlocks,
    );
    scored.push({ gap, similarity: lexicalSimilarity(left, right) });
  }
  if (scored.length < 3) {
    return [];
  }

  const depths = calculateDepths(scored);
  const center = median(depths);
  const deviation = median(depths.map((depth) => Math.abs(depth - center)));
  const threshold =
    deviation === 0
      ? policy.zeroMadMinDepth
      : center + policy.boundaryMadMultiplier * deviation;

  const accepted: LexicalBoundary[] = [];
  let segmentStart = 0;
  for (const [index, score] of scored.entries()) {
    const depth = requiredAt(depths, index);
    if (depth < threshold) {
      continue;
    }
    const leftTokens = tokenCountBetween(tokenPrefix, segmentStart, score.gap);
    const rightTokens = tokenCountBetween(tokenPrefix, score.gap, blocks.length);
    if (
      leftTokens < policy.minUnitTokens ||
      rightTokens < policy.minUnitTokens
    ) {
      continue;
    }
    accepted.push({ gap: score.gap, strength: clamp01(depth) });
    segmentStart = score.gap;
  }
  return accepted;
}

interface ParagraphBlockIndex {
  readonly blocks: readonly IndexedParagraphBlock[];
  readonly ordinalByBlockIndex: readonly (number | undefined)[];
}

interface IndexedParagraphBlock {
  readonly block: DocumentBlock;
  readonly wordTerms: readonly string[];
}

function indexParagraphBlocks(
  blocks: readonly DocumentBlock[],
): ParagraphBlockIndex {
  const paragraphBlocks: IndexedParagraphBlock[] = [];
  const ordinalByBlockIndex: Array<number | undefined> = Array.from({
    length: blocks.length,
  });
  for (const [blockIndex, block] of blocks.entries()) {
    if (!isParagraphLike(block)) {
      continue;
    }
    ordinalByBlockIndex[blockIndex] = paragraphBlocks.length;
    paragraphBlocks.push({ block, wordTerms: wordTerms(block.analysisText) });
  }
  return { blocks: paragraphBlocks, ordinalByBlockIndex };
}

function calculateDepths(
  scored: readonly { readonly similarity: number }[],
): readonly number[] {
  const leftPeaks: number[] = [];
  let leftPeak = Number.NEGATIVE_INFINITY;
  for (const score of scored) {
    leftPeak = Math.max(leftPeak, score.similarity);
    leftPeaks.push(leftPeak);
  }

  const rightPeaks = new Array<number>(scored.length);
  let rightPeak = Number.NEGATIVE_INFINITY;
  for (let index = scored.length - 1; index >= 0; index -= 1) {
    rightPeak = Math.max(rightPeak, requiredAt(scored, index).similarity);
    rightPeaks[index] = rightPeak;
  }

  return scored.map((score, index) => {
    const peakSum =
      requiredAt(leftPeaks, index) + requiredAt(rightPeaks, index);
    return (peakSum - 2 * score.similarity) / 2;
  });
}

function isParagraphLike(block: DocumentBlock): boolean {
  return (
    block.kind === "paragraph" ||
    block.kind === "quote" ||
    block.kind === "list_item"
  );
}

function lexicalSimilarity(
  left: readonly IndexedParagraphBlock[],
  right: readonly IndexedParagraphBlock[],
): number {
  const leftWords = left.flatMap((indexed) => indexed.wordTerms);
  const rightWords = right.flatMap((indexed) => indexed.wordTerms);
  if (leftWords.length < 8 || rightWords.length < 8) {
    const leftText = left.map((indexed) => indexed.block.analysisText).join(" ");
    const rightText = right.map((indexed) => indexed.block.analysisText).join(" ");
    return cosineSimilarity(characterNgrams(leftText), characterNgrams(rightText));
  }
  return cosineSimilarity(leftWords, rightWords);
}

function wordTerms(text: string): readonly string[] {
  const terms: string[] = [];
  for (const part of WORD_SEGMENTER.segment(text)) {
    if (part.isWordLike) {
      terms.push(part.segment.normalize("NFKC").toLocaleLowerCase("und"));
    }
  }
  return terms;
}

function characterNgrams(text: string): readonly string[] {
  const characters = Array.from(
    text.normalize("NFKC").toLocaleLowerCase("und").replaceAll(/\s+/gu, ""),
  );
  if (characters.length === 0) {
    return [];
  }
  if (characters.length < 3) {
    return [characters.join("")];
  }
  const grams: string[] = [];
  for (let index = 0; index <= characters.length - 3; index += 1) {
    grams.push(characters.slice(index, index + 3).join(""));
  }
  return grams;
}

function cosineSimilarity(
  leftTerms: readonly string[],
  rightTerms: readonly string[],
): number {
  if (leftTerms.length === 0 || rightTerms.length === 0) {
    return 0;
  }
  const left = frequencies(leftTerms);
  const right = frequencies(rightTerms);
  let dot = 0;
  for (const [term, frequency] of left) {
    dot += frequency * (right.get(term) ?? 0);
  }
  const leftNorm = Math.sqrt(
    [...left.values()].reduce((sum, frequency) => sum + frequency ** 2, 0),
  );
  const rightNorm = Math.sqrt(
    [...right.values()].reduce((sum, frequency) => sum + frequency ** 2, 0),
  );
  return leftNorm === 0 || rightNorm === 0 ? 0 : dot / (leftNorm * rightNorm);
}

function frequencies(terms: readonly string[]): ReadonlyMap<string, number> {
  const result = new Map<string, number>();
  for (const term of terms) {
    result.set(term, (result.get(term) ?? 0) + 1);
  }
  return result;
}

function cumulativeTokenCounts(
  blocks: readonly DocumentBlock[],
  profile: TextMeasureProfile,
): readonly number[] {
  const prefix = [0];
  for (const block of blocks) {
    prefix.push(
      requiredAt(prefix, prefix.length - 1) +
        measureText(block.analysisText, profile),
    );
  }
  return prefix;
}

function tokenCountBetween(
  prefix: readonly number[],
  start: number,
  end: number,
): number {
  return requiredAt(prefix, end) - requiredAt(prefix, start);
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted[middle];
  if (value === undefined) {
    return 0;
  }
  if (sorted.length % 2 === 1) {
    return value;
  }
  return (requiredAt(sorted, middle - 1) + value) / 2;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function requiredAt<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) {
    throw new RangeError("lexical cohesion index is out of range");
  }
  return value;
}
