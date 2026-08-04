import { describe, expect, it } from "vitest";

import type {
  ApprovedCard,
  ApprovedHttpScope,
  ApprovedManagedDocumentScope,
  ApprovedScope,
  ApprovedSqlScope,
} from "../../src/domain/card-catalog.js";
import { SelectionScopeInvariantError } from "../../src/domain/errors.js";
import {
  buildRetrievalContracts,
  type ContractSource,
  type RetrievalContract,
  type SqlRetrievalContract,
} from "../../src/domain/retrieval-contract.js";
import {
  createInventoryCard,
  createPaymentApiCard,
  createRefundPolicyCard,
} from "../fixtures/approved-card.fixture.js";

function sqlScope(
  scopeId: string,
  columns: readonly string[] = ["id"],
): ApprovedSqlScope {
  return {
    kind: "sql_source",
    reference: { scopeId, scopeVersion: "scopev_0001" },
    connector: "postgres.main",
    table: "orders",
    columns,
  };
}

function httpScope(scopeId: string): ApprovedHttpScope {
  return {
    kind: "http_source",
    reference: { scopeId, scopeVersion: "scopev_0001" },
    connector: "payments.api",
    method: "GET",
    path: "/payments/{paymentId}",
  };
}

function documentScope(scopeId: string): ApprovedManagedDocumentScope {
  return {
    kind: "managed_document",
    reference: { scopeId, scopeVersion: "scopev_0001" },
    documentIndex: {
      documentIndexId: "docidx_1",
      sourceId: "src_1",
      documentId: "doc_1",
      indexVersion: "idxv_0001",
      connectorId: "vector.local",
      accessHandle: "documents/1",
    },
    selection: { kind: "document" },
  };
}

function source(
  versionId: string,
  scopes: readonly ApprovedScope[],
): ContractSource {
  return { cardId: `card_${versionId}`, versionId, scopes };
}

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

function onlySqlContract(
  contracts: readonly RetrievalContract[],
): SqlRetrievalContract {
  const contract = contracts.at(0);

  if (contracts.length !== 1 || contract?.kind !== "sql") {
    throw new Error("expected exactly one sql contract");
  }
  return contract;
}

function coordinates(
  contracts: readonly RetrievalContract[],
): readonly string[] {
  return contracts.map(
    (contract) => `${contract.versionId}/${contract.scopeRef.scopeId}`,
  );
}

describe("buildRetrievalContracts", () => {
  it("transcribes a sql scope into an executable coordinate", () => {
    const card = createInventoryCard();
    const scope = scopeOfKind(card, "sql_source");

    expect(buildRetrievalContracts([card])).toEqual([
      {
        kind: "sql",
        cardId: "card_inventory",
        versionId: "cardv_inventory_v1",
        scopeRef: scope.reference,
        connector: "postgres.main",
        table: "inventory",
        columns: [
          "product_id",
          "product_name",
          "refundable",
          "stock_quantity",
        ],
        allowedOperations: ["select"],
      },
    ]);
  });

  it("states select as the only allowed operation on a sql contract", () => {
    const contract = onlySqlContract(
      buildRetrievalContracts([source("cardv_1", [sqlScope("scope_1")])]),
    );

    expect(contract.allowedOperations).toEqual(["select"]);
  });

  it("copies the columns instead of aliasing the scope's array", () => {
    const card = createInventoryCard();
    const scope = scopeOfKind(card, "sql_source");
    const contract = onlySqlContract(buildRetrievalContracts([card]));

    expect(contract.columns).toEqual(scope.columns);
    expect(contract.columns).not.toBe(scope.columns);
  });

  it("keeps an empty column list empty rather than dropping the contract", () => {
    const contract = onlySqlContract(
      buildRetrievalContracts([source("cardv_1", [sqlScope("scope_1", [])])]),
    );

    expect(contract.columns).toEqual([]);
  });

  it("transcribes an http scope into connector, method and path", () => {
    const card = createPaymentApiCard();
    const scope = scopeOfKind(card, "http_source");

    expect(buildRetrievalContracts([card])).toEqual([
      {
        kind: "http",
        cardId: "card_payment_api",
        versionId: "cardv_payment_api_v1",
        scopeRef: scope.reference,
        connector: "payments.api",
        method: "GET",
        path: "/payments/{paymentId}",
      },
    ]);
  });

  it("produces no contract for a card that only has managed document scopes", () => {
    expect(buildRetrievalContracts([createRefundPolicyCard()])).toEqual([]);
  });

  it("skips the document scope of a mixed card and keeps the other two", () => {
    const contracts = buildRetrievalContracts([
      source("cardv_1", [
        documentScope("scope_doc"),
        sqlScope("scope_sql"),
        httpScope("scope_http"),
      ]),
    ]);

    expect(contracts.map((contract) => contract.kind)).toEqual(["http", "sql"]);
    expect(coordinates(contracts)).toEqual([
      "cardv_1/scope_http",
      "cardv_1/scope_sql",
    ]);
  });

  it("orders by ascending versionId, then by ascending scopeId within a card", () => {
    const contracts = buildRetrievalContracts([
      source("cardv_b", [sqlScope("scope_z"), httpScope("scope_a")]),
      source("cardv_a", [httpScope("scope_m")]),
    ]);

    expect(coordinates(contracts)).toEqual([
      "cardv_a/scope_m",
      "cardv_b/scope_a",
      "cardv_b/scope_z",
    ]);
  });

  it("orders identically whatever order the admitted cards arrive in", () => {
    const expected = ["cardv_a/scope_m", "cardv_b/scope_a", "cardv_b/scope_z"];
    const permutations: readonly (readonly ContractSource[])[] = [
      [
        source("cardv_b", [sqlScope("scope_z"), httpScope("scope_a")]),
        source("cardv_a", [httpScope("scope_m")]),
      ],
      [
        source("cardv_a", [httpScope("scope_m")]),
        source("cardv_b", [httpScope("scope_a"), sqlScope("scope_z")]),
      ],
    ];

    for (const permutation of permutations) {
      expect(coordinates(buildRetrievalContracts(permutation))).toEqual(
        expected,
      );
    }
  });

  it("refuses a scope kind outside the approved union", () => {
    const rogue = {
      kind: "ftp_source",
      reference: { scopeId: "scope_1", scopeVersion: "scopev_0001" },
    } as unknown as ApprovedScope;

    expect(() => buildRetrievalContracts([source("cardv_1", [rogue])])).toThrow(
      SelectionScopeInvariantError,
    );
  });

  it("names the offending scope kind in the failure", () => {
    const rogue = {
      kind: "ftp_source",
      reference: { scopeId: "scope_1", scopeVersion: "scopev_0001" },
    } as unknown as ApprovedScope;

    expect(() => buildRetrievalContracts([source("cardv_1", [rogue])])).toThrow(
      /ftp_source/,
    );
  });

  it("returns nothing for an empty admitted set", () => {
    expect(buildRetrievalContracts([])).toEqual([]);
  });

  it("returns nothing for a card that carries no scopes at all", () => {
    expect(buildRetrievalContracts([source("cardv_1", [])])).toEqual([]);
  });

  it("does not mutate the admitted cards it was given", () => {
    const admitted: readonly ContractSource[] = [
      source("cardv_b", [sqlScope("scope_z"), httpScope("scope_a")]),
      source("cardv_a", [documentScope("scope_doc"), httpScope("scope_m")]),
    ];
    const before = structuredClone(admitted);

    buildRetrievalContracts(admitted);

    expect(admitted).toEqual(before);
  });

  it("returns the same contracts for the same input twice", () => {
    const admitted: readonly ContractSource[] = [
      source("cardv_b", [sqlScope("scope_z"), httpScope("scope_a")]),
      source("cardv_a", [documentScope("scope_doc"), httpScope("scope_m")]),
    ];

    expect(buildRetrievalContracts(admitted)).toEqual(
      buildRetrievalContracts(admitted),
    );
  });
});
