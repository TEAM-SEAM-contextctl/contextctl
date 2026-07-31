import {
  parseIngestionPublication,
  type IngestionPublication,
} from "@contextctl/contracts";

const documentDigest =
  "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

/** Markdown-backed publication: the MVP shape Registry consumes end to end. */
export function createIngestionPublicationFixture(
  publicationId = "pub_initial",
): IngestionPublication {
  return parseIngestionPublication({
    schemaVersion: 1,
    publicationId,
    sourceId: "src_payments",
    observationId: "obs_initial",
    producedAt: "2026-07-29T00:00:00.000Z",
    knowledgeUnits: [
      {
        id: "unit_payment_failures",
        kind: "section",
        sourceCoordinate: {
          kind: "document",
          sourceId: "src_payments",
          documentId: "doc_payments",
          semanticUnitId: "unit_payment_failures",
        },
        evidence: [
          {
            name: "summary",
            value: "Failed payments are retried after five minutes.",
          },
        ],
        publishedScopes: [
          {
            scopeId: "scope_payment_failures",
            scopeVersion: "scpv_aaaa",
            kind: "managed_document",
            documentIndex: {
              documentIndexId: "didx_payments",
              sourceId: "src_payments",
              documentId: "doc_payments",
              indexVersion: "idxv_aaaa",
              connectorId: "vector.local",
              accessHandle: "documents/payments/indexes/aaaa",
            },
            selector: {
              kind: "semantic_units",
              semanticUnitIds: ["unit_payment_failures"],
            },
          },
        ],
        provenance: {
          observationId: "obs_initial",
          producer: { id: "markdown.parser", version: "1.0.0" },
          policyVersions: {
            segmentation: "semantic-unit-v1",
            chunking: "managed-chunk-v1",
          },
        },
        contentDigest: documentDigest,
      },
    ],
    changes: [
      {
        kind: "added",
        knowledgeUnitId: "unit_payment_failures",
        currentContentDigest: documentDigest,
      },
    ],
  });
}

/**
 * Document publication whose unit publishes two scope revisions: a whole
 * document scope and a narrower semantic-unit scope.
 */
export function createMultiScopePublicationFixture(): IngestionPublication {
  const publication = createIngestionPublicationFixture("pub_multi_scope");
  const [unit] = publication.knowledgeUnits;
  if (unit === undefined) {
    throw new Error("fixture must publish one knowledge unit");
  }

  return parseIngestionPublication({
    ...publication,
    knowledgeUnits: [
      {
        ...unit,
        publishedScopes: [
          ...unit.publishedScopes,
          {
            scopeId: "scope_payments_document",
            scopeVersion: "scpv_bbbb",
            kind: "managed_document",
            documentIndex: {
              documentIndexId: "didx_payments",
              sourceId: "src_payments",
              documentId: "doc_payments",
              indexVersion: "idxv_aaaa",
              connectorId: "vector.local",
              accessHandle: "documents/payments/indexes/aaaa",
            },
            selector: { kind: "document" },
          },
        ],
      },
    ],
  });
}

/** PostgreSQL publication: coordinates only, no embedded content. */
export function createSqlPublicationFixture(): IngestionPublication {
  return parseIngestionPublication({
    schemaVersion: 1,
    publicationId: "pub_sql",
    sourceId: "src_payments_db",
    observationId: "obs_sql",
    producedAt: "2026-07-29T00:00:00.000Z",
    knowledgeUnits: [
      {
        id: "unit_payments_table",
        kind: "table",
        sourceCoordinate: {
          kind: "sql_table",
          sourceId: "src_payments_db",
          schema: "public",
          table: "payments",
          columns: ["created_at", "failed_reason", "status"],
        },
        evidence: [{ name: "row.count", value: 1200 }],
        publishedScopes: [
          {
            scopeId: "scope_payments_table",
            scopeVersion: "scpv_cccc",
            kind: "sql_source",
            connector: "postgres.main",
            table: "payments",
            columns: ["failed_reason", "status"],
          },
        ],
        provenance: {
          observationId: "obs_sql",
          producer: { id: "postgres.introspection", version: "1.0.0" },
          policyVersions: { profiling: "limited-v1" },
        },
        contentDigest: documentDigest,
      },
    ],
    changes: [
      {
        kind: "added",
        knowledgeUnitId: "unit_payments_table",
        currentContentDigest: documentDigest,
      },
    ],
  });
}

/** OpenAPI publication: method and path coordinates only. */
export function createHttpPublicationFixture(): IngestionPublication {
  return parseIngestionPublication({
    schemaVersion: 1,
    publicationId: "pub_http",
    sourceId: "src_payments_api",
    observationId: "obs_http",
    producedAt: "2026-07-29T00:00:00.000Z",
    knowledgeUnits: [
      {
        id: "unit_get_payment",
        kind: "operation",
        sourceCoordinate: {
          kind: "http_operation",
          sourceId: "src_payments_api",
          method: "GET",
          path: "/payments/{id}",
        },
        evidence: [{ name: "operation.id", value: "getPayment" }],
        publishedScopes: [
          {
            scopeId: "scope_get_payment",
            scopeVersion: "scpv_dddd",
            kind: "http_source",
            connector: "payments.api",
            method: "GET",
            path: "/payments/{id}",
          },
        ],
        provenance: {
          observationId: "obs_http",
          producer: { id: "openapi.parser", version: "1.0.0" },
          policyVersions: { normalization: "openapi-v1" },
        },
        contentDigest: documentDigest,
      },
    ],
    changes: [
      {
        kind: "added",
        knowledgeUnitId: "unit_get_payment",
        currentContentDigest: documentDigest,
      },
    ],
  });
}
