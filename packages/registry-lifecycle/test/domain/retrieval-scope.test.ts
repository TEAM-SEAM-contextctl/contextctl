import { describe, expect, it } from "vitest";

import { translatePublishedScope } from "../../src/domain/retrieval-scope.js";
import {
  createHttpPublicationFixture,
  createIngestionPublicationFixture,
  createMultiScopePublicationFixture,
  createSqlPublicationFixture,
  fixtureRootId,
} from "../fixtures/ingestion-publication.fixture.js";

function onlyScope(publication: ReturnType<typeof createSqlPublicationFixture>) {
  const scope = publication.knowledgeUnits[0]?.publishedScopes[0];
  if (scope === undefined) {
    throw new Error("fixture must publish one scope");
  }
  return scope;
}

describe("translatePublishedScope", () => {
  it("translates a managed document scope and keeps the index reference opaque", () => {
    const scope = onlyScope(createIngestionPublicationFixture());

    expect(translatePublishedScope(scope)).toEqual({
      kind: "managed_document",
      reference: {
        scopeId: "scope_payment_failures",
        scopeVersion: "scpv_aaaa",
      },
      documentIndex: {
        documentIndexId: "didx_payments",
        sourceId: fixtureRootId("src", "payments"),
        documentId: fixtureRootId("doc", "payments"),
        indexVersion: "idxv_aaaa",
      },
      selection: {
        kind: "semantic_units",
        semanticUnitIds: ["unit_payment_failures"],
      },
    });
  });

  it("translates a whole-document selector", () => {
    const scopes = createMultiScopePublicationFixture().knowledgeUnits[0]
      ?.publishedScopes;
    const documentScope = scopes?.find(
      (scope) => scope.scopeId === "scope_payments_document",
    );
    expect(documentScope).toBeDefined();
    if (documentScope === undefined) {
      return;
    }

    expect(translatePublishedScope(documentScope)).toMatchObject({
      kind: "managed_document",
      reference: { scopeVersion: "scpv_bbbb" },
      selection: { kind: "document" },
    });
  });

  it("translates a SQL source scope", () => {
    const scope = onlyScope(createSqlPublicationFixture());

    expect(translatePublishedScope(scope)).toEqual({
      kind: "sql_source",
      reference: { scopeId: "scope_payments_table", scopeVersion: "scpv_cccc" },
      connector: "postgres.main",
      schema: "public",
      table: "payments",
      columns: ["failed_reason", "status"],
    });
  });

  it("translates an HTTP source scope", () => {
    const scope = onlyScope(createHttpPublicationFixture());

    expect(translatePublishedScope(scope)).toEqual({
      kind: "http_source",
      reference: { scopeId: "scope_get_payment", scopeVersion: "scpv_dddd" },
      connector: "payments.api",
      method: "GET",
      path: "/payments/{id}",
      operationId: "getPayment",
      parameters: [{ location: "path", name: "id", required: true }],
    });
  });

  it("does not leak the Ingestion selector field name into the read model", () => {
    const translated = translatePublishedScope(
      onlyScope(createIngestionPublicationFixture()),
    );

    expect(translated).not.toHaveProperty("selector");
    expect(translated).not.toHaveProperty("scopeId");
  });
});
