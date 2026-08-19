import { describe, expect, it } from "vitest";

import type {
  ApprovedCard,
  ApprovedManagedDocumentScope,
  ApprovedScope,
} from "../../src/domain/card-catalog.js";
import { SelectionScopeInvariantError } from "../../src/domain/errors.js";
import {
  buildRetrievalGuide,
  retrievalGuideKey,
} from "../../src/domain/retrieval-guide.js";
import {
  createPaymentApiCard,
  createPaymentsTableCard,
  createRefundPolicyCard,
} from "../fixtures/approved-card.fixture.js";

const LIMIT = 8;

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

describe("buildRetrievalGuide", () => {
  it("transcribes a managed document scope into a citable guide", () => {
    const scope = scopeOfKind(createRefundPolicyCard(), "managed_document");

    expect(buildRetrievalGuide(scope, LIMIT)).toEqual({
      kind: "managed_document",
      scopeRef: {
        scopeId: "scope_refund_policy_doc",
        scopeVersion: "scopev_0001",
      },
      documentIndexId: "docidx_refund_policy",
      sourceId: "src_policy_docs",
      documentId: "doc_refund_policy",
      indexVersion: "idxv_0001",
      selector: { kind: "document" },
      limit: LIMIT,
    });
  });

  it("carries no physical binding at all, on any field", () => {
    const scope = scopeOfKind(createRefundPolicyCard(), "managed_document");
    const guide = buildRetrievalGuide(scope, LIMIT);

    // The Scope really holds both — asserted here so the exclusion below is not
    // vacuous — and the guide holds neither, by name or by value.
    expect(scope.documentIndex.connectorId).toBe("vector.local");
    expect(scope.documentIndex.accessHandle).toBe(
      "documents/policies/indexes/refund",
    );
    const wire = JSON.stringify(guide);
    for (const forbidden of [
      "connectorId",
      "accessHandle",
      "securityDomain",
      "vector.local",
      "documents/policies/indexes/refund",
    ]) {
      expect(wire).not.toContain(forbidden);
    }
  });

  it("states select as the only allowed operation on a sql guide", () => {
    const guide = buildRetrievalGuide(
      scopeOfKind(createPaymentsTableCard(), "sql_source"),
      LIMIT,
    );

    expect(guide).toMatchObject({
      kind: "sql",
      connector: "postgres.main",
      table: "payments",
      allowedOperations: ["select"],
    });
  });

  it("transcribes an http scope into connector, method and path", () => {
    expect(
      buildRetrievalGuide(
        scopeOfKind(createPaymentApiCard(), "http_source"),
        LIMIT,
      ),
    ).toMatchObject({
      kind: "http",
      connector: "payments.api",
      method: "GET",
      path: "/payments/{paymentId}",
    });
  });

  it("does not bound a delegated guide, which we never execute", () => {
    const sql = buildRetrievalGuide(
      scopeOfKind(createPaymentsTableCard(), "sql_source"),
      LIMIT,
    );

    // How many rows the consumer's own query returns is not ours to cap, and a
    // `limit` on the guide would read as if it were.
    expect(sql).not.toHaveProperty("limit");
  });

  it("copies the columns instead of aliasing the scope's array", () => {
    const scope = scopeOfKind(createPaymentsTableCard(), "sql_source");
    const guide = buildRetrievalGuide(scope, LIMIT);

    (scope.columns as string[]).push("secret_column");

    expect(guide.kind).toBe("sql");
    if (guide.kind !== "sql") {
      throw new Error("expected a sql guide");
    }
    expect(guide.columns).not.toContain("secret_column");
  });

  it("copies the semantic unit ids instead of aliasing the scope's array", () => {
    const base = scopeOfKind(createRefundPolicyCard(), "managed_document");
    const scope: ApprovedManagedDocumentScope = {
      ...base,
      selection: { kind: "semantic_units", semanticUnitIds: ["unit_a"] },
    };
    const guide = buildRetrievalGuide(scope, LIMIT);

    (scope.selection as unknown as { semanticUnitIds: string[] }).semanticUnitIds.push(
      "unit_b",
    );

    expect(guide.kind).toBe("managed_document");
    if (guide.kind !== "managed_document") {
      throw new Error("expected a managed document guide");
    }
    expect(guide.selector).toEqual({
      kind: "semantic_units",
      semanticUnitIds: ["unit_a"],
    });
  });

  it("returns the same guide for the same scope twice", () => {
    const scope = scopeOfKind(createRefundPolicyCard(), "managed_document");

    expect(buildRetrievalGuide(scope, LIMIT)).toEqual(
      buildRetrievalGuide(scope, LIMIT),
    );
  });

  it("leaves no scope of a mixed card without a guide", () => {
    const card: ApprovedCard = {
      ...createRefundPolicyCard(),
      scopes: [
        scopeOfKind(createRefundPolicyCard(), "managed_document"),
        scopeOfKind(createPaymentsTableCard(), "sql_source"),
        scopeOfKind(createPaymentApiCard(), "http_source"),
      ],
    };

    expect(
      card.scopes.map((scope) => buildRetrievalGuide(scope, LIMIT).kind),
    ).toEqual(["managed_document", "sql", "http"]);
  });

  it("refuses a scope kind outside the approved union", () => {
    const rogue = {
      kind: "graphql_source",
      reference: { scopeId: "scope_x", scopeVersion: "scopev_0001" },
    } as unknown as ApprovedScope;

    expect(() => buildRetrievalGuide(rogue, LIMIT)).toThrow(
      SelectionScopeInvariantError,
    );
  });
});

describe("retrievalGuideKey", () => {
  it("is a canonical sha256 digest", () => {
    const guide = buildRetrievalGuide(
      scopeOfKind(createRefundPolicyCard(), "managed_document"),
      LIMIT,
    );

    expect(retrievalGuideKey(guide)).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("is equal for the same scope under the same bound", () => {
    const first = buildRetrievalGuide(
      scopeOfKind(createRefundPolicyCard(), "managed_document"),
      LIMIT,
    );
    const second = buildRetrievalGuide(
      scopeOfKind(createRefundPolicyCard(), "managed_document"),
      LIMIT,
    );

    expect(retrievalGuideKey(first)).toBe(retrievalGuideKey(second));
  });

  it("differs when the bound differs, because that is a different request", () => {
    const scope = scopeOfKind(createRefundPolicyCard(), "managed_document");

    expect(retrievalGuideKey(buildRetrievalGuide(scope, 8))).not.toBe(
      retrievalGuideKey(buildRetrievalGuide(scope, 9)),
    );
  });

  it("differs when the scope version moves", () => {
    const base = scopeOfKind(createRefundPolicyCard(), "managed_document");
    const next: ApprovedManagedDocumentScope = {
      ...base,
      reference: { scopeId: base.reference.scopeId, scopeVersion: "scopev_0002" },
    };

    expect(retrievalGuideKey(buildRetrievalGuide(base, LIMIT))).not.toBe(
      retrievalGuideKey(buildRetrievalGuide(next, LIMIT)),
    );
  });

  it("differs between two scope kinds that share a scope reference", () => {
    const document = scopeOfKind(createRefundPolicyCard(), "managed_document");
    const sql: ApprovedScope = {
      ...scopeOfKind(createPaymentsTableCard(), "sql_source"),
      reference: document.reference,
    };

    expect(retrievalGuideKey(buildRetrievalGuide(document, LIMIT))).not.toBe(
      retrievalGuideKey(buildRetrievalGuide(sql, LIMIT)),
    );
  });
});
