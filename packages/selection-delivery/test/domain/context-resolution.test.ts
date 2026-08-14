import { beforeAll, describe, expect, it } from "vitest";

import {
  resolveContext,
  type ResolveContextPorts,
} from "../../src/application/resolve-context.js";
import type {
  ApprovedCard,
  ApprovedManagedDocumentScope,
  ApprovedScope,
} from "../../src/domain/card-catalog.js";
import {
  buildRetrievalGuide,
  type ContextResolution,
  type ResolutionItem,
} from "../../src/domain/context-resolution.js";
import { SelectionScopeInvariantError } from "../../src/domain/errors.js";
import { DEFAULT_EVIDENCE_BUDGET } from "../../src/domain/evidence-assembly.js";
import { buildFulfillmentTarget } from "../../src/domain/fulfillment-target.js";
import { DEFAULT_SELECTION_THRESHOLDS } from "../../src/domain/selection-verdict.js";
import { FixtureDocumentRetriever } from "../../src/infrastructure/fixture-document-retriever.js";
import { InMemoryCardCatalog } from "../../src/infrastructure/in-memory-card-catalog.js";
import {
  ALL_OUTCOMES_QUERY,
  createAllOutcomesCardSet,
  createDemoCardSet,
  createIndexedDocumentCard,
  createPaymentApiCard,
  createPaymentsTableCard,
  createRefundPolicyCard,
  createUnindexedDocumentCard,
} from "../fixtures/approved-card.fixture.js";
import { createRefundPolicyChunkMap } from "../fixtures/document-chunk.fixture.js";

/** Fails loudly if the fixture stops carrying the Scope kind a test relies on. */
function scopeOfKind<K extends ApprovedScope["kind"]>(
  card: ApprovedCard,
  kind: K,
): Extract<ApprovedScope, { kind: K }> {
  const found = card.scopes.find((scope) => scope.kind === kind);

  if (found === undefined) {
    throw new Error(`fixture ${card.cardId} carries no ${kind} scope`);
  }
  return found as Extract<ApprovedScope, { kind: K }>;
}

/**
 * Our own retrieval coordinates, exactly as the two managed document Cards in
 * `createAllOutcomesCardSet()` declare them.
 *
 * Both are named here so every exclusion check below can be paired with a
 * positive assertion that the fixture carries the value at all. The `failed`
 * Card's binding is included on purpose: its guide is serialized like any
 * other, and nothing about failing exempts it from the field ban.
 */
const FORBIDDEN_VALUES = {
  fulfilledConnectorId: "vector.local",
  fulfilledAccessHandle: "documents/policies/indexes/refund",
  failedConnectorId: "vector.retired",
  failedAccessHandle: "documents/policies/indexes/retired",
} as const;

function allOutcomesPorts(): ResolveContextPorts {
  return {
    catalog: new InMemoryCardCatalog(createAllOutcomesCardSet()),
    retriever: new FixtureDocumentRetriever(createRefundPolicyChunkMap()),
  };
}

/**
 * Resolves the four-outcome catalog through the real use case and the real
 * in-package adapters, under the thresholds the package actually ships.
 *
 * These tests used to compose the resolution by hand, on the argument that a
 * test pinning a serialized shape must not agree with whatever the use case
 * emits. The argument does not survive contact with what the shape is for:
 * hand composition pinned a payload nothing ever produced, so a `resolveContext`
 * that mapped a Card onto a different item — or that leaked `connectorId` on
 * its way out — passed every exclusion check below untouched. The payload a
 * consumer actually receives is the only one worth checking for a leak.
 *
 * No threshold band is stated. The earlier one — an admit-all band wide enough
 * to drag the demo's HTTP Card in — made these tests depend on the exact score
 * that Card happens to receive, so a change to the scoring heuristic would have
 * broken tests about serialization. The fixture Cards declare keywords that
 * appear in `ALL_OUTCOMES_QUERY` literally instead, and a direct match is at or
 * above `DIRECT_MATCH_FLOOR` by construction, which is above the default admit
 * threshold. The dependency is on a declared policy constant, not on a number
 * a heuristic produced.
 *
 * Compile-time pinning of the shape itself has not moved: it lives in
 * `context-resolution.types.test.ts`, where hand composition is the point.
 */
async function resolveAllOutcomes(query: string): Promise<ContextResolution> {
  return await resolveContext(allOutcomesPorts(), query);
}

describe("buildRetrievalGuide", () => {
  it("transcribes a managed document scope into a citable guide", () => {
    const card = createRefundPolicyCard();
    const scope = scopeOfKind(card, "managed_document");

    expect(buildRetrievalGuide(scope)).toEqual({
      kind: "managed_document",
      scopeRef: scope.reference,
      sourceId: "src_policy_docs",
      documentId: "doc_refund_policy",
      documentIndexId: "docidx_refund_policy",
      indexVersion: "idxv_0001",
      selection: { kind: "document" },
    });
  });

  it("leaves no scope of a mixed card without a guide", () => {
    // The whole reason this function replaced `buildRetrievalContracts`: that
    // one answered `undefined` for a managed document, and the Scope left the
    // pipeline without a trace.
    const mixed: readonly ApprovedScope[] = [
      scopeOfKind(createRefundPolicyCard(), "managed_document"),
      scopeOfKind(createPaymentsTableCard(), "sql_source"),
      scopeOfKind(createPaymentApiCard(), "http_source"),
    ];

    expect(mixed.map((scope) => buildRetrievalGuide(scope).kind)).toEqual([
      "managed_document",
      "sql",
      "http",
    ]);
  });

  it("states select as the only allowed operation on a sql guide", () => {
    const guide = buildRetrievalGuide(
      scopeOfKind(createPaymentsTableCard(), "sql_source"),
    );

    if (guide.kind !== "sql") {
      throw new Error("expected a sql guide");
    }
    expect(guide.allowedOperations).toEqual(["select"]);
  });

  it("keeps an empty column list empty rather than dropping the guide", () => {
    const guide = buildRetrievalGuide({
      ...scopeOfKind(createPaymentsTableCard(), "sql_source"),
      columns: [],
    });

    if (guide.kind !== "sql") {
      throw new Error("expected a sql guide");
    }
    expect(guide.columns).toEqual([]);
  });

  it("returns the same guide for the same scope twice", () => {
    const scope = scopeOfKind(createPaymentsTableCard(), "sql_source");
    const before = structuredClone(scope);

    expect(buildRetrievalGuide(scope)).toEqual(buildRetrievalGuide(scope));
    expect(scope).toEqual(before);
  });

  it("transcribes a sql scope into an executable coordinate", () => {
    const card = createPaymentsTableCard();
    const scope = scopeOfKind(card, "sql_source");

    expect(buildRetrievalGuide(scope)).toEqual({
      kind: "sql",
      scopeRef: scope.reference,
      connector: "postgres.main",
      table: "payments",
      columns: ["created_at", "failed_reason", "payment_id", "status"],
      allowedOperations: ["select"],
    });
  });

  it("transcribes an http scope into connector, method and path", () => {
    const card = createPaymentApiCard();
    const scope = scopeOfKind(card, "http_source");

    expect(buildRetrievalGuide(scope)).toEqual({
      kind: "http",
      scopeRef: scope.reference,
      connector: "payments.api",
      method: "GET",
      path: "/payments/{paymentId}",
    });
  });

  it("builds a guide for every approved scope kind, leaving none behind", () => {
    const kinds = createDemoCardSet()
      .flatMap((card) => card.scopes)
      .map((scope) => buildRetrievalGuide(scope).kind);

    expect(kinds).toEqual(["managed_document", "sql", "http"]);
  });

  it("copies the columns instead of aliasing the scope's array", () => {
    const scope = scopeOfKind(createPaymentsTableCard(), "sql_source");
    const guide = buildRetrievalGuide(scope);

    if (guide.kind !== "sql") {
      throw new Error("expected a sql guide");
    }
    expect(guide.columns).toEqual(scope.columns);
    expect(guide.columns).not.toBe(scope.columns);
  });

  it("copies the semantic unit ids instead of aliasing the scope's array", () => {
    const scope: ApprovedManagedDocumentScope = {
      ...scopeOfKind(createRefundPolicyCard(), "managed_document"),
      selection: { kind: "semantic_units", semanticUnitIds: ["unit_a"] },
    };
    const guide = buildRetrievalGuide(scope);

    if (guide.kind !== "managed_document") {
      throw new Error("expected a managed document guide");
    }
    if (guide.selection.kind !== "semantic_units") {
      throw new Error("expected a semantic units selection");
    }
    expect(guide.selection.semanticUnitIds).toEqual(["unit_a"]);
    expect(guide.selection.semanticUnitIds).not.toBe(
      scope.selection.kind === "semantic_units"
        ? scope.selection.semanticUnitIds
        : undefined,
    );
  });

  it("refuses a scope kind outside the approved union", () => {
    const rogue = {
      kind: "ftp_source",
      reference: { scopeId: "scope_1", scopeVersion: "scopev_0001" },
    } as unknown as ApprovedScope;

    expect(() => buildRetrievalGuide(rogue)).toThrow(
      SelectionScopeInvariantError,
    );
    expect(() => buildRetrievalGuide(rogue)).toThrow(/ftp_source/);
  });
});

describe("buildFulfillmentTarget", () => {
  it("carries the physical binding a guide deliberately omits", () => {
    const scope = scopeOfKind(createRefundPolicyCard(), "managed_document");

    expect(buildFulfillmentTarget(scope)).toEqual({
      scopeRef: scope.reference,
      documentIndex: {
        documentIndexId: "docidx_refund_policy",
        sourceId: "src_policy_docs",
        documentId: "doc_refund_policy",
        indexVersion: "idxv_0001",
        connectorId: "vector.local",
        accessHandle: "documents/policies/indexes/refund",
      },
      selection: { kind: "document" },
    });
  });
});

describe("ContextResolution serialization", () => {
  let resolution: ContextResolution;
  let serialized: string;

  beforeAll(async () => {
    resolution = await resolveAllOutcomes(ALL_OUTCOMES_QUERY);
    serialized = JSON.stringify(resolution);
  });

  it("starts from a card set that really carries the forbidden values", () => {
    // Without this the exclusion assertions below would pass vacuously.
    const fulfilled = buildFulfillmentTarget(
      scopeOfKind(createIndexedDocumentCard(), "managed_document"),
    );
    const failed = buildFulfillmentTarget(
      scopeOfKind(createUnindexedDocumentCard(), "managed_document"),
    );

    expect(fulfilled.documentIndex.connectorId).toBe(
      FORBIDDEN_VALUES.fulfilledConnectorId,
    );
    expect(fulfilled.documentIndex.accessHandle).toBe(
      FORBIDDEN_VALUES.fulfilledAccessHandle,
    );
    expect(failed.documentIndex.connectorId).toBe(
      FORBIDDEN_VALUES.failedConnectorId,
    );
    expect(failed.documentIndex.accessHandle).toBe(
      FORBIDDEN_VALUES.failedAccessHandle,
    );
  });

  it("really resolved the scopes those values belong to", () => {
    // The other half of the same guard. A managed document Scope is the only
    // thing that could carry those coordinates out, so a resolution that
    // produced no such item would satisfy every exclusion below while proving
    // nothing at all. Both states are required: a `failed` item is serialized
    // too, and checking only the fulfilled one would leave the other guide's
    // binding unexamined.
    const documentItems = resolution.items.filter(
      (item) => item.guide.kind === "managed_document",
    );

    expect(documentItems.map((item) => item.fulfillment)).toEqual([
      "fulfilled",
      "failed",
    ]);
  });

  it("omits the connectorId field", () => {
    expect(serialized).not.toContain("connectorId");
  });

  it("omits the accessHandle field", () => {
    expect(serialized).not.toContain("accessHandle");
  });

  it("omits any collection field", () => {
    expect(serialized).not.toContain("collection");
  });

  it("omits any credential field", () => {
    expect(serialized).not.toContain("credential");
  });

  it("omits the connectorId values, not just the field name", () => {
    // Renaming a field and shipping the value anyway would pass every check
    // above and still leak the coordinate.
    expect(serialized).not.toContain(FORBIDDEN_VALUES.fulfilledConnectorId);
    expect(serialized).not.toContain(FORBIDDEN_VALUES.failedConnectorId);
  });

  it("omits the accessHandle values, not just the field name", () => {
    expect(serialized).not.toContain(FORBIDDEN_VALUES.fulfilledAccessHandle);
    expect(serialized).not.toContain(FORBIDDEN_VALUES.failedAccessHandle);
  });

  it("keeps the sql coordinate a consumer needs to run the query", () => {
    expect(serialized).toContain('"connector":"postgres.ledger"');
    expect(serialized).toContain('"table":"inventory_ledger"');
    expect(serialized).toContain('"columns"');
    expect(serialized).toContain('"allowedOperations":["select"]');
  });

  it("keeps the http coordinate a consumer needs to call the endpoint", () => {
    expect(serialized).toContain('"connector":"billing.api"');
    expect(serialized).toContain('"method":"GET"');
    expect(serialized).toContain('"path":"/settlements/{settlementId}"');
  });

  it("keeps the document coordinates that make a citation checkable", () => {
    expect(serialized).toContain('"documentIndexId":"docidx_refund_policy"');
    expect(serialized).toContain('"sourceId":"src_policy_docs"');
    expect(serialized).toContain('"indexVersion":"idxv_0001"');
  });

  it("keeps them on a failed item too, so the gap is attributable", () => {
    // A `failed` item states which approved index could not be read. Dropping
    // the coordinate would leave a consumer knowing only that something failed.
    expect(serialized).toContain('"documentIndexId":"docidx_not_registered"');
  });

  it("states every comparability fact in one block", () => {
    expect(resolution.policy).toEqual({
      payloadSchemaVersion: 2,
      scoring: "selection-scoring-v1",
      ranking: "selection-ranking-v1",
      evidence: "evidence-assembly-v1",
      budget: DEFAULT_EVIDENCE_BUDGET,
    });
  });

  it("carries no per-item budget to disagree with that block", () => {
    // A budget on an item would read as "this item was allotted 8000
    // characters", which is false: every item spends from the one ceiling.
    for (const item of resolution.items) {
      if (item.fulfillment === "fulfilled") {
        expect(Object.hasOwn(item.context, "budget")).toBe(false);
      }
    }
  });

  it("carries the audit trail selection alone cannot supply", () => {
    // Without `candidates` a consumer cannot tell a narrow catalog from a
    // strict threshold: both produce an empty admitted set.
    expect(resolution.candidates).toHaveLength(4);
    expect(resolution.selection.provenance.policyVersion).toBe(
      "selection-ranking-v1",
    );
  });

  it("was judged under the thresholds the package ships, not a test's own", () => {
    // The reason the fixtures were rewritten: these tests are about what a
    // resolution serializes, and they must not restate a band to force every
    // Scope kind into the payload.
    expect(resolution.selection.provenance.thresholds).toEqual(
      DEFAULT_SELECTION_THRESHOLDS,
    );
  });

  it("carries no per-item evidence policy version to disagree with that block", () => {
    // Scoped to the items rather than the whole payload: `selection.provenance`
    // states its own `policyVersion`, and that repetition of `policy.ranking`
    // is intended — the summary block and the record of the run that produced
    // these outcomes are read separately. An evidence policy version per item
    // would be the other thing, one unvarying string copied per record.
    expect(JSON.stringify(resolution.items)).not.toContain("policyVersion");
  });

  it("echoes the query back exactly as received", () => {
    expect(resolution.query).toBe(ALL_OUTCOMES_QUERY);
  });
});

describe("ResolutionItem fulfillment", () => {
  let items: readonly ResolutionItem[];

  beforeAll(async () => {
    items = (await resolveAllOutcomes(ALL_OUTCOMES_QUERY)).items;
  });

  it("produces one item per selected scope, none dropped", () => {
    // Four admitted Cards of one Scope each, listed by ascending versionId:
    // indexed document, ledger table, lookup api, unindexed document.
    expect(items).toHaveLength(4);
    expect(items.map((item) => item.guide.scopeRef.scopeId)).toEqual([
      "scope_indexed_document",
      "scope_ledger_table",
      "scope_lookup_api",
      "scope_unindexed_document",
    ]);
    expect(items.map((item) => item.guide.kind)).toEqual([
      "managed_document",
      "sql",
      "http",
      "managed_document",
    ]);
  });

  it("reports every fulfillment state one resolution can produce", () => {
    expect(items.map((item) => item.fulfillment)).toEqual([
      "fulfilled",
      "delegated",
      "delegated",
      "failed",
    ]);
  });

  it("reports a scope whose index could not be read as failed, with a code", () => {
    // The code is the adapter's own: `FixtureDocumentRetriever` rejects an
    // unregistered index with `DocumentRetrievalFault("index_unavailable")`,
    // and this domain transcribes it rather than inventing a reason. ADR 0007.
    const failed = items.filter((item) => item.fulfillment === "failed");

    expect(failed).toHaveLength(1);
    for (const item of failed) {
      if (item.fulfillment !== "failed") {
        throw new Error("expected a failed item");
      }
      expect(item.code).toBe("index_unavailable");
      expect(Object.hasOwn(item, "context")).toBe(false);
    }
  });

  it("does not let one failed scope take the others down with it", () => {
    // A failing Scope is isolated, not fatal: a partially resolved answer with
    // the gap recorded is worth more to a consumer than no answer at all.
    expect(
      items.filter((item) => item.fulfillment !== "failed"),
    ).toHaveLength(3);
  });

  it("never reports a delegated scope as failed", () => {
    // We have not run the consumer's database or endpoint, so we are in no
    // position to say whether it would have succeeded.
    for (const item of items) {
      if (item.guide.kind === "sql" || item.guide.kind === "http") {
        expect(item.fulfillment).toBe("delegated");
        expect(Object.hasOwn(item, "code")).toBe(false);
      }
    }
  });

  it("attaches retrieved context to every fulfilled item", () => {
    for (const item of items) {
      if (item.fulfillment === "fulfilled") {
        // The whole refund policy document: three chunks, all of them within
        // the default budget, so nothing was dropped on the way out.
        //
        // The order is asserted, not sorted away, because it is decided rather
        // than incidental. Both sort stages are total orders — the adapter's
        // `compareByScoreThenRevision` and the assembly's `compareChunks` —
        // and both break a score tie on ascending `chunkRevisionId` with
        // `<`/`>` rather than `localeCompare`, so no runtime locale can move a
        // chunk. The fixture's three `chunkRevisionId`s are all distinct, which
        // is what makes those orders total. Determinism is an asset in this
        // domain, not a coincidence, and it is the same reason
        // `selection-verdict.ts` refuses `localeCompare` for its versionId
        // tie-break; an assertion that sorts before comparing would stop
        // guarding it.
        //
        // Here the scores in fact separate all three (bigram Jaccard against
        // `ALL_OUTCOMES_QUERY`: excluded > shipping fee > refund window), so
        // the tie-break is the guarantee behind the order rather than its
        // cause.
        expect(item.context.chunks.map((chunk) => chunk.chunkId)).toEqual([
          "chunk_refund_excluded",
          "chunk_shipping_fee",
          "chunk_refund_window",
        ]);
        expect(item.context.omitted).toEqual([]);
        expect(item.context.truncated).toBe(false);
      }
    }
  });

  it("cites every chunk back to the scope that authorised it", () => {
    // The chunks now come from a real retrieval rather than from a literal
    // written beside the assertion, so the attribution is a claim the use case
    // makes and this checks, not one the test made itself.
    for (const item of items) {
      if (item.fulfillment === "fulfilled") {
        for (const chunk of item.context.chunks) {
          expect(chunk.cardId).toBe(item.cardId);
          expect(chunk.versionId).toBe(item.versionId);
          expect(chunk.scopeRef).toEqual(item.guide.scopeRef);
        }
      }
    }
  });
});
