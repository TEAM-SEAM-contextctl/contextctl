import type {
  CardCandidateIndex,
  CardCandidateIndexRequest,
  CardCandidateIndexStore,
  CardEmbeddingPort,
} from "@contextctl/selection-delivery";

import type { AdmissionLane } from "./admission.js";

/**
 * Routes candidate-index rebuilds through the Selection assets lane.
 *
 * The rebuild is background work by the design's own lane table — low priority,
 * one catalog snapshot at a time — but it is reached from a Resolve, because the
 * store rebuilds lazily when the snapshot it holds is stale. Left unrouted it
 * would be the one piece of background work with no limit at all, running as
 * many times concurrently as there were queries that noticed the change.
 *
 * Rebuilds for the same snapshot are merged rather than queued. That is the
 * design's rule for this lane, and it is also what keeps the lane's depth of one
 * from turning a catalog update into a burst of refusals: eight queries that all
 * notice the same new snapshot produce one rebuild and eight callers waiting on
 * it, not eight admissions of which six are turned away.
 */
export class LaneBoundCardCandidateIndexStore
  implements CardCandidateIndexStore
{
  readonly #inner: CardCandidateIndexStore;
  readonly #lane: AdmissionLane;
  readonly #backgroundEmbedding: CardEmbeddingPort | undefined;
  readonly #inFlight = new Map<string, Promise<CardCandidateIndex>>();

  constructor(
    inner: CardCandidateIndexStore,
    lane: AdmissionLane,
    backgroundEmbedding?: CardEmbeddingPort,
  ) {
    this.#inner = inner;
    this.#lane = lane;
    this.#backgroundEmbedding = backgroundEmbedding;
  }

  async acquire(
    request: CardCandidateIndexRequest,
  ): Promise<CardCandidateIndex> {
    // Keyed on the snapshot the caller asked for, and on nothing else. Two
    // callers naming the same snapshot want the same index by definition — the
    // version is a digest over the entries and the profile — so answering both
    // from one build is not a cache, it is the identity of the thing.
    const key = request.catalogSnapshotVersion;
    const existing = this.#inFlight.get(key);
    if (existing !== undefined) {
      return await existing;
    }

    const build = this.#lane
      .run(
        async () =>
          await this.#inner.acquire(
            this.#backgroundEmbedding === undefined
              ? request
              : { ...request, embedding: this.#backgroundEmbedding },
          ),
        // The caller's cancellation is deliberately not forwarded. One
        // abandoning caller must not cancel a build the others are still
        // waiting on, and the build is bounded by the lane rather than by any
        // single request.
        {},
      )
      .finally(() => {
        this.#inFlight.delete(key);
      });

    this.#inFlight.set(key, build);
    return await build;
  }
}
