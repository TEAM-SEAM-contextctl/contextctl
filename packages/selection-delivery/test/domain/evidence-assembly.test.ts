import { describe, expect, it } from "vitest";

import { EvidenceBudgetInvariantError } from "../../src/domain/errors.js";
import {
  assembleDocumentEvidence,
  DEFAULT_EVIDENCE_BUDGET,
  EVIDENCE_ASSEMBLY_POLICY_VERSION,
  type EvidenceBudget,
  type EvidenceChunk,
} from "../../src/domain/evidence-assembly.js";

/**
 * Builds one chunk with distinct identity by default, so a test only states the
 * field it is actually exercising. `text` is empty unless overridden, which
 * keeps the character budget out of the way of the ranking tests.
 */
function chunk(
  chunkRevisionId: string,
  score: number,
  overrides: Partial<EvidenceChunk> = {},
): EvidenceChunk {
  return {
    cardId: "card_refund_policy",
    versionId: "cardv_refund_policy_v1",
    scopeRef: {
      scopeId: "scope_refund_policy_doc",
      scopeVersion: "scopev_0001",
    },
    chunkId: `chunk_${chunkRevisionId}`,
    chunkRevisionId,
    semanticUnitId: `unit_${chunkRevisionId}`,
    documentId: "doc_refund_policy",
    contentDigest: `digest_${chunkRevisionId}`,
    text: "",
    score,
    ...overrides,
  };
}

/** A chunk of an exact character length, for the budget boundary tests. */
function sized(
  chunkRevisionId: string,
  score: number,
  characters: number,
  overrides: Partial<EvidenceChunk> = {},
): EvidenceChunk {
  return chunk(chunkRevisionId, score, {
    text: "x".repeat(characters),
    ...overrides,
  });
}

const roomy: EvidenceBudget = { maxTotalCharacters: 1000, maxChunks: 100 };

function revisionsOf(chunks: readonly EvidenceChunk[]): string[] {
  return chunks.map((entry) => entry.chunkRevisionId);
}

describe("assembleDocumentEvidence", () => {
  it("keeps the first appearance of a repeated chunk revision", () => {
    const evidence = assembleDocumentEvidence(
      [
        chunk("rev_a", 0.9),
        chunk("rev_a", 0.4, { chunkId: "chunk_rev_a_again" }),
      ],
      roomy,
    );

    expect(revisionsOf(evidence.chunks)).toEqual(["rev_a"]);
    expect(evidence.omitted).toEqual([
      {
        chunkId: "chunk_rev_a_again",
        chunkRevisionId: "rev_a",
        reason: "duplicate_chunk_revision",
      },
    ]);
    expect(evidence.truncated).toBe(false);
  });

  it("keeps the higher-scoring copy of a repeated chunk revision", () => {
    const evidence = assembleDocumentEvidence(
      [
        chunk("rev_a", 0.4, { chunkId: "chunk_low" }),
        chunk("rev_a", 0.9, { chunkId: "chunk_high" }),
      ],
      roomy,
    );

    expect(evidence.chunks.map((entry) => entry.chunkId)).toEqual([
      "chunk_high",
    ]);
    expect(evidence.omitted.map((entry) => entry.chunkId)).toEqual([
      "chunk_low",
    ]);
  });

  it("drops a distinct revision that repeats an earlier content digest", () => {
    const evidence = assembleDocumentEvidence(
      [
        chunk("rev_a", 0.9, { contentDigest: "digest_shared" }),
        chunk("rev_b", 0.5, { contentDigest: "digest_shared" }),
      ],
      roomy,
    );

    expect(revisionsOf(evidence.chunks)).toEqual(["rev_a"]);
    expect(evidence.omitted).toEqual([
      {
        chunkId: "chunk_rev_b",
        chunkRevisionId: "rev_b",
        reason: "duplicate_content",
      },
    ]);
  });

  it("ranks by descending score and breaks ties by ascending revision id", () => {
    const evidence = assembleDocumentEvidence(
      [
        chunk("rev_c", 0.5),
        chunk("rev_b", 0.9),
        chunk("rev_a", 0.9),
        chunk("rev_d", 0.1),
      ],
      roomy,
    );

    expect(revisionsOf(evidence.chunks)).toEqual([
      "rev_a",
      "rev_b",
      "rev_c",
      "rev_d",
    ]);
  });

  it("admits a set that lands exactly on the character ceiling", () => {
    const evidence = assembleDocumentEvidence(
      [sized("rev_a", 0.9, 6), sized("rev_b", 0.8, 4)],
      { maxTotalCharacters: 10, maxChunks: 100 },
    );

    expect(revisionsOf(evidence.chunks)).toEqual(["rev_a", "rev_b"]);
    expect(evidence.omitted).toEqual([]);
    expect(evidence.truncated).toBe(false);
  });

  it("stops at the first chunk that would cross the character ceiling", () => {
    const evidence = assembleDocumentEvidence(
      [sized("rev_a", 0.9, 6), sized("rev_b", 0.8, 5)],
      { maxTotalCharacters: 10, maxChunks: 100 },
    );

    expect(revisionsOf(evidence.chunks)).toEqual(["rev_a"]);
    expect(evidence.omitted).toEqual([
      {
        chunkId: "chunk_rev_b",
        chunkRevisionId: "rev_b",
        reason: "budget_exhausted",
      },
    ]);
    expect(evidence.truncated).toBe(true);
  });

  it("does not slot a later smaller chunk into the room the oversized one left", () => {
    const evidence = assembleDocumentEvidence(
      [
        sized("rev_a", 0.9, 6),
        sized("rev_b", 0.8, 5),
        // Would fit (6 + 2 <= 10), but packing it in would reorder the evidence
        // by size instead of by rank.
        sized("rev_c", 0.7, 2),
      ],
      { maxTotalCharacters: 10, maxChunks: 100 },
    );

    expect(revisionsOf(evidence.chunks)).toEqual(["rev_a"]);
    expect(evidence.omitted).toEqual([
      {
        chunkId: "chunk_rev_b",
        chunkRevisionId: "rev_b",
        reason: "budget_exhausted",
      },
      {
        chunkId: "chunk_rev_c",
        chunkRevisionId: "rev_c",
        reason: "budget_exhausted",
      },
    ]);
    expect(evidence.truncated).toBe(true);
  });

  it("admits exactly as many chunks as the chunk ceiling allows", () => {
    const evidence = assembleDocumentEvidence(
      [sized("rev_a", 0.9, 1), sized("rev_b", 0.8, 1), sized("rev_c", 0.7, 1)],
      { maxTotalCharacters: 1000, maxChunks: 3 },
    );

    expect(revisionsOf(evidence.chunks)).toEqual(["rev_a", "rev_b", "rev_c"]);
    expect(evidence.omitted).toEqual([]);
    expect(evidence.truncated).toBe(false);
  });

  it("omits the chunk that would exceed the chunk ceiling by one", () => {
    const evidence = assembleDocumentEvidence(
      [sized("rev_a", 0.9, 1), sized("rev_b", 0.8, 1), sized("rev_c", 0.7, 1)],
      { maxTotalCharacters: 1000, maxChunks: 2 },
    );

    expect(revisionsOf(evidence.chunks)).toEqual(["rev_a", "rev_b"]);
    expect(evidence.omitted).toEqual([
      {
        chunkId: "chunk_rev_c",
        chunkRevisionId: "rev_c",
        reason: "budget_exhausted",
      },
    ]);
    expect(evidence.truncated).toBe(true);
  });

  it("returns no evidence when the only chunk is larger than the whole budget", () => {
    const evidence = assembleDocumentEvidence([sized("rev_a", 0.9, 6)], {
      maxTotalCharacters: 5,
      maxChunks: 100,
    });

    expect(evidence.chunks).toEqual([]);
    expect(evidence.omitted).toEqual([
      {
        chunkId: "chunk_rev_a",
        chunkRevisionId: "rev_a",
        reason: "budget_exhausted",
      },
    ]);
    expect(evidence.truncated).toBe(true);
  });

  it("refuses a budget limit of zero", () => {
    expect(() =>
      assembleDocumentEvidence([], { maxTotalCharacters: 0, maxChunks: 12 }),
    ).toThrow(EvidenceBudgetInvariantError);
    expect(() =>
      assembleDocumentEvidence([], { maxTotalCharacters: 8000, maxChunks: 0 }),
    ).toThrow(EvidenceBudgetInvariantError);
  });

  it("refuses a negative budget limit", () => {
    expect(() =>
      assembleDocumentEvidence([], { maxTotalCharacters: -1, maxChunks: 12 }),
    ).toThrow(EvidenceBudgetInvariantError);
    expect(() =>
      assembleDocumentEvidence([], { maxTotalCharacters: 8000, maxChunks: -5 }),
    ).toThrow(EvidenceBudgetInvariantError);
  });

  it("refuses a NaN budget limit instead of silently omitting everything", () => {
    expect(() =>
      assembleDocumentEvidence([], {
        maxTotalCharacters: Number.NaN,
        maxChunks: 12,
      }),
    ).toThrow(EvidenceBudgetInvariantError);
    expect(() =>
      assembleDocumentEvidence([], {
        maxTotalCharacters: 8000,
        maxChunks: Number.NaN,
      }),
    ).toThrow(EvidenceBudgetInvariantError);
  });

  it("refuses an infinite budget limit", () => {
    expect(() =>
      assembleDocumentEvidence([], {
        maxTotalCharacters: Number.POSITIVE_INFINITY,
        maxChunks: 12,
      }),
    ).toThrow(EvidenceBudgetInvariantError);
    expect(() =>
      assembleDocumentEvidence([], {
        maxTotalCharacters: 8000,
        maxChunks: Number.POSITIVE_INFINITY,
      }),
    ).toThrow(EvidenceBudgetInvariantError);
  });

  it("refuses a fractional budget limit", () => {
    expect(() =>
      assembleDocumentEvidence([], { maxTotalCharacters: 10.5, maxChunks: 12 }),
    ).toThrow(EvidenceBudgetInvariantError);
    expect(() =>
      assembleDocumentEvidence([], {
        maxTotalCharacters: 8000,
        maxChunks: 2.5,
      }),
    ).toThrow(EvidenceBudgetInvariantError);
  });

  it("returns an empty, untruncated result for no chunks at all", () => {
    const evidence = assembleDocumentEvidence([], roomy);

    expect(evidence.chunks).toEqual([]);
    expect(evidence.omitted).toEqual([]);
    expect(evidence.truncated).toBe(false);
  });

  it("does not reorder the caller's array", () => {
    const chunks = [
      chunk("rev_c", 0.1),
      chunk("rev_a", 0.9),
      chunk("rev_b", 0.5),
    ];
    const before = revisionsOf(chunks);

    assembleDocumentEvidence(chunks, roomy);

    expect(revisionsOf(chunks)).toEqual(before);
    expect(revisionsOf(chunks)).toEqual(["rev_c", "rev_a", "rev_b"]);
  });

  it("produces the same evidence for the same input twice", () => {
    const chunks = [
      sized("rev_c", 0.5, 4),
      sized("rev_a", 0.9, 4),
      sized("rev_b", 0.9, 4),
      sized("rev_d", 0.1, 4),
    ];
    const budget: EvidenceBudget = { maxTotalCharacters: 10, maxChunks: 3 };

    expect(assembleDocumentEvidence(chunks, budget)).toEqual(
      assembleDocumentEvidence(chunks, budget),
    );
  });

  it("sinks every non-finite score below the finite ones without throwing", () => {
    const evidence = assembleDocumentEvidence(
      [
        chunk("rev_nan", Number.NaN),
        chunk("rev_low", 0.1),
        chunk("rev_inf", Number.POSITIVE_INFINITY),
        chunk("rev_high", 0.95),
      ],
      roomy,
    );

    expect(revisionsOf(evidence.chunks)).toEqual([
      "rev_high",
      "rev_low",
      "rev_inf",
      "rev_nan",
    ]);
    expect(evidence.omitted).toEqual([]);
  });

  it("orders non-finite scores among themselves by ascending revision id", () => {
    const permutations: readonly (readonly EvidenceChunk[])[] = [
      [
        chunk("rev_c", Number.NaN),
        chunk("rev_a", Number.POSITIVE_INFINITY),
        chunk("rev_b", Number.NEGATIVE_INFINITY),
      ],
      [
        chunk("rev_b", Number.NEGATIVE_INFINITY),
        chunk("rev_c", Number.NaN),
        chunk("rev_a", Number.POSITIVE_INFINITY),
      ],
    ];

    for (const permutation of permutations) {
      expect(
        revisionsOf(assembleDocumentEvidence(permutation, roomy).chunks),
      ).toEqual(["rev_a", "rev_b", "rev_c"]);
    }
  });

  it("deduplicates before spending the budget, so a repeat costs nothing", () => {
    const evidence = assembleDocumentEvidence(
      [
        sized("rev_a", 0.9, 5),
        sized("rev_a", 0.8, 5, { chunkId: "chunk_rev_a_again" }),
        sized("rev_b", 0.7, 5),
      ],
      { maxTotalCharacters: 10, maxChunks: 100 },
    );

    expect(revisionsOf(evidence.chunks)).toEqual(["rev_a", "rev_b"]);
    expect(evidence.omitted).toEqual([
      {
        chunkId: "chunk_rev_a_again",
        chunkRevisionId: "rev_a",
        reason: "duplicate_chunk_revision",
      },
    ]);
    expect(evidence.truncated).toBe(false);
  });

  it("stamps the assembly policy version and the budget it applied", () => {
    const evidence = assembleDocumentEvidence([chunk("rev_a", 0.9)], roomy);

    expect(evidence.policyVersion).toBe(EVIDENCE_ASSEMBLY_POLICY_VERSION);
    expect(evidence.budget).toBe(roomy);
  });

  it("records the default budget when none was given", () => {
    expect(assembleDocumentEvidence([chunk("rev_a", 0.9)]).budget).toBe(
      DEFAULT_EVIDENCE_BUDGET,
    );
  });
});
