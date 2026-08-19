import type { CardCandidateIndex } from "../domain/card-candidate-index.js";
import type { CardSelectionEntry } from "../domain/card-selection-text.js";
import type { CardSelectionProfile } from "../domain/card-selection-profile.js";
import type { CardEmbeddingPort } from "./card-embedding.js";

/**
 * Holds the prepared candidate index between requests.
 *
 * A port rather than a function because the thing it owns is *state that
 * outlives one request*: embedding every approved Card takes a model call per
 * Card, and doing that on every query would make the semantic path cost more
 * than the answer. Selection is not entitled to decide how long that state
 * lives or where it lives — that is a Composition Root decision, exactly like
 * binding a store — so Selection declares what it needs and the daemon binds an
 * implementation.
 *
 * The contract is three sentences. Given a catalog snapshot, `acquire` returns
 * an index that covers exactly that snapshot. It may return a previously
 * prepared one only when that one was prepared for the same
 * `catalogSnapshotVersion`. And the index it returns is immutable, so the caller
 * may hold it for the whole request and keep searching one snapshot even while a
 * newer one is being prepared behind it.
 */
export interface CardCandidateIndexStore {
  acquire(request: CardCandidateIndexRequest): Promise<CardCandidateIndex>;
}

export interface CardCandidateIndexRequest {
  /** One entry per approved Card Version in the snapshot, digests included. */
  readonly entries: readonly CardSelectionEntry[];
  /** `catalogSnapshotVersion(...)` over those entries and this profile. */
  readonly catalogSnapshotVersion: string;
  readonly profile: CardSelectionProfile;
  readonly embedding: CardEmbeddingPort;
  readonly signal?: AbortSignal;
}
