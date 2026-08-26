import { describe, expect, it } from "vitest";

import {
  CardCandidateIndex,
  catalogSnapshotVersion,
  cosineSimilarity,
  type CardCandidateRecord,
} from "../../src/domain/card-candidate-index.js";
import { CardCandidateIndexInvariantError } from "../../src/domain/errors.js";
import { TEST_CARD_PROFILE } from "../fixtures/card-embedding.fixture.js";

const SNAPSHOT = "sha256:snapshot";

function record(
  cardVersionId: string,
  embedding: readonly number[],
  overrides: Partial<CardCandidateRecord> = {},
): CardCandidateRecord {
  return {
    cardId: `card_${cardVersionId}`,
    cardVersionId,
    catalogSnapshotVersion: SNAPSHOT,
    selectionTextDigest: `sha256:${cardVersionId}`,
    embeddingProfileId: TEST_CARD_PROFILE.id,
    embeddingProfileVersion: TEST_CARD_PROFILE.version,
    embedding,
    ...overrides,
  };
}

function indexOf(records: readonly CardCandidateRecord[]): CardCandidateIndex {
  return new CardCandidateIndex({
    catalogSnapshotVersion: SNAPSHOT,
    profile: TEST_CARD_PROFILE,
    records,
  });
}

describe("cosineSimilarity", () => {
  it("is 1 for identical directions and 0 for orthogonal ones", () => {
    expect(cosineSimilarity([1, 0, 0, 0], [1, 0, 0, 0])).toBe(1);
    expect(cosineSimilarity([1, 0, 0, 0], [0, 1, 0, 0])).toBe(0);
    expect(cosineSimilarity([1, 0, 0, 0], [-1, 0, 0, 0])).toBe(-1);
  });

  it("ignores magnitude, so an unnormalized vector cannot exceed the range", () => {
    // The profiles declare L2 normalization, but a provider that ignored it
    // would otherwise produce similarities outside [-1, 1] and every threshold
    // downstream would silently stop meaning anything.
    expect(cosineSimilarity([3, 0, 0, 0], [7, 0, 0, 0])).toBe(1);
  });

  it("defines a zero vector's similarity as 0 rather than dividing by zero", () => {
    expect(cosineSimilarity([0, 0, 0, 0], [1, 0, 0, 0])).toBe(0);
  });
});

describe("CardCandidateIndex", () => {
  it("returns the closest Cards first", () => {
    const index = indexOf([
      record("far", [0, 1, 0, 0]),
      record("near", [1, 0, 0, 0]),
      record("mid", [0.7071, 0.7071, 0, 0]),
    ]);

    expect(
      index.topK([1, 0, 0, 0], 3).map((entry) => entry.cardVersionId),
    ).toEqual(["near", "mid", "far"]);
  });

  it("breaks a tie on cardVersionId ascending", () => {
    const index = indexOf([
      record("b", [1, 0, 0, 0]),
      record("a", [1, 0, 0, 0]),
    ]);

    // Two Cards at the same distance have to come back in the same order on
    // every machine, or the ranking they feed stops being reproducible.
    expect(
      index.topK([1, 0, 0, 0], 2).map((entry) => entry.cardVersionId),
    ).toEqual(["a", "b"]);
  });

  it("searches the whole index rather than a shortlist", () => {
    const index = indexOf([
      record("lexically_invisible", [0, 0, 1, 0]),
      ...Array.from({ length: 20 }, (_unused, position) =>
        record(`noise_${String(position).padStart(2, "0")}`, [0, 1, 0, 0]),
      ),
    ]);

    // The Card the query means is buried among twenty others and still comes
    // first: nothing here consults a lexical ordering.
    expect(index.topK([0, 0, 1, 0], 1)[0]?.cardVersionId).toBe(
      "lexically_invisible",
    );
    expect(index.size).toBe(21);
  });

  it("returns nothing for a non-positive bound", () => {
    expect(indexOf([record("a", [1, 0, 0, 0])]).topK([1, 0, 0, 0], 0)).toEqual(
      [],
    );
  });

  it("refuses a query vector of the wrong width", () => {
    expect(() =>
      indexOf([record("a", [1, 0, 0, 0])]).topK([1, 0], 1),
    ).toThrow(CardCandidateIndexInvariantError);
  });

  it("refuses a record whose width does not match the profile", () => {
    expect(() => indexOf([record("a", [1, 0])])).toThrow(
      CardCandidateIndexInvariantError,
    );
  });

  it("refuses a non-finite component", () => {
    expect(() => indexOf([record("a", [Number.NaN, 0, 0, 0])])).toThrow(
      CardCandidateIndexInvariantError,
    );
  });

  it("refuses a record built under another profile", () => {
    expect(() =>
      indexOf([
        record("a", [1, 0, 0, 0], { embeddingProfileVersion: "9" }),
      ]),
    ).toThrow(CardCandidateIndexInvariantError);
  });

  it("refuses two records sharing one identity tuple", () => {
    expect(() =>
      indexOf([record("a", [1, 0, 0, 0]), record("a", [0, 1, 0, 0])]),
    ).toThrow(CardCandidateIndexInvariantError);
  });

  it("admits the same Card Version under two selection text digests", () => {
    // The identity is the four-part tuple, not the Card Version alone: the same
    // Version re-embedded after an edit is a different record, not a duplicate.
    expect(() =>
      indexOf([
        record("a", [1, 0, 0, 0]),
        record("a", [0, 1, 0, 0], { selectionTextDigest: "sha256:edited" }),
      ]),
    ).not.toThrow();
  });

  it("searches only the eligible Card Versions, and fills the limit from them", () => {
    const index = indexOf([
      record("cv_closest", [1, 0, 0, 0]),
      record("cv_second", [0.9, 0.1, 0, 0]),
      record("cv_third", [0.8, 0.2, 0, 0]),
      record("cv_far", [0, 0, 1, 0]),
    ]);

    const eligible = new Set(["cv_third", "cv_far"]);
    const hits = index.topK([1, 0, 0, 0], 2, { eligibleVersionIds: eligible });

    // The two closest records are ineligible and never take a place in the
    // limit: a post-filter over `topK(…, 2)` would have returned nothing.
    expect(hits.map((hit) => hit.cardVersionId)).toEqual(["cv_third", "cv_far"]);
  });

  it("returns nothing, not everything, for an empty eligible set", () => {
    const index = indexOf([record("cv_a", [1, 0, 0, 0])]);

    expect(index.topK([1, 0, 0, 0], 5, { eligibleVersionIds: new Set() })).toEqual([]);
  });

  it("searches the whole index when no eligible set is given", () => {
    const index = indexOf([
      record("cv_a", [1, 0, 0, 0]),
      record("cv_b", [0, 1, 0, 0]),
    ]);

    expect(index.topK([1, 0, 0, 0], 5)).toHaveLength(2);
    expect(index.topK([1, 0, 0, 0], 5, {})).toHaveLength(2);
  });

  it("matches a full-allocation reference for fixed random catalogs", () => {
    const random = deterministicRandom(0x51ec710);
    const records = Array.from({ length: 257 }, (_unused, position) =>
      record(
        `cv_${String(position).padStart(3, "0")}`,
        position === 0
          ? [0, 0, 0, 0]
          : Array.from({ length: 4 }, () => random() * 20 - 10),
      ),
    );
    const index = indexOf(records);
    const eligible = new Set(
      records
        .filter((_record, position) => position % 3 !== 0)
        .map((candidate) => candidate.cardVersionId),
    );

    for (let queryIndex = 0; queryIndex < 64; queryIndex += 1) {
      const query =
        queryIndex === 0
          ? [0, 0, 0, 0]
          : Array.from({ length: 4 }, () => random() * 8 - 4);
      for (const limit of [0, 1, 32, records.length, records.length + 20]) {
        for (const candidateEligible of [undefined, eligible] as const) {
          const options =
            candidateEligible === undefined
              ? {}
              : { eligibleVersionIds: candidateEligible };
          expect(index.topK(query, limit, options)).toEqual(
            referenceTopK(records, query, limit, candidateEligible),
          );
        }
      }
    }
  });

  it("reports coverage on the Card Version and its digest together", () => {
    const index = indexOf([record("a", [1, 0, 0, 0])]);

    expect(index.covers("a", "sha256:a")).toBe(true);
    // The Card was edited: its vector is stale, and a stale vector produces a
    // plausible ranking rather than an error, so coverage has to say no.
    expect(index.covers("a", "sha256:edited")).toBe(false);
    expect(index.covers("b", "sha256:b")).toBe(false);
  });
});

function referenceTopK(
  records: readonly CardCandidateRecord[],
  query: readonly number[],
  limit: number,
  eligibleVersionIds?: ReadonlySet<string>,
) {
  if (limit <= 0 || Number.isNaN(limit)) return [];
  return records
    .filter(
      (candidate) =>
        eligibleVersionIds === undefined ||
        eligibleVersionIds.has(candidate.cardVersionId),
    )
    .map((candidate) => ({
      cardId: candidate.cardId,
      cardVersionId: candidate.cardVersionId,
      similarity: cosineSimilarity(query, candidate.embedding),
    }))
    .sort((left, right) => {
      if (left.similarity !== right.similarity) {
        return right.similarity - left.similarity;
      }
      if (left.cardVersionId < right.cardVersionId) return -1;
      return left.cardVersionId > right.cardVersionId ? 1 : 0;
    })
    .slice(0, limit);
}

function deterministicRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe("catalogSnapshotVersion", () => {
  const entries = [
    { cardVersionId: "b", selectionTextDigest: "sha256:b" },
    { cardVersionId: "a", selectionTextDigest: "sha256:a" },
  ];

  it("ignores the order the catalog listed its Cards in", () => {
    expect(catalogSnapshotVersion(entries, TEST_CARD_PROFILE)).toBe(
      catalogSnapshotVersion([...entries].reverse(), TEST_CARD_PROFILE),
    );
  });

  it("moves when a Card's text moves", () => {
    expect(
      catalogSnapshotVersion(
        [entries[0]!, { cardVersionId: "a", selectionTextDigest: "sha256:x" }],
        TEST_CARD_PROFILE,
      ),
    ).not.toBe(catalogSnapshotVersion(entries, TEST_CARD_PROFILE));
  });

  it("moves when the profile moves", () => {
    // Same Cards, different vector space. An index prepared under one and
    // searched under the other is not stale, it is wrong.
    expect(
      catalogSnapshotVersion(entries, {
        ...TEST_CARD_PROFILE,
        version: "2",
      }),
    ).not.toBe(catalogSnapshotVersion(entries, TEST_CARD_PROFILE));
  });

  it("distinguishes an empty catalog from a one-Card one", () => {
    expect(catalogSnapshotVersion([], TEST_CARD_PROFILE)).not.toBe(
      catalogSnapshotVersion([entries[0]!], TEST_CARD_PROFILE),
    );
  });
});
