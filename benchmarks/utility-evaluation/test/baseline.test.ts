import { describe, expect, it } from "vitest";

import {
  buildHybridIndex,
  lexicalFeatures,
  rankDenseExact,
  retrieveHybrid,
} from "../src/baseline.js";
import type { ProductChunk } from "../src/types.js";

const chunks: readonly ProductChunk[] = [
  chunk("a", "alpha common" , [1, 0]),
  chunk("b", "beta common", [0, 1]),
  chunk("c", "gamma rare", [0.8, 0.2]),
];

describe("global Hybrid RAG baseline", () => {
  it("uses deterministic lexical features", () => {
    expect(lexicalFeatures("결제 A1")).toEqual(lexicalFeatures("결제 A1"));
    expect(lexicalFeatures("결제")).toContain("char2:결제");
  });

  it("fuses dense and global BM25 ranks deterministically", () => {
    const index = buildHybridIndex(chunks);
    const input = {
      index,
      chunks,
      query: "rare",
      denseRanking: rankDenseExact(chunks, [1, 0], 3),
      topK: 3,
      prefetchK: 3,
      maxContextCharacters: 1_000,
    };
    const first = retrieveHybrid(input);
    const second = retrieveHybrid(input);
    expect(first).toEqual(second);
    expect(first.chunks.map((entry) => entry.chunkRevisionId)).toEqual([
      "c",
      "a",
      "b",
    ]);
    expect(first.candidateCount).toBe(3);
  });
});

function chunk(
  id: string,
  text: string,
  vector: readonly number[],
): ProductChunk {
  return {
    chunkId: `chunk-${id}`,
    chunkRevisionId: id,
    semanticUnitId: `unit-${id}`,
    documentId: `document-${id}`,
    text,
    vector,
  };
}
