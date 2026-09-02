import { describe, expect, it } from "vitest";

import { observePath, percentile } from "../src/metrics.js";
import type { ProductChunk, RetrievedChunk } from "../src/types.js";

const allChunks: readonly ProductChunk[] = [
  chunk("relevant", "정답 사실과 기준 문구"),
  chunk("noise", "관련 없는 문맥"),
];

describe("utility evaluation metrics", () => {
  it("measures evidence coverage separately from returned context size", () => {
    const observation = observePath({
      path: "hybrid_rag",
      fixture: {
        id: "q",
        category: "test",
        query: "질문",
        expectedAnswerable: true,
        requiredFacts: ["정답 사실"],
        relevantChunkAnchors: ["기준 문구"],
      },
      chunks: [retrieved(allChunks[0] as ProductChunk), retrieved(allChunks[1] as ProductChunk)],
      allChunks,
      candidateCount: 2,
      cutoff: 2,
      latencySamplesMs: [1, 2, 3, 4, 5],
    });
    expect(observation.requiredFactCoverage).toBe(1);
    expect(observation.relevantChunkRecallAtK).toBe(1);
    expect(observation.irrelevantContextRatio).toBe(0.5);
    expect(observation.latencyP95Ms).toBe(5);
  });

  it("uses nearest-rank percentiles without interpolation", () => {
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 0.95)).toBe(5);
  });
});

function chunk(id: string, text: string): ProductChunk {
  return {
    chunkId: `chunk-${id}`,
    chunkRevisionId: id,
    semanticUnitId: `unit-${id}`,
    documentId: `document-${id}`,
    text,
    vector: [1, 0],
  };
}

function retrieved(value: ProductChunk): RetrievedChunk {
  return { ...value, score: 1, scoreKind: "rrf" };
}
