import {
  buildCardSelectionEntry,
  catalogSnapshotVersion,
  type ApprovedCard,
  type ApprovedCardCatalog,
  type CardCandidateIndex,
  type CardCandidateIndexRequest,
  type CardCandidateIndexStore,
  type CardEmbeddingPort,
  type CardSelectionProfile,
} from "@contextctl/selection-delivery";

/**
 * Keeps the two most recent immutable candidate indexes addressable.
 *
 * A replacement is built before the approved-Card pointer moves. During that
 * window in-flight Resolve work still names the previous catalog digest, so a
 * one-entry cache would rebuild the old index and oscillate. Two immutable
 * generations are sufficient: existing callers already hold the object they
 * acquired, while new callers use the newly activated generation.
 */
export class RetainingCardCandidateIndexStore
  implements CardCandidateIndexStore
{
  readonly #inner: CardCandidateIndexStore;
  readonly #cache = new Map<string, CardCandidateIndex>();
  readonly #pending = new Map<string, Promise<CardCandidateIndex>>();

  constructor(inner: CardCandidateIndexStore) {
    this.#inner = inner;
  }

  async acquire(request: CardCandidateIndexRequest): Promise<CardCandidateIndex> {
    const cached = this.#cache.get(request.catalogSnapshotVersion);
    if (cached !== undefined) return cached;
    const pending = this.#pending.get(request.catalogSnapshotVersion);
    if (pending !== undefined) return await pending;

    const build = this.#inner.acquire(request).then((index) => {
      this.#cache.delete(index.catalogSnapshotVersion);
      this.#cache.set(index.catalogSnapshotVersion, index);
      while (this.#cache.size > 2) {
        const oldest = this.#cache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.#cache.delete(oldest);
      }
      return index;
    });
    this.#pending.set(request.catalogSnapshotVersion, build);
    try {
      return await build;
    } finally {
      if (this.#pending.get(request.catalogSnapshotVersion) === build) {
        this.#pending.delete(request.catalogSnapshotVersion);
      }
    }
  }
}

export interface PreparedApprovedCardCatalogOptions {
  readonly upstream: ApprovedCardCatalog;
  readonly index: CardCandidateIndexStore;
  readonly profile: CardSelectionProfile;
  readonly embedding: CardEmbeddingPort;
}

/**
 * Moves the approved catalog and its candidate index as one prepared asset.
 *
 * `listApprovedCards` never waits for a rebuild. It starts a coalesced refresh
 * and serves the last fully prepared immutable generation, so an operator
 * approval cannot turn the next user request into a multi-second model build.
 * Startup and one-shot CLI paths call `refresh` explicitly before admitting a
 * request, which gives the first generation the same guarantee.
 */
export class PreparedApprovedCardCatalog implements ApprovedCardCatalog {
  readonly #upstream: ApprovedCardCatalog;
  readonly #index: CardCandidateIndexStore;
  readonly #profile: CardSelectionProfile;
  readonly #embedding: CardEmbeddingPort;
  #active: readonly ApprovedCard[] = [];
  #activeVersion: string | undefined;
  #pending: Promise<void> | undefined;
  #refreshRequested = false;
  #lastFailureCode: string | undefined;

  constructor(options: PreparedApprovedCardCatalogOptions) {
    this.#upstream = options.upstream;
    this.#index = options.index;
    this.#profile = options.profile;
    this.#embedding = options.embedding;
  }

  get status(): {
    readonly activeSnapshotVersion?: string;
    readonly refreshing: boolean;
    readonly lastFailureCode?: string;
  } {
    return {
      ...(this.#activeVersion === undefined
        ? {}
        : { activeSnapshotVersion: this.#activeVersion }),
      refreshing: this.#pending !== undefined,
      ...(this.#lastFailureCode === undefined
        ? {}
        : { lastFailureCode: this.#lastFailureCode }),
    };
  }

  async listApprovedCards(): Promise<readonly ApprovedCard[]> {
    void this.refresh().catch(() => undefined);
    return this.#active;
  }

  async refresh(): Promise<void> {
    // A request arriving while one refresh is settling is not discarded. The
    // upstream catalog may have changed after that cycle took its snapshot, so
    // one more coalesced pass is required before the caller's refresh is done.
    this.#refreshRequested = true;
    if (this.#pending !== undefined) return await this.#pending;
    const refresh = this.#runRefreshLoop().finally(() => {
      if (this.#pending === refresh) this.#pending = undefined;
    });
    this.#pending = refresh;
    return await refresh;
  }

  async #runRefreshLoop(): Promise<void> {
    while (this.#refreshRequested) {
      this.#refreshRequested = false;
      await this.#refresh();
    }
  }

  async #refresh(): Promise<void> {
    try {
      const approved = await this.#upstream.listApprovedCards();
      const entries = approved.map(buildCardSelectionEntry);
      const version = catalogSnapshotVersion(entries, this.#profile);
      if (version === this.#activeVersion) {
        this.#lastFailureCode = undefined;
        return;
      }
      await this.#index.acquire({
        entries,
        catalogSnapshotVersion: version,
        profile: this.#profile,
        embedding: this.#embedding,
      });
      this.#active = approved;
      this.#activeVersion = version;
      this.#lastFailureCode = undefined;
    } catch (error: unknown) {
      this.#lastFailureCode = safeCode(error);
      throw error;
    }
  }
}

function safeCode(error: unknown): string {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[a-z][a-z0-9_]*$/.test(error.code)
  ) {
    return error.code;
  }
  return "card_candidate_refresh_failed";
}
