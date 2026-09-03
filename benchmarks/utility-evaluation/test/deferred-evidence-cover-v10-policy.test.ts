import { describe, expect, it } from "vitest";

import type { ApprovedCard } from "@contextctl/selection-delivery";

import {
  buildScopeProbeCandidates,
  planDeferredEvidenceCover,
  type ProbedCardInput,
  type ScopeProbeCandidate,
} from "../src/deferred-evidence-cover-v10-policy.js";

describe("deferred evidence cover candidate v10", () => {
  it("forms a deterministic bounded union from both Card signals", () => {
    const inputs = [
      signal(card("lexical"), 1, 0.2),
      signal(card("semantic"), 0.2, 1),
      signal(card("middle"), 0.8, 0.8),
    ];

    const forward = buildScopeProbeCandidates(inputs);
    const reverse = buildScopeProbeCandidates([...inputs].reverse());

    expect(forward.map((entry) => entry.card.cardId).sort()).toEqual([
      "lexical",
      "middle",
      "semantic",
    ]);
    expect(reverse).toEqual(forward);
  });

  it("defers a related Card without making its Scope executable", () => {
    const nearby = probed(candidate(card("nearby"), 0.84, 0.8), [
      chunk("nearby-a", 0.84),
    ]);

    const result = planDeferredEvidenceCover({
      query: "nearby question",
      cards: [nearby],
    });

    expect(result.disposition).toBe("defer");
    expect(result.executable).toBe(false);
    expect(result.selectedCards).toEqual([]);
    expect(result.routedCards.map((value) => value.cardId)).toEqual(["nearby"]);
  });

  it("lets an admitted anchor use a deferred complement", () => {
    const anchor = probed(candidate(card("anchor"), 1, 0.9), [
      chunk("anchor-a", 0.92, "alpha"),
    ]);
    const complement = probed(candidate(card("complement"), 0.84, 0.75), [
      chunk("complement-a", 0.88, "beta"),
    ]);

    const result = planDeferredEvidenceCover({
      query: "alpha beta",
      cards: [anchor, complement],
    });

    expect(result.disposition).toBe("admit");
    expect(result.selectedCards.map((value) => value.cardId).sort()).toEqual([
      "anchor",
      "complement",
    ]);
  });

  it("defers instead of executing a set that cannot preserve coverage", () => {
    const values = ["alpha", "beta", "gamma", "delta", "epsilon"].map(
      (word, index) =>
        probed(candidate(card(`card-${String(index)}`), 1, 0.9), [
          chunk(`chunk-${String(index)}`, 0.9, word),
        ]),
    );

    const result = planDeferredEvidenceCover({
      query: "alpha beta gamma delta epsilon",
      cards: values,
    });

    expect(result.disposition).toBe("defer");
    expect(result.executable).toBe(false);
    expect(result.selectedCards).toEqual([]);
    expect(result.routedCards).toHaveLength(1);
  });

  it("is deterministic after candidate and Chunk reversal", () => {
    const inputs = [
      probed(candidate(card("first"), 1, 0.9), [
        chunk("first-a", 0.94, "first"),
      ]),
      probed(candidate(card("second"), 0.9, 0.8), [
        chunk("second-a", 0.88, "second"),
      ]),
    ];
    const forward = planDeferredEvidenceCover({
      query: "first second",
      cards: inputs,
    });
    const reversed = planDeferredEvidenceCover({
      query: "first second",
      cards: [...inputs].reverse().map((entry) => ({
        ...entry,
        scopes: [...entry.scopes].reverse().map((scope) => ({
          ...scope,
          chunks: [...scope.chunks].reverse(),
        })),
      })),
    });

    expect(reversed.audit.auditDigest).toBe(forward.audit.auditDigest);
  });

  it("rejects duplicate Card versions and invalid probe observations", () => {
    const value = probed(candidate(card("duplicate"), 1, 0.9), [
      chunk("duplicate-a", 0.94),
    ]);
    expect(() =>
      planDeferredEvidenceCover({ query: "duplicate", cards: [value, value] }),
    ).toThrow(/duplicate probed Card Version/u);

    expect(() =>
      planDeferredEvidenceCover({
        query: "invalid rank",
        cards: [
          probed(candidate(card("invalid"), 1, 0.9), [
            { ...chunk("invalid-a", 0.94), rank: 0 },
          ]),
        ],
      }),
    ).toThrow(/probe Chunk observation is invalid/u);
  });

  it("rejects conflicting observations for one Chunk revision", () => {
    const first = probed(candidate(card("first"), 1, 0.9), [
      chunk("shared", 0.94, "same revision"),
    ]);
    const second = probed(candidate(card("second"), 1, 0.9), [
      chunk("shared", 0.9, "different text"),
    ]);

    expect(() =>
      planDeferredEvidenceCover({
        query: "shared revision",
        cards: [first, second],
      }),
    ).toThrow(/probe Chunk observation is inconsistent/u);
  });
});

function card(id: string): ApprovedCard {
  return {
    cardId: id,
    versionId: `${id}-v1`,
    meaning: {
      description: id,
      representativeQuestions: [`${id} question`],
      aliases: [id],
      keywords: [id],
    },
    policy: { sensitive: false, allowedUsage: ["retrieval"] },
    scopes: [
      {
        kind: "managed_document",
        reference: { scopeId: `${id}-scope`, scopeVersion: "v1" },
        documentIndex: {
          documentIndexId: `${id}-index`,
          sourceId: `${id}-source`,
          documentId: `${id}-document`,
          indexVersion: "v1",
        },
        selection: { kind: "document" },
      },
    ],
  };
}

function signal(value: ApprovedCard, lexical: number, semantic: number) {
  return {
    card: value,
    lexical,
    semantic,
    hybrid: Math.max(lexical, semantic),
    lexicalSignals: [],
  };
}

function candidate(
  value: ApprovedCard,
  hybrid: number,
  bm25: number,
): ScopeProbeCandidate {
  return {
    ...signal(value, hybrid, hybrid),
    lexicalRankSupport: 1,
    semanticRankSupport: 1,
    routingSupport: 1,
    cardSupport: hybrid,
    lexicalSignals: [{ field: "bm25", matched: "catalog", contribution: bm25 }],
  };
}

function probed(
  value: ScopeProbeCandidate,
  chunks: ProbedCardInput["scopes"][number]["chunks"],
): ProbedCardInput {
  return {
    candidate: value,
    scopes: [{ scopeId: `${value.card.cardId}-scope`, scopeVersion: "v1", chunks }],
  };
}

function chunk(id: string, sentenceSimilarity: number, text = id) {
  return {
    chunkRevisionId: id,
    text,
    rank: 1,
    similarity: sentenceSimilarity,
    sentenceSimilarity,
  };
}
