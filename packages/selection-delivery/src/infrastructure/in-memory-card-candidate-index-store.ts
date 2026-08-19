import {
  CardCandidateIndex,
  type CardCandidateRecord,
} from "../domain/card-candidate-index.js";
import { CardSelectionInputLimitError } from "../domain/errors.js";
import type { CardSelectionEntry } from "../domain/card-selection-text.js";
import type { CardSelectionProfile } from "../domain/card-selection-profile.js";
import { CardEmbeddingFault } from "../ports/card-embedding.js";
import type {
  CardCandidateIndexRequest,
  CardCandidateIndexStore,
} from "../ports/card-candidate-index-store.js";

/**
 * Keeps one prepared candidate index in this process, and replaces it whole.
 *
 * Two rules make the swap safe, and both are about the window during which a
 * rebuild is running.
 *
 * The snapshot is fixed first. Every Card that will be in the index, and the
 * digest of the text each one will be embedded from, is decided before a single
 * vector is requested — so a Card approved halfway through a rebuild lands in
 * the *next* snapshot rather than in a half-built version of this one.
 *
 * The pointer moves last. `#current` is assigned only after every vector has
 * come back and the index has been constructed, so a reader either sees the
 * whole previous snapshot or the whole new one. There is no state in which a
 * query is scored against an index that is missing the Cards it has not reached
 * yet — which would not fail, it would simply not find them, and a Card silently
 * absent from a ranking is indistinguishable from a Card that scored badly.
 *
 * A rebuild in flight is shared rather than duplicated: two concurrent queries
 * that see the same new snapshot await one build instead of each embedding the
 * whole catalog. A failed build is forgotten rather than cached, so the next
 * query retries instead of inheriting a permanent failure.
 */
export class InMemoryCardCandidateIndexStore implements CardCandidateIndexStore {
  #current: CardCandidateIndex | undefined;
  #pending: Promise<CardCandidateIndex> | undefined;
  #pendingVersion: string | undefined;

  /** The snapshot readers are currently served, or `undefined` before the first. */
  get current(): CardCandidateIndex | undefined {
    return this.#current;
  }

  async acquire(
    request: CardCandidateIndexRequest,
  ): Promise<CardCandidateIndex> {
    const current = this.#current;
    if (current?.catalogSnapshotVersion === request.catalogSnapshotVersion) {
      return current;
    }
    if (
      this.#pending === undefined ||
      this.#pendingVersion !== request.catalogSnapshotVersion
    ) {
      this.#pendingVersion = request.catalogSnapshotVersion;
      this.#pending = this.#build(request).finally(() => {
        // Cleared whether the build succeeded or failed: on success `#current`
        // now answers, and on failure keeping the rejected promise would make
        // every later query replay one transient provider fault forever.
        if (this.#pendingVersion === request.catalogSnapshotVersion) {
          this.#pending = undefined;
          this.#pendingVersion = undefined;
        }
      });
    }
    return this.#pending;
  }

  async #build(
    request: CardCandidateIndexRequest,
  ): Promise<CardCandidateIndex> {
    assertEntriesWithinLimit(request.entries, request.profile);

    const vectors = await embedEntries(request);
    const records = request.entries.map((entry): CardCandidateRecord => {
      const vector = vectors.get(entry.cardVersionId);
      if (vector === undefined) {
        // The provider answered for fewer inputs than it was given, or renamed
        // a key. Either way a Card would be silently absent from every ranking,
        // so the build fails instead of publishing a partial snapshot.
        throw new CardEmbeddingFault("invalid_response", false);
      }
      return {
        cardId: entry.cardId,
        cardVersionId: entry.cardVersionId,
        catalogSnapshotVersion: request.catalogSnapshotVersion,
        selectionTextDigest: entry.selectionTextDigest,
        embeddingProfileId: request.profile.id,
        embeddingProfileVersion: request.profile.version,
        embedding: vector,
      };
    });

    const index = new CardCandidateIndex({
      catalogSnapshotVersion: request.catalogSnapshotVersion,
      profile: request.profile,
      records,
    });
    // The pointer swap, and the last statement of the build for that reason.
    this.#current = index;
    return index;
  }
}

/**
 * Refuses the whole snapshot when one Card is over the admission limit.
 *
 * Before any vector is requested, so an unusable catalog costs no inference at
 * all — and so the failure names the Card rather than arriving as a provider
 * error halfway through a batch.
 */
function assertEntriesWithinLimit(
  entries: readonly CardSelectionEntry[],
  profile: CardSelectionProfile,
): void {
  for (const entry of entries) {
    if (entry.units > profile.admissionLimits.maxCardUnits) {
      throw new CardSelectionInputLimitError(
        `card version ${entry.cardVersionId} measures ${entry.units} ${profile.admissionLimits.textMeasureProfileVersion} units, above the ${profile.admissionLimits.maxCardUnits} this profile admits`,
      );
    }
  }
}

/**
 * One batch call, keyed by Card Version id.
 *
 * Keys rather than positions, because a provider that reorders or retries
 * internally would otherwise attach one Card's vector to another Card's record —
 * a corruption that produces a plausible ranking and no error anywhere.
 */
async function embedEntries(
  request: CardCandidateIndexRequest,
): Promise<ReadonlyMap<string, readonly number[]>> {
  if (request.entries.length === 0) {
    return new Map();
  }

  const outputs = await request.embedding.embed({
    profile: request.profile,
    inputs: request.entries.map((entry) => ({
      key: entry.cardVersionId,
      text: entry.payload,
    })),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });

  const vectors = new Map<string, readonly number[]>();
  for (const output of outputs) {
    vectors.set(output.key, output.vector);
  }
  return vectors;
}
