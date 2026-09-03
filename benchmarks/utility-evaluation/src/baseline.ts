import { cosineSimilarity } from "@contextctl/selection-delivery";

import type { ProductChunk, RetrievedChunk } from "./types.js";

export const RRF_RANK_CONSTANT = 60;

const BM25_K1 = 1.2;
const BM25_B = 0.75;

interface IndexedDocument {
  readonly length: number;
  readonly frequencies: ReadonlyMap<string, number>;
}

export interface HybridIndex {
  readonly chunksByRevisionId: ReadonlyMap<string, ProductChunk>;
  readonly documents: ReadonlyMap<string, IndexedDocument>;
  readonly documentFrequency: ReadonlyMap<string, number>;
  readonly averageDocumentLength: number;
  readonly documentCount: number;
}

export interface HybridRetrieval {
  readonly chunks: readonly RetrievedChunk[];
  readonly candidateCount: number;
  readonly densePrefetchCount: number;
  readonly lexicalPrefetchCount: number;
  readonly fusedCandidateCount: number;
}

export interface DenseRankingEntry {
  readonly chunkRevisionId: string;
  readonly score: number;
}

export function buildHybridIndex(
  chunks: readonly ProductChunk[],
): HybridIndex {
  if (chunks.length === 0) throw new Error("hybrid index requires chunks");
  const chunksByRevisionId = new Map<string, ProductChunk>();
  const documents = new Map<string, IndexedDocument>();
  const documentFrequency = new Map<string, number>();
  let totalLength = 0;
  for (const chunk of chunks) {
    if (chunksByRevisionId.has(chunk.chunkRevisionId)) {
      throw new Error(`duplicate chunk revision: ${chunk.chunkRevisionId}`);
    }
    const tokens = lexicalFeatures(chunk.text);
    const frequencies = frequencyMap(tokens);
    chunksByRevisionId.set(chunk.chunkRevisionId, chunk);
    documents.set(chunk.chunkRevisionId, {
      length: tokens.length,
      frequencies,
    });
    totalLength += tokens.length;
    for (const term of frequencies.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  return {
    chunksByRevisionId,
    documents,
    documentFrequency,
    averageDocumentLength: totalLength / chunks.length,
    documentCount: chunks.length,
  };
}

export function retrieveHybrid(input: {
  readonly index: HybridIndex;
  readonly chunks: readonly ProductChunk[];
  readonly query: string;
  readonly denseRanking: readonly DenseRankingEntry[];
  readonly topK: number;
  readonly prefetchK: number;
  readonly maxContextCharacters: number;
}): HybridRetrieval {
  const dense = input.denseRanking
    .map((entry) => {
      const chunk = input.index.chunksByRevisionId.get(entry.chunkRevisionId);
      if (chunk === undefined) {
        throw new Error(
          `dense ranking returned an unknown Chunk: ${entry.chunkRevisionId}`,
        );
      }
      return { chunk, score: entry.score };
    })
    .sort(compareScored)
    .slice(0, input.prefetchK);
  const terms = [...new Set(lexicalFeatures(input.query))];
  const lexical = input.chunks
    .map((chunk) => ({
      chunk,
      score: bm25Score(input.index, chunk.chunkRevisionId, terms),
    }))
    .filter((entry) => entry.score > 0)
    .sort(compareScored)
    .slice(0, input.prefetchK);

  const fused = new Map<string, number>();
  addRrf(fused, dense);
  addRrf(fused, lexical);
  const ranked = [...fused]
    .map(([chunkRevisionId, score]) => {
      const chunk = input.index.chunksByRevisionId.get(chunkRevisionId);
      if (chunk === undefined) {
        throw new Error(`hybrid index lost chunk ${chunkRevisionId}`);
      }
      return { ...chunk, score, scoreKind: "rrf" as const };
    })
    .sort(compareRetrieved);

  const chunks: RetrievedChunk[] = [];
  let characters = 0;
  for (const chunk of ranked) {
    if (chunks.length >= input.topK) break;
    if (characters + chunk.text.length > input.maxContextCharacters) continue;
    chunks.push(chunk);
    characters += chunk.text.length;
  }
  return {
    chunks,
    candidateCount: input.chunks.length,
    densePrefetchCount: dense.length,
    lexicalPrefetchCount: lexical.length,
    fusedCandidateCount: fused.size,
  };
}

export function rankDenseExact(
  chunks: readonly ProductChunk[],
  queryVector: readonly number[],
  prefetchK: number,
): readonly DenseRankingEntry[] {
  return chunks
    .map((chunk) => ({
      chunkRevisionId: chunk.chunkRevisionId,
      score: cosineSimilarity(queryVector, chunk.vector),
      chunk,
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        compareText(left.chunk.text, right.chunk.text) ||
        compareText(left.chunkRevisionId, right.chunkRevisionId),
    )
    .slice(0, prefetchK)
    .map(({ chunkRevisionId, score }) => ({ chunkRevisionId, score }));
}

export function lexicalFeatures(text: string): readonly string[] {
  const features: string[] = [];
  const normalized = text.normalize("NFKC").toLowerCase();
  for (const match of normalized.matchAll(/[\p{L}\p{N}]+/gu)) {
    const token = match[0];
    if (token === "") continue;
    features.push(`word:${token}`);
    for (const size of [2, 3] as const) {
      if (token.length < size) continue;
      for (let index = 0; index <= token.length - size; index += 1) {
        features.push(`char${String(size)}:${token.slice(index, index + size)}`);
      }
    }
  }
  return features;
}

function bm25Score(
  index: HybridIndex,
  chunkRevisionId: string,
  terms: readonly string[],
): number {
  const document = index.documents.get(chunkRevisionId);
  if (document === undefined || document.length === 0) return 0;
  let score = 0;
  for (const term of terms) {
    const frequency = document.frequencies.get(term) ?? 0;
    if (frequency === 0) continue;
    const matching = index.documentFrequency.get(term) ?? 0;
    const idf = Math.log(
      1 + (index.documentCount - matching + 0.5) / (matching + 0.5),
    );
    const denominator =
      frequency +
      BM25_K1 *
        (1 -
          BM25_B +
          BM25_B * (document.length / index.averageDocumentLength));
    score += idf * ((frequency * (BM25_K1 + 1)) / denominator);
  }
  return score;
}

function addRrf(
  target: Map<string, number>,
  ranking: readonly { readonly chunk: ProductChunk }[],
): void {
  for (const [index, entry] of ranking.entries()) {
    const key = entry.chunk.chunkRevisionId;
    target.set(
      key,
      (target.get(key) ?? 0) + 1 / (RRF_RANK_CONSTANT + index + 1),
    );
  }
}

function frequencyMap(values: readonly string[]): ReadonlyMap<string, number> {
  const result = new Map<string, number>();
  for (const value of values) {
    result.set(value, (result.get(value) ?? 0) + 1);
  }
  return result;
}

function compareScored(
  left: { readonly chunk: ProductChunk; readonly score: number },
  right: { readonly chunk: ProductChunk; readonly score: number },
): number {
  return (
    right.score - left.score ||
    compareText(left.chunk.text, right.chunk.text) ||
    compareText(left.chunk.chunkRevisionId, right.chunk.chunkRevisionId)
  );
}

function compareRetrieved(
  left: RetrievedChunk,
  right: RetrievedChunk,
): number {
  return (
    right.score - left.score ||
    compareText(left.text, right.text) ||
    compareText(left.chunkRevisionId, right.chunkRevisionId)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
