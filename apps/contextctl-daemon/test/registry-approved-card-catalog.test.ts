import type { DatabaseSync } from "node:sqlite";

import { beforeEach, describe, expect, it } from "vitest";

import {
  appendCardVersion,
  approveCardVersion,
  createContextCard,
  disableCard,
  openRegistryDatabase,
  SqliteCardStore,
  withCardVersions,
  toApprovedCardCatalogSnapshot,
  type ApprovedCardCatalogSnapshot,
  type CardCatalogEntry,
  type CardDecisionPorts,
  type CardStore,
  type CardVersion,
  type ContextCard,
  type RetrievalScope,
} from "@contextctl/registry-lifecycle";

import { RegistryApprovedCardCatalog } from "../src/adapters/registry-approved-card-catalog.js";

const meaning = {
  description: "결제 실패 재시도 정책",
  representativeQuestions: ["결제가 실패하면 언제 재시도되나요?"],
  aliases: ["payment retry"],
  keywords: ["payment", "retry"],
};

const policy = { sensitive: true, allowedUsage: ["retrieval", "summary"] };
const decision = { decidedBy: "operator@example.test" };

const documentScope: RetrievalScope = {
  kind: "managed_document",
  reference: { scopeId: "scope_payment_failures", scopeVersion: "scpv_aaaa" },
  documentIndex: {
    documentIndexId: "didx_payments",
    sourceId: "src_payments",
    documentId: "doc_payments",
    indexVersion: "idxv_aaaa",
    connectorId: "vector.local",
    accessHandle: "documents/payments/indexes/aaaa",
  },
  selection: {
    kind: "semantic_units",
    semanticUnitIds: ["unit_payment_failures"],
  },
};

const sqlScope: RetrievalScope = {
  kind: "sql_source",
  reference: { scopeId: "scope_payments_table", scopeVersion: "scpv_cccc" },
  connector: "postgres.main",
  table: "payments",
  columns: ["failed_reason", "status"],
};

const httpScope: RetrievalScope = {
  kind: "http_source",
  reference: { scopeId: "scope_get_payment", scopeVersion: "scpv_dddd" },
  connector: "payments.api",
  method: "GET",
  path: "/payments/{id}",
};

function cardWith(
  cardId: string,
  versionId: string,
  scopes: readonly RetrievalScope[] = [documentScope],
): ContextCard {
  const card = createContextCard(cardId, meaning, policy);
  const version: CardVersion = {
    id: versionId,
    cardId,
    lineage: {
      publicationId: "pub_initial",
      observationId: "obs_initial",
      knowledgeUnitId: cardId,
    },
    scopes,
    validationState: "validated",
    createdAt: "2026-08-05T00:00:00.000Z",
  };
  return withCardVersions(card, appendCardVersion(card.versions, version));
}

/**
 * Hands back the very same entry objects on every call, so a passthrough
 * implementation would be caught by reference identity. A real store builds
 * fresh objects per query, which would make that assertion pass either way.
 */
class FixedEntryCardStore implements CardStore {
  readonly #entries: readonly CardCatalogEntry[];

  constructor(entries: readonly CardCatalogEntry[]) {
    this.#entries = entries;
  }

  findCard(): Promise<ContextCard | undefined> {
    return Promise.resolve(undefined);
  }

  listCurrentVersions(): Promise<readonly CardVersion[]> {
    return Promise.resolve([]);
  }

  listApprovedCards(): Promise<ApprovedCardCatalogSnapshot> {
    return Promise.resolve(toApprovedCardCatalogSnapshot(this.#entries));
  }

  saveCard(): Promise<void> {
    return Promise.resolve();
  }
}

describe("RegistryApprovedCardCatalog", () => {
  let database: DatabaseSync;
  let store: SqliteCardStore;
  let ports: CardDecisionPorts;
  let catalog: RegistryApprovedCardCatalog;

  beforeEach(() => {
    database = openRegistryDatabase(":memory:");
    store = new SqliteCardStore(database);
    catalog = new RegistryApprovedCardCatalog(store);
    let nextId = 0;
    ports = {
      cards: store,
      clock: { now: () => "2026-08-05T00:00:00.000Z" },
      ids: {
        nextId: () => {
          nextId += 1;
          return `ev_${nextId}`;
        },
      },
    };
  });

  it("serves a card whose current version is approved", async () => {
    await store.saveCard(cardWith("unit_a", "cv_a"), []);
    await approveCardVersion(ports, "unit_a", "cv_a", decision);

    const approved = await catalog.listApprovedCards();

    expect(approved).toHaveLength(1);
    expect(approved[0]?.cardId).toBe("unit_a");
    expect(approved[0]?.versionId).toBe("cv_a");
  });

  it("omits a card that has never been approved", async () => {
    await store.saveCard(cardWith("unit_a", "cv_a"), []);

    expect(await catalog.listApprovedCards()).toEqual([]);
  });

  it("omits a card once it is withdrawn", async () => {
    await store.saveCard(cardWith("unit_a", "cv_a"), []);
    await approveCardVersion(ports, "unit_a", "cv_a", decision);
    await disableCard(ports, "unit_a", decision);

    expect(await catalog.listApprovedCards()).toEqual([]);
  });

  it("returns an empty catalog when no cards are stored", async () => {
    expect(await catalog.listApprovedCards()).toEqual([]);
  });

  it("carries every meaning and policy field across unchanged", async () => {
    await store.saveCard(cardWith("unit_a", "cv_a"), []);
    await approveCardVersion(ports, "unit_a", "cv_a", decision);

    const approved = await catalog.listApprovedCards();

    expect(approved[0]?.meaning).toEqual({
      description: "결제 실패 재시도 정책",
      representativeQuestions: ["결제가 실패하면 언제 재시도되나요?"],
      aliases: ["payment retry"],
      keywords: ["payment", "retry"],
    });
    expect(approved[0]?.policy).toEqual({
      sensitive: true,
      allowedUsage: ["retrieval", "summary"],
    });
  });

  it("translates a managed document scope down to its index reference and selection", async () => {
    await store.saveCard(cardWith("unit_a", "cv_a", [documentScope]), []);
    await approveCardVersion(ports, "unit_a", "cv_a", decision);

    const approved = await catalog.listApprovedCards();

    expect(approved[0]?.scopes).toEqual([
      {
        kind: "managed_document",
        reference: {
          scopeId: "scope_payment_failures",
          scopeVersion: "scpv_aaaa",
        },
        documentIndex: {
          documentIndexId: "didx_payments",
          sourceId: "src_payments",
          documentId: "doc_payments",
          indexVersion: "idxv_aaaa",
          connectorId: "vector.local",
          accessHandle: "documents/payments/indexes/aaaa",
        },
        selection: {
          kind: "semantic_units",
          semanticUnitIds: ["unit_payment_failures"],
        },
      },
    ]);
  });

  it("translates a whole-document selection without inventing semantic units", async () => {
    const wholeDocument: RetrievalScope = {
      ...documentScope,
      kind: "managed_document",
      selection: { kind: "document" },
    };
    await store.saveCard(cardWith("unit_a", "cv_a", [wholeDocument]), []);
    await approveCardVersion(ports, "unit_a", "cv_a", decision);

    const approved = await catalog.listApprovedCards();

    expect(approved[0]?.scopes[0]).toMatchObject({
      kind: "managed_document",
      selection: { kind: "document" },
    });
  });

  it("translates sql and http scopes with their coordinates intact", async () => {
    await store.saveCard(cardWith("unit_a", "cv_a", [sqlScope, httpScope]), []);
    await approveCardVersion(ports, "unit_a", "cv_a", decision);

    const approved = await catalog.listApprovedCards();

    expect(approved[0]?.scopes).toEqual([
      {
        kind: "sql_source",
        reference: {
          scopeId: "scope_payments_table",
          scopeVersion: "scpv_cccc",
        },
        connector: "postgres.main",
        table: "payments",
        columns: ["failed_reason", "status"],
      },
      {
        kind: "http_source",
        reference: { scopeId: "scope_get_payment", scopeVersion: "scpv_dddd" },
        connector: "payments.api",
        method: "GET",
        path: "/payments/{id}",
      },
    ]);
  });

  it("builds new objects instead of passing the store's entries through", async () => {
    const entry: CardCatalogEntry = {
      cardId: "unit_a",
      versionId: "cv_a",
      meaning,
      policy,
      scopes: [documentScope, sqlScope],
    };
    const passthroughCatalog = new RegistryApprovedCardCatalog(
      new FixedEntryCardStore([entry]),
    );

    const approved = await passthroughCatalog.listApprovedCards();

    expect(approved[0]).not.toBe(entry);
    expect(approved[0]?.meaning).not.toBe(entry.meaning);
    expect(approved[0]?.policy).not.toBe(entry.policy);
    expect(approved[0]?.scopes).not.toBe(entry.scopes);
    expect(approved[0]?.scopes[0]).not.toBe(entry.scopes[0]);
    // The copies still have to be faithful, or independence would be worthless.
    expect(approved[0]?.scopes).toEqual(entry.scopes);
  });
});
