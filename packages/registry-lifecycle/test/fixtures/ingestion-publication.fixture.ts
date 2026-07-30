import { parseIngestionPublication, type IngestionPublication } from "@contextctl/contracts";

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
        contentDigest:
          "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      },
    ],
    changes: [
      {
        kind: "added",
        knowledgeUnitId: "unit_payment_failures",
        currentContentDigest:
          "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      },
    ],
  });
}
