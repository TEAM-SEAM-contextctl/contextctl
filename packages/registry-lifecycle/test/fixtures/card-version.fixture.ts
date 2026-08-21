import type { CardVersion } from "../../src/domain/card-version.js";
import type { RetrievalScope } from "../../src/domain/retrieval-scope.js";
import { fixtureRootId } from "./ingestion-publication.fixture.js";

/** Current version of the Markdown-backed Card, matching the document fixture. */
export function createDocumentCardVersion(
  overrides: { readonly indexVersion?: string } = {},
): CardVersion {
  const scope: RetrievalScope = {
    kind: "managed_document",
    reference: { scopeId: "scope_payment_failures", scopeVersion: "scpv_aaaa" },
    documentIndex: {
      documentIndexId: "didx_payments",
      sourceId: fixtureRootId("src", "payments"),
      documentId: fixtureRootId("doc", "payments"),
      indexVersion: overrides.indexVersion ?? "idxv_aaaa",
    },
    selection: {
      kind: "semantic_units",
      semanticUnitIds: ["unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd"],
    },
  };

  return {
    id: "cv_document",
    cardId: "unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd",
    lineage: {
      publicationId: fixtureRootId("pub", "initial"),
      observationId: fixtureRootId("obs", "initial"),
      knowledgeUnitId: "unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd",
    },
    scopes: [scope],
    validationState: "validated",
    createdAt: "2026-07-30T00:00:00.000Z",
  };
}

/** Current version of the PostgreSQL Card, referencing two observed columns. */
export function createSqlCardVersion(
  overrides: { readonly columns?: readonly string[] } = {},
): CardVersion {
  const scope: RetrievalScope = {
    kind: "sql_source",
    reference: { scopeId: "scope_payments_table", scopeVersion: "scpv_cccc" },
    connector: "postgres.main",
    schema: "public",
    table: "payments",
    columns: overrides.columns ?? ["failed_reason", "status"],
  };

  return {
    id: "cv_sql",
    cardId: "unit_01890f5c-7b1a-784f-8ec3-8cba518ce3ba",
    lineage: {
      publicationId: fixtureRootId("pub", "sql"),
      observationId: fixtureRootId("obs", "sql"),
      knowledgeUnitId: "unit_01890f5c-7b1a-784f-8ec3-8cba518ce3ba",
    },
    scopes: [scope],
    validationState: "validated",
    createdAt: "2026-07-30T00:00:00.000Z",
  };
}

/** Current version of the OpenAPI Card. */
export function createHttpCardVersion(): CardVersion {
  const scope: RetrievalScope = {
    kind: "http_source",
    reference: { scopeId: "scope_get_payment", scopeVersion: "scpv_dddd" },
    connector: "payments.api",
    method: "GET",
    path: "/payments/{id}",
    operationId: "getPayment",
    parameters: [{ location: "path", name: "id", required: true }],
  };

  return {
    id: "cv_http",
    cardId: "unit_01890f5c-7b1a-7e07-8297-3b51cb4b4083",
    lineage: {
      publicationId: fixtureRootId("pub", "http"),
      observationId: fixtureRootId("obs", "http"),
      knowledgeUnitId: "unit_01890f5c-7b1a-7e07-8297-3b51cb4b4083",
    },
    scopes: [scope],
    validationState: "validated",
    createdAt: "2026-07-30T00:00:00.000Z",
  };
}
