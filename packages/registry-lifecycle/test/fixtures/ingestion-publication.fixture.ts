import {
  computePublishedKnowledgeUnitDigest,
  parseIngestionPublication,
  type IngestionPublication,
  type PublishedKnowledgeUnit,
} from "@contextctl/contracts";

/**
 * Seals a unit with the digest v2 derives from its own content.
 *
 * v2 refuses a unit whose `contentDigest` does not match what the canonical
 * digest of the rest of the record computes to, so a fixture cannot carry a
 * made-up hash the way the v1 fixtures did. Computing it here also keeps the
 * change fixtures honest: an `updated` change has to name two digests that
 * really differ, and both of them come from real units.
 */
function seal(
  unit: Omit<PublishedKnowledgeUnit, "contentDigest">,
): PublishedKnowledgeUnit {
  return { ...unit, contentDigest: computePublishedKnowledgeUnitDigest(unit) };
}

/** Markdown-backed publication: the MVP shape Registry consumes end to end. */
export function createIngestionPublicationFixture(
  publicationId = "pub_initial",
): IngestionPublication {
  const unit = seal({
    id: "unit_payment_failures",
    kind: "section",
    sourceCoordinate: {
      kind: "document",
      sourceId: "src_payments",
      documentId: "doc_payments",
      semanticUnitId: "unit_payment_failures",
    },
    // Fact names come from v2's closed vocabulary. `section.label` is what the
    // old free-form `summary` fact actually was — the heading this unit covers.
    facts: [{ name: "section.label", value: "Payment failures" }],
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
  });

  return parseIngestionPublication({
    schemaVersion: 2,
    publicationId,
    sourceId: "src_payments",
    observationId: "obs_initial",
    producedAt: "2026-07-29T00:00:00.000Z",
    knowledgeUnits: [unit],
    changes: [
      {
        kind: "added",
        knowledgeUnitId: unit.id,
        currentContentDigest: unit.contentDigest,
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
  const [first] = publication.knowledgeUnits;
  if (first === undefined) {
    throw new Error("fixture must publish one knowledge unit");
  }

  const { contentDigest: _replaced, ...content } = first;
  const unit = seal({
    ...content,
    publishedScopes: [
      ...content.publishedScopes,
      {
        scopeId: "scope_payments_document",
        scopeVersion: "scpv_bbbb",
        kind: "managed_document",
        documentIndex: {
          documentIndexId: "didx_payments",
          sourceId: "src_payments",
          documentId: "doc_payments",
          indexVersion: "idxv_aaaa",
        },
        selector: { kind: "document" },
      },
    ],
  });

  return parseIngestionPublication({
    ...publication,
    knowledgeUnits: [unit],
    changes: [
      {
        kind: "added",
        knowledgeUnitId: unit.id,
        currentContentDigest: unit.contentDigest,
      },
    ],
  });
}

/** PostgreSQL publication: coordinates only, no embedded content. */
export function createSqlPublicationFixture(): IngestionPublication {
  const unit = seal({
    id: "unit_payments_table",
    kind: "table",
    sourceCoordinate: {
      kind: "sql_table",
      sourceId: "src_payments_db",
      schema: "public",
      table: "payments",
      columns: ["created_at", "failed_reason", "status"],
    },
    facts: [{ name: "sql.approximate_row_count", value: 1200 }],
    publishedScopes: [
      {
        scopeId: "scope_payments_table",
        scopeVersion: "scpv_cccc",
        kind: "sql_source",
        connector: "postgres.main",
        // v2 carries the schema, so a Scope over `public.payments` is no longer
        // indistinguishable from one over `analytics.payments`.
        schema: "public",
        table: "payments",
        columns: ["failed_reason", "status"],
      },
    ],
    provenance: {
      observationId: "obs_sql",
      producer: { id: "postgres.introspection", version: "1.0.0" },
      policyVersions: { "schema.extraction": "limited-v1" },
    },
  });

  return parseIngestionPublication({
    schemaVersion: 2,
    publicationId: "pub_sql",
    sourceId: "src_payments_db",
    observationId: "obs_sql",
    producedAt: "2026-07-29T00:00:00.000Z",
    knowledgeUnits: [unit],
    changes: [
      {
        kind: "added",
        knowledgeUnitId: unit.id,
        currentContentDigest: unit.contentDigest,
      },
    ],
  });
}

/** OpenAPI publication: method and path coordinates only. */
export function createHttpPublicationFixture(): IngestionPublication {
  const unit = seal({
    id: "unit_get_payment",
    kind: "operation",
    sourceCoordinate: {
      kind: "http_operation",
      sourceId: "src_payments_api",
      method: "GET",
      path: "/payments/{id}",
      operationId: "getPayment",
      parameters: [{ location: "path", name: "id", required: true }],
    },
    facts: [{ name: "http.operation_id", value: "getPayment" }],
    publishedScopes: [
      {
        scopeId: "scope_get_payment",
        scopeVersion: "scpv_dddd",
        kind: "http_source",
        connector: "payments.api",
        method: "GET",
        path: "/payments/{id}",
        operationId: "getPayment",
        // The path template names `{id}`, and v2 requires every path parameter
        // to be declared and required.
        parameters: [{ location: "path", name: "id", required: true }],
      },
    ],
    provenance: {
      observationId: "obs_http",
      producer: { id: "openapi.parser", version: "1.0.0" },
      policyVersions: { normalization: "openapi-v1" },
    },
  });

  return parseIngestionPublication({
    schemaVersion: 2,
    publicationId: "pub_http",
    sourceId: "src_payments_api",
    observationId: "obs_http",
    producedAt: "2026-07-29T00:00:00.000Z",
    knowledgeUnits: [unit],
    changes: [
      {
        kind: "added",
        knowledgeUnitId: unit.id,
        currentContentDigest: unit.contentDigest,
      },
    ],
  });
}
