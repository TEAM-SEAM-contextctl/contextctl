import { describe, expect, it } from "vitest";

import {
  ManagedDocumentSearchError,
  type CommitIndexPublicationResult,
  type DocumentSearchHit,
  type IndexPublicationStore,
  type ManagedDocumentSearchCommand,
  type ManagedDocumentSearchErrorCode,
  type PublishedIndexVersion,
} from "@contextctl/ingestion-indexing";
import {
  translatePublishedScope,
  toApprovedCardCatalogSnapshot,
  type ApprovedCardCatalogSnapshot,
  type CardCatalogEntry,
  type CardStore,
  type ContextCard,
  type CardVersion,
} from "@contextctl/registry-lifecycle";
import {
  DocumentRetrievalFault,
  type ApprovedManagedDocumentScope,
  type DocumentChunkQuery,
} from "@contextctl/selection-delivery";

import {
  IngestionManagedDocumentRetriever,
  type ManagedDocumentSearchPort,
  type SearchablePublishedScope,
} from "../src/adapters/ingestion-managed-document-retriever.js";
import { RegistryApprovedCardCatalog } from "../src/adapters/registry-approved-card-catalog.js";

const SECURITY_DOMAIN = "payments";

const documentIndex = {
  documentIndexId: "didx_payments",
  sourceId: "src_payments",
  documentId: "doc_payments",
  indexVersion: "idxv_aaaa",
  connectorId: "vector.local",
  accessHandle: "documents/payments/indexes/aaaa",
};

const wholeDocumentScope: SearchablePublishedScope = {
  scopeId: "scope_payments_document",
  scopeVersion: "scpv_aaaa",
  kind: "managed_document",
  documentIndex,
  selector: { kind: "document" },
};

/**
 * Unit ids in an order a sort would change.
 *
 * The published contract requires them sorted, and this fixture violates it on
 * purpose: the adapter must carry the order it was given, so that a read model
 * that lost its ordering fails visibly upstream instead of being repaired here.
 */
const semanticUnitsScope: SearchablePublishedScope = {
  scopeId: "scope_payments_units",
  scopeVersion: "scpv_bbbb",
  kind: "managed_document",
  documentIndex,
  selector: {
    kind: "semantic_units",
    semanticUnitIds: ["unit_refunds", "unit_failures"],
  },
};

function publicationWith(
  scopes: readonly SearchablePublishedScope[],
): PublishedIndexVersion {
  return {
    securityDomain: SECURITY_DOMAIN,
    documentIndex,
    scopes,
    manifest: {
      documentIndexId: documentIndex.documentIndexId,
      indexVersion: documentIndex.indexVersion,
      sourceId: documentIndex.sourceId,
      observationId: "obs_payments",
      documentId: documentIndex.documentId,
      documentSchemaVersion: 1,
      parserVersion: "11.0.0+gfm-4.0.1",
      normalizationPolicyVersion: "markdown-normalize-v1",
      lineagePolicyVersion: "lineage-v1",
      segmentationPolicyVersion: "segmentation-v1",
      chunkPolicyVersion: "chunk-v1",
      textMeasureProfileVersion: "unicode-estimate-v1",
      embeddingProfile: {
        id: "payments-test",
        version: "1.0.0",
        model: "payments-test-v1",
        dimensions: 3,
        distance: "cosine",
        maxInputTokens: 480,
        textMeasureProfileVersion: "unicode-estimate-v1",
      },
      payloadSchemaVersion: 2,
      semanticUnitRevisions: { unit_failures: "urv_aaaa" },
      chunkRevisions: { chk_aaaa: "crv_aaaa" },
      recordCount: 1,
      recordSetDigest: `sha256:${"a".repeat(64)}`,
      scopeRevisions: scopes.map(({ scopeId, scopeVersion }) => ({
        scopeId,
        scopeVersion,
      })),
      fallbackCounts: {},
      publishedAt: "2026-08-13T06:00:00.000Z",
    },
  };
}

type FindVersionInput = Parameters<IndexPublicationStore["findVersion"]>[0];

/**
 * Answers with one fixed publication, and keeps what it was asked for.
 *
 * Recording the input is what makes the lookup itself testable: every fixture
 * id here is a distinct string, so an adapter that passed `documentId` where
 * `documentIndexId` belongs would still satisfy every other assertion in this
 * file if the argument were discarded.
 *
 * `current` throws rather than answering. The approved Scope pins an
 * `indexVersion`, so serving "whatever is current" would quietly search a
 * different version of the document than the one Registry approved — the
 * adapter's choice of `findVersion` is a decision, and this is what fails when
 * it is reverted.
 */
class FixedPublicationStore implements IndexPublicationStore {
  readonly findVersionInputs: FindVersionInput[] = [];
  readonly #publication: PublishedIndexVersion | undefined;

  constructor(publication?: PublishedIndexVersion) {
    this.#publication = publication;
  }

  findVersion(
    input: FindVersionInput,
  ): Promise<PublishedIndexVersion | undefined> {
    this.findVersionInputs.push(input);
    return Promise.resolve(this.#publication);
  }

  current(): Promise<PublishedIndexVersion | undefined> {
    throw new Error(
      "current() must not be used: the approved scope pins an index version",
    );
  }

  commitCurrent(): Promise<CommitIndexPublicationResult> {
    return Promise.reject(new Error("not exercised by these tests"));
  }
}

/** Answers with fixed hits and keeps the command it was handed. */
class RecordingSearch implements ManagedDocumentSearchPort {
  commands: ManagedDocumentSearchCommand[] = [];

  constructor(private readonly hits: readonly DocumentSearchHit[] = []) {}

  search(
    command: ManagedDocumentSearchCommand,
  ): Promise<readonly DocumentSearchHit[]> {
    this.commands.push(command);
    return Promise.resolve(this.hits);
  }
}

class FailingSearch implements ManagedDocumentSearchPort {
  constructor(private readonly code: ManagedDocumentSearchErrorCode) {}

  search(): Promise<readonly DocumentSearchHit[]> {
    return Promise.reject(new ManagedDocumentSearchError(this.code));
  }
}

function hitAt(rank: number): DocumentSearchHit {
  return {
    rank,
    chunkId: `chk_${String(rank)}`,
    chunkRevisionId: `crv_${String(rank)}`,
    semanticUnitId: "unit_failures",
    documentId: documentIndex.documentId,
    text: "결제 실패는 세 번까지 재시도된다.",
    contentDigest: `sha256:${"b".repeat(64)}`,
  };
}

function queryFor(
  scope: SearchablePublishedScope,
  limit = 8,
): DocumentChunkQuery {
  return {
    queryText: "결제 실패 재시도",
    documentIndex,
    selection:
      scope.selector.kind === "document"
        ? { kind: "document" }
        : {
            kind: "semantic_units",
            semanticUnitIds: [...scope.selector.semanticUnitIds],
          },
    limit,
  };
}

function retrieverFor(
  search: ManagedDocumentSearchPort,
  scopes: readonly SearchablePublishedScope[],
): IngestionManagedDocumentRetriever {
  return new IngestionManagedDocumentRetriever({
    search,
    publications: new FixedPublicationStore(publicationWith(scopes)),
    securityDomain: SECURITY_DOMAIN,
  });
}

async function captureFailure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (cause: unknown) {
    return cause;
  }
  throw new Error("expected the retrieval to fail");
}

/**
 * Runs the read model the whole way back to a published Scope.
 *
 * Registry's translation and this package's Card translation are both real
 * here, so the assertion covers the pair of hops a Scope actually makes rather
 * than a hand-written stand-in for them.
 */
async function roundTrip(
  scope: SearchablePublishedScope,
): Promise<SearchablePublishedScope> {
  const retrievalScope = translatePublishedScope(scope);
  const catalog = new RegistryApprovedCardCatalog(
    new SingleEntryCardStore({
      cardId: "unit_payments",
      versionId: "cv_payments",
      meaning: {
        description: "결제 실패 재시도 정책",
        representativeQuestions: [],
        aliases: [],
        keywords: [],
      },
      policy: { sensitive: false, allowedUsage: ["retrieval"] },
      scopes: [retrievalScope],
    }),
  );

  const approved = (await catalog.listApprovedCards())[0]?.scopes[0];
  if (approved?.kind !== "managed_document") {
    throw new Error("expected a managed document scope");
  }
  const managed: ApprovedManagedDocumentScope = approved;

  const search = new RecordingSearch();
  const retriever = retrieverFor(search, [scope]);
  await retriever.searchChunks({
    queryText: "결제 실패 재시도",
    documentIndex: managed.documentIndex,
    selection: managed.selection,
    limit: 8,
  });

  const command = search.commands[0];
  if (command === undefined) {
    throw new Error("expected the search to have been called");
  }
  return command.scope;
}

class SingleEntryCardStore implements CardStore {
  readonly #entry: CardCatalogEntry;

  constructor(entry: CardCatalogEntry) {
    this.#entry = entry;
  }

  findCard(): Promise<ContextCard | undefined> {
    return Promise.resolve(undefined);
  }

  listCurrentVersions(): Promise<readonly CardVersion[]> {
    return Promise.resolve([]);
  }

  listApprovedCards(): Promise<ApprovedCardCatalogSnapshot> {
    return Promise.resolve(toApprovedCardCatalogSnapshot([this.#entry]));
  }

  saveCard(): Promise<void> {
    return Promise.resolve();
  }
}

describe("IngestionManagedDocumentRetriever", () => {
  describe("rank to score", () => {
    it("gives the first hit the full score", async () => {
      const search = new RecordingSearch([hitAt(1)]);
      const chunks = await retrieverFor(search, [
        wholeDocumentScope,
      ]).searchChunks(queryFor(wholeDocumentScope));

      expect(chunks[0]?.score).toBe(1);
    });

    it("halves at rank two and eighths at rank eight", async () => {
      const search = new RecordingSearch([hitAt(2), hitAt(8)]);
      const chunks = await retrieverFor(search, [
        wholeDocumentScope,
      ]).searchChunks(queryFor(wholeDocumentScope));

      expect(chunks[0]?.score).toBe(0.5);
      expect(chunks[1]?.score).toBe(0.125);
    });

    it("scores a rank the same however many chunks were asked for", async () => {
      const wide = new RecordingSearch([hitAt(4)]);
      const narrow = new RecordingSearch([hitAt(4)]);

      const [wideChunks, narrowChunks] = await Promise.all([
        retrieverFor(wide, [wholeDocumentScope]).searchChunks(
          queryFor(wholeDocumentScope, 8),
        ),
        retrieverFor(narrow, [wholeDocumentScope]).searchChunks(
          queryFor(wholeDocumentScope, 2),
        ),
      ]);

      expect(wideChunks[0]?.score).toBe(0.25);
      expect(narrowChunks[0]?.score).toBe(0.25);
    });

    it("carries every citation field of the hit across", async () => {
      const search = new RecordingSearch([hitAt(1)]);
      const chunks = await retrieverFor(search, [
        wholeDocumentScope,
      ]).searchChunks(queryFor(wholeDocumentScope));

      expect(chunks[0]).toEqual({
        chunkId: "chk_1",
        chunkRevisionId: "crv_1",
        semanticUnitId: "unit_failures",
        documentId: "doc_payments",
        contentDigest: `sha256:${"b".repeat(64)}`,
        text: "결제 실패는 세 번까지 재시도된다.",
        score: 1,
      });
    });
  });

  describe("published scope reconstruction", () => {
    it("looks the publication up by the pinned index version alone", async () => {
      const publications = new FixedPublicationStore(
        publicationWith([wholeDocumentScope]),
      );
      const retriever = new IngestionManagedDocumentRetriever({
        search: new RecordingSearch(),
        publications,
        securityDomain: SECURITY_DOMAIN,
      });

      await retriever.searchChunks(queryFor(wholeDocumentScope));

      // The exact field set, not a subset: `documentId` and `sourceId` are
      // different strings on the same fixture, so a swapped or widened lookup
      // shows up here rather than passing on a store that ignores its input.
      expect(publications.findVersionInputs).toEqual([
        { documentIndexId: "didx_payments", indexVersion: "idxv_aaaa" },
      ]);
    });

    it("sends exactly the five fields the published contract allows", async () => {
      const search = new RecordingSearch();
      await retrieverFor(search, [wholeDocumentScope]).searchChunks(
        queryFor(wholeDocumentScope),
      );

      const scope = search.commands[0]?.scope;
      expect(Object.keys(scope ?? {}).sort()).toEqual([
        "documentIndex",
        "kind",
        "scopeId",
        "scopeVersion",
        "selector",
      ]);
      expect(Object.keys(scope?.documentIndex ?? {}).sort()).toEqual([
        "accessHandle",
        "connectorId",
        "documentId",
        "documentIndexId",
        "indexVersion",
        "sourceId",
      ]);
    });

    it("recovers the scope identity the port does not carry", async () => {
      const search = new RecordingSearch();
      await retrieverFor(search, [
        wholeDocumentScope,
        semanticUnitsScope,
      ]).searchChunks(queryFor(semanticUnitsScope));

      expect(search.commands[0]?.scope.scopeId).toBe("scope_payments_units");
      expect(search.commands[0]?.scope.scopeVersion).toBe("scpv_bbbb");
    });

    it("keeps semantic unit ids in the order they arrived", async () => {
      const search = new RecordingSearch();
      await retrieverFor(search, [semanticUnitsScope]).searchChunks(
        queryFor(semanticUnitsScope),
      );

      const selector = search.commands[0]?.scope.selector;
      expect(selector).toEqual({
        kind: "semantic_units",
        semanticUnitIds: ["unit_refunds", "unit_failures"],
      });
    });

    it("searches under the configured security domain", async () => {
      const search = new RecordingSearch();
      await retrieverFor(search, [wholeDocumentScope]).searchChunks(
        queryFor(wholeDocumentScope),
      );

      expect(search.commands[0]?.securityDomain).toBe(SECURITY_DOMAIN);
    });

    it("refuses a selection no published scope covers", async () => {
      const search = new RecordingSearch();
      const failure = await captureFailure(
        retrieverFor(search, [wholeDocumentScope]).searchChunks(
          queryFor(semanticUnitsScope),
        ),
      );

      expect(failure).toBeInstanceOf(DocumentRetrievalFault);
      expect((failure as DocumentRetrievalFault).code).toBe(
        "index_version_mismatch",
      );
      expect(search.commands).toHaveLength(0);
    });

    it("refuses an index version that is not published at all", async () => {
      const retriever = new IngestionManagedDocumentRetriever({
        search: new RecordingSearch(),
        publications: new FixedPublicationStore(),
        securityDomain: SECURITY_DOMAIN,
      });

      const failure = await captureFailure(
        retriever.searchChunks(queryFor(wholeDocumentScope)),
      );

      expect(failure).toBeInstanceOf(DocumentRetrievalFault);
      expect((failure as DocumentRetrievalFault).code).toBe(
        "index_version_mismatch",
      );
    });
  });

  describe("failure translation", () => {
    it.each([
      ["security_domain_mismatch", "access_denied"],
      ["scope_not_published", "index_version_mismatch"],
      ["vector_search_unavailable", "index_unavailable"],
    ] as const)("reports %s as %s", async (searchCode, faultCode) => {
      const failure = await captureFailure(
        retrieverFor(new FailingSearch(searchCode), [
          wholeDocumentScope,
        ]).searchChunks(queryFor(wholeDocumentScope)),
      );

      expect(failure).toBeInstanceOf(DocumentRetrievalFault);
      expect((failure as DocumentRetrievalFault).code).toBe(faultCode);
    });

    it("lets a failure with no honest translation through untouched", async () => {
      const failure = await captureFailure(
        retrieverFor(new FailingSearch("unexpected_failure"), [
          wholeDocumentScope,
        ]).searchChunks(queryFor(wholeDocumentScope)),
      );

      expect(failure).not.toBeInstanceOf(DocumentRetrievalFault);
      expect(failure).toBeInstanceOf(ManagedDocumentSearchError);
      expect((failure as ManagedDocumentSearchError).code).toBe(
        "unexpected_failure",
      );
    });
  });

  describe("round trip", () => {
    it("returns a whole-document scope to exactly what was published", async () => {
      expect(await roundTrip(wholeDocumentScope)).toEqual(wholeDocumentScope);
    });

    it("returns a semantic units scope to exactly what was published", async () => {
      expect(await roundTrip(semanticUnitsScope)).toEqual(semanticUnitsScope);
    });
  });
});
