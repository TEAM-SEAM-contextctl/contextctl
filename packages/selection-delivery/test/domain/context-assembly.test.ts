import { describe, expect, it } from "vitest";

import { ContextBudgetInvariantError } from "../../src/domain/errors.js";
import {
  assembleDocumentContext,
  RRF_RANK_CONSTANT,
  toContextOmission,
  type AssembledContext,
  type ContextBudget,
  type ContextCandidate,
  type ContextChunk,
  type ContextOmission,
} from "../../src/domain/context-assembly.js";

/** The item every candidate belongs to unless a test says otherwise. */
const ITEM_A = "sha256:aaaa";
const ITEM_B = "sha256:bbbb";
/** The read every candidate came out of unless a test says otherwise. */
const TARGET_A = "sha256:tttt_a";
const TARGET_B = "sha256:tttt_b";
const TARGET_C = "sha256:tttt_c";

/** One occurrence from a second read, for tests about two reads disagreeing. */
function fromB(overrides: Partial<ContextCandidate> = {}): Partial<ContextCandidate> {
  return { itemKey: ITEM_B, targetKey: TARGET_B, ...overrides };
}

/**
 * Builds one candidate with distinct identity by default, so a test only states
 * the field it is actually exercising. `text` is empty unless overridden, which
 * keeps the character budget out of the way of the ordering tests.
 */
function candidate(
  chunkRevisionId: string,
  rank: number,
  overrides: Partial<ContextCandidate> = {},
): ContextCandidate {
  return {
    itemKey: ITEM_A,
    targetKey: TARGET_A,
    scopeRef: {
      scopeId: "scope_refund_policy_doc",
      scopeVersion: "scopev_0001",
    },
    rank,
    chunkId: `chunk_${chunkRevisionId}`,
    chunkRevisionId,
    semanticUnitId: `unit_${chunkRevisionId}`,
    documentId: "doc_refund_policy",
    contentDigest: `digest_${chunkRevisionId}`,
    text: "",
    ...overrides,
  };
}

/** A candidate of an exact character length, for the budget boundary tests. */
function sized(
  chunkRevisionId: string,
  rank: number,
  characters: number,
  overrides: Partial<ContextCandidate> = {},
): ContextCandidate {
  return candidate(chunkRevisionId, rank, {
    text: "x".repeat(characters),
    ...overrides,
  });
}

const roomy: ContextBudget = { maxTotalCharacters: 1000, maxChunks: 100 };

function revisionsOf(chunks: readonly ContextChunk[]): string[] {
  return chunks.map((entry) => entry.chunkRevisionId);
}

/** The consumer-facing projection of the omissions. */
function omissionsOf(evidence: AssembledContext): readonly ContextOmission[] {
  return evidence.omitted.map(toContextOmission);
}

/**
 * `truncated` is not a field on the assembly result: it is a per-item fact,
 * derived in `assembleContext` from that item's own omissions. Derived the same
 * way here, so these tests keep asserting the same behaviour.
 */
function truncatedOf(evidence: AssembledContext): boolean {
  return evidence.omitted.some((entry) => entry.reason === "budget_exhausted");
}

/** `1 / (60 + rank)`, restated from the rule rather than from the constant. */
function reciprocal(rank: number): number {
  return 1 / (RRF_RANK_CONSTANT + rank);
}

describe("rrf-v1 fusion", () => {
  it("scores a chunk that one target returned as one reciprocal", () => {
    const evidence = assembleDocumentContext([candidate("rev_a", 1)], roomy);

    expect(evidence.chunks[0]?.score).toBe(reciprocal(1));
  });

  it("uses 60 as the rank constant, so first place barely beats second", () => {
    const evidence = assembleDocumentContext(
      [candidate("rev_a", 1), candidate("rev_b", 2)],
      roomy,
    );

    expect(evidence.chunks[0]?.score).toBe(1 / 61);
    expect(evidence.chunks[1]?.score).toBe(1 / 62);
    // The whole reason the constant is large: one place of separation is worth
    // less than two targets agreeing, which the next test relies on.
    expect(1 / 61 - 1 / 62).toBeLessThan(1 / 62);
  });

  it("sums the reciprocals of every target that returned one chunk", () => {
    const evidence = assembleDocumentContext(
      [
        candidate("rev_shared", 3),
        candidate("rev_shared", 4, fromB()),
      ],
      roomy,
    );

    expect(evidence.chunks).toHaveLength(1);
    expect(evidence.chunks[0]?.score).toBe(reciprocal(3) + reciprocal(4));
  });

  it("ranks agreement between two targets above one target's first place", () => {
    const evidence = assembleDocumentContext(
      [
        candidate("rev_alone", 1),
        candidate("rev_shared", 2),
        candidate("rev_shared", 2, fromB()),
      ],
      roomy,
    );

    // This is the entire point of fusing rather than merging by best rank: the
    // chunk two targets both placed second outranks the one a single target
    // placed first.
    expect(revisionsOf(evidence.chunks)).toEqual(["rev_shared", "rev_alone"]);
  });

  it("attributes a fused chunk to the item whose target ranked it best", () => {
    const evidence = assembleDocumentContext(
      [
        candidate("rev_shared", 5),
        candidate("rev_shared", 2, fromB()),
      ],
      roomy,
    );

    expect(evidence.chunks[0]?.itemKey).toBe(ITEM_B);
    // `rank` narrows to the best position observed; `score` still counts both.
    expect(evidence.chunks[0]?.rank).toBe(2);
    expect(evidence.chunks[0]?.score).toBe(reciprocal(5) + reciprocal(2));
  });

  it("records the losing occurrence against its own item, not the winner's", () => {
    const evidence = assembleDocumentContext(
      [
        candidate("rev_shared", 5),
        candidate("rev_shared", 2, fromB()),
      ],
      roomy,
    );

    expect(evidence.omitted).toHaveLength(1);
    expect(evidence.omitted[0]?.chunk.itemKey).toBe(ITEM_A);
    expect(evidence.omitted[0]?.reason).toBe("duplicate_chunk_revision");
  });

  it("breaks a rank tie between two items on itemKey, not on input order", () => {
    const forward = assembleDocumentContext(
      [
        candidate("rev_shared", 1, { itemKey: ITEM_B }),
        candidate("rev_shared", 1, { itemKey: ITEM_A }),
      ],
      roomy,
    );
    const reversed = assembleDocumentContext(
      [
        candidate("rev_shared", 1, { itemKey: ITEM_A }),
        candidate("rev_shared", 1, { itemKey: ITEM_B }),
      ],
      roomy,
    );

    expect(forward.chunks[0]?.itemKey).toBe(ITEM_A);
    expect(reversed.chunks[0]?.itemKey).toBe(ITEM_A);
  });

  it("orders equal scores by ascending revision id", () => {
    const evidence = assembleDocumentContext(
      [candidate("rev_b", 1), candidate("rev_a", 1)],
      roomy,
    );

    expect(revisionsOf(evidence.chunks)).toEqual(["rev_a", "rev_b"]);
  });

  it("contributes nothing for a rank below one rather than clamping it", () => {
    const evidence = assembleDocumentContext(
      [candidate("rev_broken", 0), candidate("rev_last", 12)],
      roomy,
    );

    // A zero rank breaks the 1-based contract, so it earns no score at all —
    // guessing it meant first place would let a malformed answer win.
    expect(evidence.chunks[0]?.chunkRevisionId).toBe("rev_last");
    expect(evidence.chunks[1]?.score).toBe(0);
  });

  it("sinks a non-finite rank below every usable one without throwing", () => {
    const evidence = assembleDocumentContext(
      [
        candidate("rev_nan", Number.NaN),
        candidate("rev_ok", 40),
        candidate("rev_inf", Number.POSITIVE_INFINITY),
      ],
      roomy,
    );

    expect(revisionsOf(evidence.chunks)[0]).toBe("rev_ok");
    // The two unusable ones score zero and are then ordered by revision id.
    expect(revisionsOf(evidence.chunks)).toEqual([
      "rev_ok",
      "rev_inf",
      "rev_nan",
    ]);
  });
});

describe("cross-target integrity", () => {
  it("fails every read that disagrees about one chunk revision", () => {
    const evidence = assembleDocumentContext(
      [
        candidate("rev_x", 1, { text: "one wording" }),
        candidate("rev_x", 1, fromB({ text: "another wording" })),
      ],
      roomy,
    );

    // A revision is immutable, so two descriptions of it that differ cannot
    // both be right — and nothing here can tell which is wrong. Neither copy
    // is trusted and neither read is.
    expect(evidence.failedTargetKeys).toEqual([TARGET_A, TARGET_B].sort());
    expect(evidence.chunks).toEqual([]);
    expect(evidence.omitted).toEqual([]);
  });

  it.each([
    ["chunkId", { chunkId: "chunk_other" }],
    ["documentId", { documentId: "doc_other" }],
    ["semanticUnitId", { semanticUnitId: "unit_other" }],
    ["contentDigest", { contentDigest: "digest_other" }],
  ] as const)("treats a differing %s as a contradiction", (_field, difference) => {
    const evidence = assembleDocumentContext(
      [candidate("rev_x", 1), candidate("rev_x", 2, fromB(difference))],
      roomy,
    );

    expect(evidence.failedTargetKeys).toHaveLength(2);
    expect(evidence.chunks).toEqual([]);
  });

  it("keeps a read that the contradiction did not touch", () => {
    const evidence = assembleDocumentContext(
      [
        candidate("rev_x", 1, { text: "one wording" }),
        candidate("rev_x", 1, fromB({ text: "another wording" })),
        candidate("rev_y", 1, { itemKey: "sha256:cccc", targetKey: TARGET_C }),
      ],
      roomy,
    );

    // One item failing must not cost the answer: the read that only returned
    // `rev_y` said nothing contradictory and its evidence stands.
    expect(evidence.failedTargetKeys).toEqual([TARGET_A, TARGET_B].sort());
    expect(revisionsOf(evidence.chunks)).toEqual(["rev_y"]);
    expect(evidence.chunks[0]?.targetKey).toBe(TARGET_C);
  });

  it("recomputes fusion without the reciprocals of a failed read", () => {
    const evidence = assembleDocumentContext(
      [
        // Target A placed the shared chunk first — and also contradicts B.
        candidate("rev_shared", 1),
        candidate("rev_x", 2, { text: "one wording" }),
        candidate("rev_x", 1, fromB({ text: "another wording" })),
        // Target C placed the shared chunk third and contradicts nobody.
        candidate("rev_shared", 3, { itemKey: "sha256:cccc", targetKey: TARGET_C }),
      ],
      roomy,
    );

    // Had A's first place leaked into the fusion, `rev_shared` would score
    // 1/61 + 1/63. It scores 1/63: the ranking is recomputed over the sound
    // reads alone, as if A had never answered (SOT L1534).
    expect(revisionsOf(evidence.chunks)).toEqual(["rev_shared"]);
    expect(evidence.chunks[0]?.score).toBe(reciprocal(3));
    expect(evidence.chunks[0]?.targetKey).toBe(TARGET_C);
    expect(evidence.chunks[0]?.rank).toBe(3);
    // No `duplicate_chunk_revision` for A's copy either: a read that was set
    // aside did not lose a chunk, it never entered.
    expect(evidence.omitted).toEqual([]);
  });

  it("fails every read whose chunks share a digest but not a text", () => {
    const evidence = assembleDocumentContext(
      [
        candidate("rev_a", 1, { contentDigest: "digest_shared", text: "alpha" }),
        candidate("rev_b", 1, fromB({ contentDigest: "digest_shared", text: "beta" })),
      ],
      roomy,
    );

    // A digest names one byte sequence. Two texts under it mean one of them is
    // not what the digest says it is, and that is a contradiction, not a
    // repeat to deduplicate.
    expect(evidence.failedTargetKeys).toEqual([TARGET_A, TARGET_B].sort());
    expect(evidence.chunks).toEqual([]);
  });

  it("still deduplicates a repeated digest whose texts agree", () => {
    const evidence = assembleDocumentContext(
      [
        candidate("rev_a", 1, { contentDigest: "digest_shared", text: "same" }),
        candidate("rev_b", 1, fromB({ contentDigest: "digest_shared", text: "same" })),
      ],
      roomy,
    );

    expect(evidence.failedTargetKeys).toEqual([]);
    expect(revisionsOf(evidence.chunks)).toEqual(["rev_a"]);
    expect(omissionsOf(evidence).map((omission) => omission.reason)).toEqual([
      "duplicate_content",
    ]);
  });

  it("does not treat identical copies of one revision as a contradiction", () => {
    const evidence = assembleDocumentContext(
      [candidate("rev_shared", 2), candidate("rev_shared", 5, fromB())],
      roomy,
    );

    expect(evidence.failedTargetKeys).toEqual([]);
    expect(evidence.chunks).toHaveLength(1);
  });

  it("fails a read whose own chunks repeat a digest with different texts", () => {
    const evidence = assembleDocumentContext(
      [
        candidate("rev_a", 1, { contentDigest: "digest_shared", text: "alpha" }),
        candidate("rev_b", 2, { contentDigest: "digest_shared", text: "beta" }),
      ],
      roomy,
    );

    // Same rule within one read: the contradiction is in the data, and which
    // target produced it does not change what can be trusted.
    expect(evidence.failedTargetKeys).toEqual([TARGET_A]);
    expect(evidence.chunks).toEqual([]);
  });

  it("names the failed reads in one order regardless of input order", () => {
    const forward = assembleDocumentContext(
      [
        candidate("rev_x", 1, { text: "a" }),
        candidate("rev_x", 1, fromB({ text: "b" })),
      ],
      roomy,
    );
    const reversed = assembleDocumentContext(
      [
        candidate("rev_x", 1, fromB({ text: "b" })),
        candidate("rev_x", 1, { text: "a" }),
      ],
      roomy,
    );

    expect(forward.failedTargetKeys).toEqual(reversed.failedTargetKeys);
  });
});

describe("assembleDocumentContext", () => {
  it("drops a distinct revision that repeats an earlier content digest", () => {
    const evidence = assembleDocumentContext(
      [
        candidate("rev_first", 1, { contentDigest: "digest_shared" }),
        candidate("rev_second", 2, { contentDigest: "digest_shared" }),
      ],
      roomy,
    );

    expect(revisionsOf(evidence.chunks)).toEqual(["rev_first"]);
    expect(omissionsOf(evidence)).toEqual([
      {
        chunkId: "chunk_rev_second",
        chunkRevisionId: "rev_second",
        reason: "duplicate_content",
      },
    ]);
  });

  it("keeps the highest-scoring copy of a repeated digest, not the first given", () => {
    const evidence = assembleDocumentContext(
      [
        candidate("rev_low", 9, { contentDigest: "digest_shared" }),
        candidate("rev_high", 1, { contentDigest: "digest_shared" }),
      ],
      roomy,
    );

    expect(revisionsOf(evidence.chunks)).toEqual(["rev_high"]);
  });

  it("admits a set that lands exactly on the character ceiling", () => {
    const evidence = assembleDocumentContext(
      [sized("rev_a", 1, 6), sized("rev_b", 2, 4)],
      { maxTotalCharacters: 10, maxChunks: 100 },
    );

    expect(revisionsOf(evidence.chunks)).toEqual(["rev_a", "rev_b"]);
    expect(truncatedOf(evidence)).toBe(false);
  });

  it("stops at the first chunk that would cross the character ceiling", () => {
    const evidence = assembleDocumentContext(
      [sized("rev_a", 1, 6), sized("rev_b", 2, 5)],
      { maxTotalCharacters: 10, maxChunks: 100 },
    );

    expect(revisionsOf(evidence.chunks)).toEqual(["rev_a"]);
    expect(omissionsOf(evidence)).toEqual([
      {
        chunkId: "chunk_rev_b",
        chunkRevisionId: "rev_b",
        reason: "budget_exhausted",
      },
    ]);
    expect(truncatedOf(evidence)).toBe(true);
  });

  it("does not slot a later smaller chunk into the room the oversized one left", () => {
    const evidence = assembleDocumentContext(
      [sized("rev_a", 1, 5), sized("rev_b", 2, 20), sized("rev_c", 3, 1)],
      { maxTotalCharacters: 10, maxChunks: 100 },
    );

    // Packing by size would silently reorder the evidence by length and destroy
    // the meaning of the fusion that produced the order.
    expect(revisionsOf(evidence.chunks)).toEqual(["rev_a"]);
    expect(
      omissionsOf(evidence).map((omission) => omission.chunkRevisionId),
    ).toEqual(["rev_b", "rev_c"]);
  });

  it("admits exactly as many chunks as the chunk ceiling allows", () => {
    const evidence = assembleDocumentContext(
      [candidate("rev_a", 1), candidate("rev_b", 2), candidate("rev_c", 3)],
      { maxTotalCharacters: 1000, maxChunks: 3 },
    );

    expect(evidence.chunks).toHaveLength(3);
    expect(truncatedOf(evidence)).toBe(false);
  });

  it("omits the chunk that would exceed the chunk ceiling by one", () => {
    const evidence = assembleDocumentContext(
      [candidate("rev_a", 1), candidate("rev_b", 2), candidate("rev_c", 3)],
      { maxTotalCharacters: 1000, maxChunks: 2 },
    );

    expect(revisionsOf(evidence.chunks)).toEqual(["rev_a", "rev_b"]);
    expect(omissionsOf(evidence)).toEqual([
      {
        chunkId: "chunk_rev_c",
        chunkRevisionId: "rev_c",
        reason: "budget_exhausted",
      },
    ]);
  });

  it("returns no evidence when the only chunk is larger than the whole budget", () => {
    const evidence = assembleDocumentContext([sized("rev_a", 1, 11)], {
      maxTotalCharacters: 10,
      maxChunks: 100,
    });

    // A `fulfilled` item with no chunks and `truncated` set is a real outcome
    // and a different one from a failure: the read happened and lost the budget.
    expect(evidence.chunks).toEqual([]);
    expect(truncatedOf(evidence)).toBe(true);
  });

  it("deduplicates before spending the budget, so a repeat costs nothing", () => {
    const evidence = assembleDocumentContext(
      [
        sized("rev_a", 1, 5, { contentDigest: "digest_shared" }),
        sized("rev_b", 2, 5, { contentDigest: "digest_shared" }),
        sized("rev_c", 3, 5),
      ],
      { maxTotalCharacters: 10, maxChunks: 100 },
    );

    // The repeat is dropped for being a repeat, and the distinct third chunk
    // still fits. Applying the budget first would have spent the room on it.
    expect(revisionsOf(evidence.chunks)).toEqual(["rev_a", "rev_c"]);
    expect(truncatedOf(evidence)).toBe(false);
  });

  it("refuses a budget limit of zero", () => {
    expect(() =>
      assembleDocumentContext([candidate("rev_a", 1)], {
        maxTotalCharacters: 0,
        maxChunks: 1,
      }),
    ).toThrow(ContextBudgetInvariantError);
  });

  it("refuses a negative budget limit", () => {
    expect(() =>
      assembleDocumentContext([candidate("rev_a", 1)], {
        maxTotalCharacters: 10,
        maxChunks: -1,
      }),
    ).toThrow(ContextBudgetInvariantError);
  });

  it("refuses a NaN budget limit instead of silently omitting everything", () => {
    expect(() =>
      assembleDocumentContext([candidate("rev_a", 1)], {
        maxTotalCharacters: Number.NaN,
        maxChunks: 10,
      }),
    ).toThrow(ContextBudgetInvariantError);
  });

  it("refuses an infinite budget limit", () => {
    expect(() =>
      assembleDocumentContext([candidate("rev_a", 1)], {
        maxTotalCharacters: Number.POSITIVE_INFINITY,
        maxChunks: 10,
      }),
    ).toThrow(ContextBudgetInvariantError);
  });

  it("refuses a fractional budget limit", () => {
    expect(() =>
      assembleDocumentContext([candidate("rev_a", 1)], {
        maxTotalCharacters: 10,
        maxChunks: 1.5,
      }),
    ).toThrow(ContextBudgetInvariantError);
  });

  it("returns an empty, untruncated result for no chunks at all", () => {
    const evidence = assembleDocumentContext([], roomy);

    expect(evidence.chunks).toEqual([]);
    expect(evidence.omitted).toEqual([]);
    expect(evidence.failedTargetKeys).toEqual([]);
    expect(truncatedOf(evidence)).toBe(false);
  });

  it("does not reorder the caller's array", () => {
    const candidates = [candidate("rev_b", 5), candidate("rev_a", 1)];
    const original = [...candidates];

    assembleDocumentContext(candidates, roomy);

    expect(candidates).toEqual(original);
  });

  it("produces the same evidence for the same input twice", () => {
    const build = (): readonly ContextCandidate[] => [
      candidate("rev_b", 2),
      candidate("rev_a", 2),
      candidate("rev_c", 1),
    ];

    expect(assembleDocumentContext(build(), roomy)).toEqual(
      assembleDocumentContext(build(), roomy),
    );
  });

  it("hands back the whole chunk for every omission, not just its identity", () => {
    const evidence = assembleDocumentContext(
      [
        candidate("rev_first", 1, { contentDigest: "digest_shared" }),
        candidate("rev_second", 2, { contentDigest: "digest_shared" }),
      ],
      roomy,
    );

    // The attribution is what `assembleContext` needs: an omission has to land
    // in the item the dropped chunk came from, which the projection alone
    // cannot say.
    expect(evidence.omitted[0]?.chunk.itemKey).toBe(ITEM_A);
    expect(evidence.omitted[0]?.chunk.text).toBe("");
  });
});
