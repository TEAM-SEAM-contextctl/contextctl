import { canonicalDigest } from "./canonical-digest.js";
import type { CardSelectionProfile } from "./card-selection-profile.js";
import { CardCandidateIndexInvariantError } from "./errors.js";

/**
 * One Card Version's vector, with everything needed to know it is still valid.
 *
 * The record is identified by `(cardVersionId, selectionTextDigest,
 * embeddingProfileId, embeddingProfileVersion)` rather than by `cardVersionId`
 * alone, and each of the other three answers a different "is this still the
 * right vector" question. The digest answers "was this built from the Card as it
 * reads now"; the profile id and version answer "was this built in the same
 * vector space we are about to compare it in". A record that keeps only the
 * Card id cannot answer either, and a stale vector produces a plausible ranking
 * rather than an error.
 *
 * `catalogSnapshotVersion` is on the record as well as on the index because a
 * record travels: it is the snapshot the vector was prepared under, so a record
 * carried into a different index is recognisable as foreign.
 */
export interface CardCandidateRecord {
  readonly cardId: string;
  readonly cardVersionId: string;
  readonly catalogSnapshotVersion: string;
  readonly selectionTextDigest: string;
  readonly embeddingProfileId: string;
  readonly embeddingProfileVersion: string;
  readonly embedding: readonly number[];
}

/** One Card the semantic path reached, and how close it came. */
export interface CardSimilarity {
  readonly cardId: string;
  readonly cardVersionId: string;
  /** Cosine similarity in [-1, 1]. Never rescaled here — see `hybrid-ranking.ts`. */
  readonly similarity: number;
}

/**
 * The identity of one prepared catalog snapshot.
 *
 * A digest over what the snapshot actually contains — each Card Version and the
 * digest of the text it would be embedded from — plus the profile the vectors
 * would live in. A counter or a timestamp would name a moment rather than a
 * content, so a rebuild that changed nothing would still look like a new
 * snapshot, and a change that happened between two ticks of the counter would
 * not look like one at all.
 */
export function catalogSnapshotVersion(
  entries: readonly {
    readonly cardVersionId: string;
    readonly selectionTextDigest: string;
  }[],
  profile: CardSelectionProfile,
): string {
  return canonicalDigest({
    profileId: profile.id,
    profileVersion: profile.version,
    dimensions: profile.dimensions,
    cards: [...entries]
      .map((entry) => ({
        cardVersionId: entry.cardVersionId,
        selectionTextDigest: entry.selectionTextDigest,
      }))
      .sort((left, right) =>
        left.cardVersionId < right.cardVersionId
          ? -1
          : left.cardVersionId > right.cardVersionId
            ? 1
            : 0,
      ),
  });
}

/**
 * Every approved Card's vector for one catalog snapshot, searched by cosine.
 *
 * A flat array and a full scan, deliberately. The whole index is one vector per
 * approved Card Version — tens of them in the deployment this is written for,
 * not millions — so an approximate structure would add a recall parameter, a
 * build step and a tuning question in exchange for microseconds, and it would
 * make the ranking depend on which neighbours the structure happened to visit.
 * A full scan is exact, has no parameters, and is the reason two runs over one
 * snapshot return identical orderings. A vector database is the thing to reach
 * for when the catalog stops fitting in memory, and this class is the seam that
 * would be replaced then.
 *
 * The instance is immutable once constructed, which is what lets a request pin
 * one snapshot: `CardCandidateIndexStore` swaps a *pointer* to a fully prepared
 * index, and a request that has already taken the pointer keeps searching the
 * snapshot it started with even while a newer one is being built.
 */
export class CardCandidateIndex {
  readonly catalogSnapshotVersion: string;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly dimensions: number;
  readonly #records: readonly CardCandidateRecord[];

  constructor(input: {
    readonly catalogSnapshotVersion: string;
    readonly profile: CardSelectionProfile;
    readonly records: readonly CardCandidateRecord[];
  }) {
    const seen = new Set<string>();
    for (const record of input.records) {
      if (record.embedding.length !== input.profile.dimensions) {
        throw new CardCandidateIndexInvariantError(
          `card version ${record.cardVersionId} carries ${record.embedding.length} dimensions where profile ${input.profile.id} declares ${input.profile.dimensions}`,
        );
      }
      if (record.embedding.some((component) => !Number.isFinite(component))) {
        throw new CardCandidateIndexInvariantError(
          `card version ${record.cardVersionId} carries a non-finite vector component`,
        );
      }
      if (
        record.embeddingProfileId !== input.profile.id ||
        record.embeddingProfileVersion !== input.profile.version
      ) {
        throw new CardCandidateIndexInvariantError(
          `card version ${record.cardVersionId} was embedded under ${record.embeddingProfileId}/${record.embeddingProfileVersion}, not ${input.profile.id}/${input.profile.version}`,
        );
      }
      const identity = canonicalDigest([
        record.cardVersionId,
        record.selectionTextDigest,
        record.embeddingProfileId,
        record.embeddingProfileVersion,
      ]);
      if (seen.has(identity)) {
        throw new CardCandidateIndexInvariantError(
          `card version ${record.cardVersionId} appears twice in one candidate index`,
        );
      }
      seen.add(identity);
    }

    this.catalogSnapshotVersion = input.catalogSnapshotVersion;
    this.profileId = input.profile.id;
    this.profileVersion = input.profile.version;
    this.dimensions = input.profile.dimensions;
    this.#records = [...input.records];
  }

  get size(): number {
    return this.#records.length;
  }

  /** Whether this index holds a current vector for the given Card Version. */
  covers(cardVersionId: string, selectionTextDigest: string): boolean {
    return this.#records.some(
      (record) =>
        record.cardVersionId === cardVersionId &&
        record.selectionTextDigest === selectionTextDigest,
    );
  }

  /**
   * The `limit` closest Cards in the whole index, most similar first.
   *
   * Over every record rather than over a shortlist someone else produced. That
   * is the difference between a hybrid ranking and a reranked lexical one: a
   * Card that shares no term with the query has a lexical score of zero and
   * would never appear in a lexical shortlist, so if the semantic path only ever
   * looked inside one, the semantic path could not reach it at all.
   *
   * Ties break on `cardVersionId` ascending, matching `selection-verdict.ts`, so
   * two Cards at the same distance always come back in the same order.
   *
   * `eligibleVersionIds`, when given, restricts the search to those Card
   * Versions *before* anything is ranked or cut. That ordering is the whole
   * point: the index is built over the approved catalog so a policy change
   * never forces a rebuild, and the policy is applied at search time as a
   * pre-filter over the exact scan — a record outside the set is never
   * compared, so it cannot occupy a place in the `limit` that an eligible Card
   * would have taken. Removing it after the cut would be the post-filter SOT
   * L88 forbids, and a top-K of twenty could come back with three.
   */
  topK(
    queryVector: readonly number[],
    limit: number,
    options: { readonly eligibleVersionIds?: ReadonlySet<string> } = {},
  ): readonly CardSimilarity[] {
    if (limit <= 0) {
      return [];
    }
    if (queryVector.length !== this.dimensions) {
      throw new CardCandidateIndexInvariantError(
        `a query vector of ${queryVector.length} dimensions cannot be compared against an index of ${this.dimensions}`,
      );
    }

    const eligible = options.eligibleVersionIds;
    const searched =
      eligible === undefined
        ? this.#records
        : this.#records.filter((record) => eligible.has(record.cardVersionId));

    return searched
      .map((record) => ({
        cardId: record.cardId,
        cardVersionId: record.cardVersionId,
        similarity: cosineSimilarity(queryVector, record.embedding),
      }))
      .sort(compareBySimilarity)
      .slice(0, limit);
  }
}

function compareBySimilarity(
  left: CardSimilarity,
  right: CardSimilarity,
): number {
  if (left.similarity !== right.similarity) {
    return right.similarity - left.similarity;
  }
  // `<` / `>` rather than `localeCompare`, for the reason `selection-verdict.ts`
  // gives: a locale-sensitive comparison makes the same input rank differently
  // on two machines.
  if (left.cardVersionId < right.cardVersionId) {
    return -1;
  }
  return left.cardVersionId > right.cardVersionId ? 1 : 0;
}

/**
 * Cosine similarity, computed rather than assumed from the norms.
 *
 * Both profiles declare `normalization: "l2"`, so a dot product would almost
 * always be the same number — but "almost always" is the problem: a provider
 * that returned an unnormalized vector would silently produce similarities
 * outside [-1, 1] and every threshold downstream would be meaningless. Dividing
 * by the magnitudes costs one square root per record and makes the range a fact
 * rather than a promise.
 *
 * A zero vector has no direction, so its similarity to anything is defined as 0
 * rather than as a division by zero.
 */
export function cosineSimilarity(
  left: readonly number[],
  right: readonly number[],
): number {
  let dot = 0;
  let leftSquares = 0;
  let rightSquares = 0;

  for (let index = 0; index < left.length; index += 1) {
    const leftComponent = left[index] ?? 0;
    const rightComponent = right[index] ?? 0;
    dot += leftComponent * rightComponent;
    leftSquares += leftComponent * leftComponent;
    rightSquares += rightComponent * rightComponent;
  }

  const magnitude = Math.sqrt(leftSquares) * Math.sqrt(rightSquares);
  if (magnitude === 0 || !Number.isFinite(magnitude)) {
    return 0;
  }
  // Clamped because floating point can put a self-similarity a few ulps above
  // 1, and a similarity above 1 would move a score past a threshold that was
  // tuned on the closed interval.
  return Math.min(Math.max(dot / magnitude, -1), 1);
}
