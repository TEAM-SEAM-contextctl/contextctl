import {
  IndexCatalogFault,
  ManagedDocumentSearchError,
  type DocumentSearchHit,
  type IndexPublicationStore,
  type ManagedDocumentSearchCommand,
  type ManagedDocumentSearchErrorCode,
  type PublishedIndexVersion,
} from "@contextctl/ingestion-indexing";
import {
  DocumentRetrievalFault,
  type ApprovedDocumentIndexRef,
  type ApprovedDocumentSelection,
  type DocumentChunkQuery,
  type DocumentRetrievalFaultCode,
  type ManagedDocumentRetriever,
  type RetrievedChunk,
} from "@contextctl/selection-delivery";

/**
 * The published Scope shape `ManagedDocumentSearch` accepts.
 *
 * Derived from the command instead of imported from `@contextctl/contracts`,
 * so assembling this one adapter does not put a contract-package dependency on
 * the daemon for a type it never does anything with but forward.
 */
export type SearchablePublishedScope = ManagedDocumentSearchCommand["scope"];

/**
 * The single method of `ManagedDocumentSearch` this adapter calls.
 *
 * Named structurally so a test can stand in a search that fails with a chosen
 * code. `ManagedDocumentSearch` carries private fields, so depending on the
 * class itself would make every failure-mapping test go through a cast, and a
 * cast is exactly the thing that stops proving the mapping is reachable.
 */
export interface ManagedDocumentSearchPort {
  search(
    command: ManagedDocumentSearchCommand,
  ): Promise<readonly DocumentSearchHit[]>;
}

export interface IngestionManagedDocumentRetrieverDependencies {
  readonly search: ManagedDocumentSearchPort;
  readonly publications: IndexPublicationStore;
  /**
   * The isolation key every search of this retriever is made under.
   *
   * It is configuration, not something derived from the Card: Ingestion decided
   * that a publication's `securityDomain` is "never serialized into a Published
   * Scope" (`published-index-version.ts:21`), so it is absent from Registry's
   * read model and from Selection's, and no honest derivation path exists.
   * Reconstructing one from `connectorId` or `accessHandle` would be this
   * adapter inventing a security judgement it is not entitled to make. Declared
   * by the Composition Root instead, a wrong value fails loudly and specifically
   * as `security_domain_mismatch` rather than silently widening access.
   */
  readonly securityDomain: string;
}

/**
 * Serves Selection's `ManagedDocumentRetriever` from Ingestion's
 * `ManagedDocumentSearch`.
 *
 * ADR 0002 puts the search port in Selection and leaves this connection to the
 * daemon, which is the only place allowed to name both domains. The two sides
 * do not meet cleanly, and the three translations below are the whole job:
 *
 *  1. The Scope has to be rebuilt. Selection holds an approved read model that
 *     Registry translated field by field out of the published Scope
 *     (`retrieval-scope.ts:75`), and Ingestion will only search a Scope that is
 *     byte-identical to one it published (`managed-document-search.ts:281-290`).
 *     Reversing that translation is exact, except for the part the port drops —
 *     see `#resolveScope`.
 *  2. Rank has to become a score, because Ingestion refuses to expose provider
 *     similarity and Selection ranks on [0, 1] — see `scoreFromRank`.
 *  3. Fifteen failure codes have to answer in a vocabulary of three, and most
 *     of them cannot — see `translateSearchFailure`.
 */
export class IngestionManagedDocumentRetriever
  implements ManagedDocumentRetriever
{
  readonly #search: ManagedDocumentSearchPort;
  readonly #publications: IndexPublicationStore;
  readonly #securityDomain: string;

  constructor(dependencies: IngestionManagedDocumentRetrieverDependencies) {
    this.#search = dependencies.search;
    this.#publications = dependencies.publications;
    this.#securityDomain = dependencies.securityDomain;
  }

  async searchChunks(
    query: DocumentChunkQuery,
  ): Promise<readonly RetrievedChunk[]> {
    const scope = await this.#resolveScope(query);

    let hits: readonly DocumentSearchHit[];
    try {
      hits = await this.#search.search({
        queryText: query.queryText,
        securityDomain: this.#securityDomain,
        scope,
        limit: query.limit,
      });
    } catch (cause: unknown) {
      throw translateSearchFailure(cause);
    }

    return hits.map(toRetrievedChunk);
  }

  /**
   * Rebuilds the published Scope this query stands for.
   *
   * `DocumentChunkQuery` carries the document index and the selection but not
   * `scopeId` / `scopeVersion`: Selection keeps those in
   * `ApprovedManagedDocumentScope.reference` and hands the retriever only what
   * bounds one search. Ingestion, however, matches the whole Scope, identity
   * included, so the pair has to come from somewhere — and inventing it (an
   * empty string, a value derived from the index) would turn a Scope that was
   * never published into one that looks published.
   *
   * They are read back out of the publication instead. The catalog record for
   * the pinned `indexVersion` lists every Scope published against it, so the
   * one whose index and selector match this query is the Scope Registry
   * approved, and its identity is the published identity by construction.
   *
   * A duplicate — two published Scopes agreeing on index and selector but
   * differing in identity — cannot change what is retrieved: the vector query
   * is built from the index and the selector alone
   * (`managed-document-search.ts:328-335`), so every candidate yields the same
   * chunks. The first match in published order is therefore taken without
   * disambiguating.
   *
   * `findVersion` rather than `current`: the approved Scope pins an
   * `indexVersion`, and answering from whatever is current would quietly serve
   * a different version of the document than the one that was approved.
   */
  async #resolveScope(
    query: DocumentChunkQuery,
  ): Promise<SearchablePublishedScope> {
    const publication = await this.#findPublication(query.documentIndex);
    const published = publication?.scopes.find((scope) =>
      isSameScope(scope, query),
    );
    if (published === undefined) {
      // Same reading as Ingestion's own `scope_not_published`: what the Card
      // points at is not what is published at that version.
      throw new DocumentRetrievalFault("index_version_mismatch");
    }
    return toPublishedScope(published.scopeId, published.scopeVersion, query);
  }

  /**
   * Reads the catalog record the search would have read anyway.
   *
   * Its failures are reduced to Ingestion's search vocabulary first, exactly as
   * `managed-document-search.ts:501` does, so that a catalog that is down
   * reports the same thing whether it failed here or one call later.
   */
  async #findPublication(
    documentIndex: ApprovedDocumentIndexRef,
  ): Promise<PublishedIndexVersion | undefined> {
    try {
      return await this.#publications.findVersion({
        documentIndexId: documentIndex.documentIndexId,
        indexVersion: documentIndex.indexVersion,
      });
    } catch (cause: unknown) {
      throw translateSearchFailure(reduceCatalogFault(cause));
    }
  }
}

/**
 * Rebuilds one published Scope field by field.
 *
 * Never a spread: `PublishedDocumentScopeSchema` is `.strict()`, so one extra
 * property makes the whole search an `invalid_request`, and naming the fields
 * is what makes that impossible to do by accident. The field set here is the
 * exact inverse of the two translations that produced the read model —
 * `translatePublishedScope` (registry) and `toApprovedScope` (this package).
 */
function toPublishedScope(
  scopeId: string,
  scopeVersion: string,
  query: DocumentChunkQuery,
): SearchablePublishedScope {
  return {
    scopeId,
    scopeVersion,
    kind: "managed_document",
    documentIndex: {
      documentIndexId: query.documentIndex.documentIndexId,
      sourceId: query.documentIndex.sourceId,
      documentId: query.documentIndex.documentId,
      indexVersion: query.documentIndex.indexVersion,
      connectorId: query.documentIndex.connectorId,
      accessHandle: query.documentIndex.accessHandle,
    },
    selector: toSelector(query.selection),
  };
}

/**
 * `selection` back into `selector`, under its published name.
 *
 * `semanticUnitIds` are copied in the order they arrive and never sorted. The
 * contract requires them sorted and unique, but the publisher already emitted
 * them that way; re-sorting here would repair a read model that had been
 * corrupted upstream instead of letting it fail where it can be seen.
 */
function toSelector(
  selection: ApprovedDocumentSelection,
): SearchablePublishedScope["selector"] {
  switch (selection.kind) {
    case "document":
      return { kind: "document" };
    case "semantic_units":
      return {
        kind: "semantic_units",
        semanticUnitIds: [...selection.semanticUnitIds],
      };
    default: {
      const unreachable: never = selection;
      throw new Error(
        `unknown approved document selection kind: ${JSON.stringify(unreachable)}`,
      );
    }
  }
}

/**
 * Whether a published Scope is the one this query is bounded by.
 *
 * Compared field by field rather than by serializing both sides: Ingestion's
 * `canonicalJson` is package-internal, and a hand-written comparison names the
 * fields that have to agree, so a field added to either shape shows up here as
 * a compile error rather than as a comparison that quietly stops being total.
 */
function isSameScope(
  scope: SearchablePublishedScope,
  query: DocumentChunkQuery,
): boolean {
  const { documentIndex, selector } = scope;
  return (
    documentIndex.documentIndexId === query.documentIndex.documentIndexId &&
    documentIndex.sourceId === query.documentIndex.sourceId &&
    documentIndex.documentId === query.documentIndex.documentId &&
    documentIndex.indexVersion === query.documentIndex.indexVersion &&
    documentIndex.connectorId === query.documentIndex.connectorId &&
    documentIndex.accessHandle === query.documentIndex.accessHandle &&
    isSameSelector(selector, query.selection)
  );
}

function isSameSelector(
  selector: SearchablePublishedScope["selector"],
  selection: ApprovedDocumentSelection,
): boolean {
  if (selector.kind === "document" || selection.kind === "document") {
    return selector.kind === selection.kind;
  }
  return (
    selector.semanticUnitIds.length === selection.semanticUnitIds.length &&
    selector.semanticUnitIds.every(
      (unitId, index) => unitId === selection.semanticUnitIds[index],
    )
  );
}

function toRetrievedChunk(hit: DocumentSearchHit): RetrievedChunk {
  return {
    chunkId: hit.chunkId,
    chunkRevisionId: hit.chunkRevisionId,
    semanticUnitId: hit.semanticUnitId,
    documentId: hit.documentId,
    contentDigest: hit.contentDigest,
    text: hit.text,
    score: scoreFromRank(hit.rank),
  };
}

/**
 * `1 / rank`.
 *
 * Ingestion deliberately withholds provider similarity — `DocumentSearchHit`
 * carries a rank and nothing else — while Selection's ranking band is stated on
 * [0, 1], so a score has to be manufactured out of position alone.
 *
 * `(limit - rank + 1) / limit` was rejected. `limit` is the caller's own knob
 * (`resolve-context.ts:70`, `chunkLimitPerScope`), so under that rule the same
 * chunk at the same rank scores differently depending on how many chunks the
 * caller asked for — the score would carry the caller's configuration rather
 * than anything the search found. `1 / rank` depends on rank only, always lands
 * in (0, 1] for rank >= 1, and never reaches 0, so a real hit is never floored
 * to the value an irrelevant one would get.
 *
 * Cross-Scope ordering is unaffected by the choice: both rules decrease
 * monotonically in rank and `resolveContext` passes every Scope the same limit
 * (`resolve-context.ts:230-232`), so the merged order is identical either way.
 * What separates them is only whether the number claims something it does not
 * know.
 *
 * This is an interim rule, not a policy. If scores ever have to be comparable
 * across indexes or fed into a threshold of their own, it belongs in the domain
 * as a versioned policy rather than here.
 *
 * The guard mirrors `clampToUnitInterval` (`query-scoring.ts:248`), including
 * its choice to answer 0 for a non-finite value rather than let it reach a
 * comparison that would be false against everything.
 */
function scoreFromRank(rank: number): number {
  const score = 1 / rank;
  if (!Number.isFinite(score)) {
    return 0;
  }
  return Math.min(Math.max(score, 0), 1);
}

/**
 * The failures that survive the trip into Selection's three-code vocabulary.
 *
 * Deliberately partial. `resolve-context.ts:275-281` catches everything and
 * records anything that is not a `DocumentRetrievalFault` as `retriever_error`,
 * so a code with no honest translation is better left untranslated: forcing
 * `query_embedding_failed` into `index_unavailable` would tell a consumer the
 * index is down when it is not, whereas letting it through preserves the one
 * true statement available — that the failure has no name on this side.
 */
const RETRIEVAL_FAULTS: Partial<
  Record<ManagedDocumentSearchErrorCode, DocumentRetrievalFaultCode>
> = {
  security_domain_mismatch: "access_denied",
  embedding_provider_not_allowed: "access_denied",
  scope_not_published: "index_version_mismatch",
  index_schema_unsupported: "index_version_mismatch",
  index_binding_unavailable: "index_unavailable",
  index_catalog_unavailable: "index_unavailable",
  vector_search_unavailable: "index_unavailable",
};

/** Returns what should be thrown: a translated fault, or the cause untouched. */
function translateSearchFailure(cause: unknown): unknown {
  if (cause instanceof ManagedDocumentSearchError) {
    const code = RETRIEVAL_FAULTS[cause.code];
    if (code !== undefined) {
      return new DocumentRetrievalFault(code);
    }
  }
  return cause;
}

/** The same reduction `managed-document-search.ts:501` applies to a catalog read. */
function reduceCatalogFault(cause: unknown): unknown {
  if (!(cause instanceof IndexCatalogFault)) {
    return new ManagedDocumentSearchError("index_catalog_unavailable", true);
  }
  if (cause.code === "schema_unsupported") {
    return new ManagedDocumentSearchError("index_schema_unsupported");
  }
  if (cause.code === "corrupt_record") {
    return new ManagedDocumentSearchError("index_catalog_corrupt");
  }
  return new ManagedDocumentSearchError(
    "index_catalog_unavailable",
    cause.retriable,
  );
}
