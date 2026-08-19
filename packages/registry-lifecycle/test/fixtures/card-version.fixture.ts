import type { CardVersion } from "../../src/domain/card-version.js";
import type { RetrievalScope } from "../../src/domain/retrieval-scope.js";

/** Current version of the Markdown-backed Card, matching the document fixture. */
export function createDocumentCardVersion(
  overrides: { readonly indexVersion?: string } = {},
): CardVersion {
  const scope: RetrievalScope = {
    kind: "managed_document",
    reference: { scopeId: "scope_payment_failures", scopeVersion: "scpv_aaaa" },
    documentIndex: {
      documentIndexId: "didx_payments",
      sourceId: "src_payments",
      documentId: "doc_payments",
      indexVersion: overrides.indexVersion ?? "idxv_aaaa",
    },
    selection: {
      kind: "semantic_units",
      semanticUnitIds: ["unit_payment_failures"],
    },
  };

  return {
    id: "cv_document",
    cardId: "unit_payment_failures",
    lineage: {
      publicationId: "pub_initial",
      observationId: "obs_initial",
      knowledgeUnitId: "unit_payment_failures",
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
    cardId: "unit_payments_table",
    lineage: {
      publicationId: "pub_sql",
      observationId: "obs_sql",
      knowledgeUnitId: "unit_payments_table",
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
    cardId: "unit_get_payment",
    lineage: {
      publicationId: "pub_http",
      observationId: "obs_http",
      knowledgeUnitId: "unit_get_payment",
    },
    scopes: [scope],
    validationState: "validated",
    createdAt: "2026-07-30T00:00:00.000Z",
  };
}
