import type {
  DocumentSemanticUnit,
  ManagedChunk,
  NormalizedDocument,
} from "../../src/domain/document-model.js";
import { sha256Digest } from "../../src/domain/document-capture.js";
import type {
  IndexManifest,
  VectorIndexRecord,
} from "../../src/domain/index-manifest.js";

const heading = "Payment failures";
const paragraph = "Retry failed payments after five minutes.";
const chunkText = `${heading}\n\n${paragraph}`;
const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;
const digestC = `sha256:${"c".repeat(64)}`;
const digestD = `sha256:${"d".repeat(64)}`;

export function createDocumentFixture(): NormalizedDocument {
  return {
    schemaVersion: 1,
    documentId: "doc_payments",
    sourceId: "src_payments",
    observationId: "obs_initial",
    mediaType: "text/markdown",
    title: "Payments runbook",
    parser: { id: "markdown-parser", version: "1.0.0" },
    normalizationPolicyVersion: "normalize-v1",
    lineagePolicyVersion: "lineage-v1",
    contentDigest: digestA,
    completeness: { status: "complete", diagnostics: [] },
    blocks: [
      {
        id: "blk_payment_failures",
        revisionId: "brv_aaaa",
        kind: "heading",
        order: 0,
        sectionPath: ["blk_payment_failures"],
        text: heading,
        analysisText: heading.toLowerCase(),
        contentDigest: digestB,
        sourceSpan: {
          kind: "text",
          startOffset: 0,
          endOffset: heading.length,
          startLine: 1,
          endLine: 1,
        },
        structure: { kind: "heading", level: 1 },
      },
      {
        id: "blk_retry_policy",
        revisionId: "brv_bbbb",
        kind: "paragraph",
        order: 1,
        sectionPath: ["blk_payment_failures"],
        text: paragraph,
        analysisText: paragraph.toLowerCase(),
        contentDigest: digestC,
        sourceSpan: {
          kind: "text",
          startOffset: heading.length + 2,
          endOffset: heading.length + 2 + paragraph.length,
          startLine: 3,
          endLine: 3,
        },
        structure: { kind: "paragraph" },
      },
    ],
  };
}

export function createSemanticUnitFixture(): readonly DocumentSemanticUnit[] {
  return [
    {
      id: "unit_payments",
      revisionId: "urv_aaaa",
      sourceId: "src_payments",
      observationId: "obs_initial",
      documentId: "doc_payments",
      kind: "document",
      title: "Payments runbook",
      childIds: ["unit_payment_failures"],
      blockIds: [],
      boundary: { kind: "document_root" },
      contentDigest: digestA,
      segmentationPolicyVersion: "semantic-unit-v1",
      diagnostics: [],
    },
    {
      id: "unit_payment_failures",
      revisionId: "urv_bbbb",
      sourceId: "src_payments",
      observationId: "obs_initial",
      documentId: "doc_payments",
      kind: "section",
      title: "Payment failures",
      parentId: "unit_payments",
      childIds: [],
      blockIds: ["blk_payment_failures", "blk_retry_policy"],
      boundary: { kind: "explicit_heading" },
      contentDigest: digestD,
      segmentationPolicyVersion: "semantic-unit-v1",
      diagnostics: [],
    },
  ];
}

export function createManagedChunkFixture(): readonly ManagedChunk[] {
  return [
    {
      id: "chk_payment_failures",
      revisionId: "crv_aaaa",
      sourceId: "src_payments",
      observationId: "obs_initial",
      documentId: "doc_payments",
      semanticUnitId: "unit_payment_failures",
      ordinal: 0,
      sourceSlices: [
        {
          blockId: "blk_payment_failures",
          startOffset: 0,
          endOffset: heading.length,
          separatorBefore: "",
        },
        {
          blockId: "blk_retry_policy",
          startOffset: 0,
          endOffset: paragraph.length,
          separatorBefore: "\n\n",
        },
      ],
      text: chunkText,
      contentDigest: sha256Digest(chunkText),
      tokenCount: 16,
      textMeasureProfileVersion: "unicode-estimate-v1",
      chunkPolicyVersion: "managed-chunk-v1",
      splitKind: "block_pack",
    },
  ];
}

export function createIndexManifestFixture(): IndexManifest {
  return {
    documentIndexId: "didx_payments",
    indexVersion: "idxv_aaaa",
    sourceId: "src_payments",
    observationId: "obs_initial",
    documentId: "doc_payments",
    documentSchemaVersion: 1,
    parserVersion: "1.0.0",
    normalizationPolicyVersion: "normalize-v1",
    lineagePolicyVersion: "lineage-v1",
    segmentationPolicyVersion: "semantic-unit-v1",
    chunkPolicyVersion: "managed-chunk-v1",
    textMeasureProfileVersion: "unicode-estimate-v1",
    embeddingProfile: {
      id: "deterministic-test",
      version: "1.0.0",
      model: "deterministic-test-v1",
      dimensions: 3,
      distance: "cosine",
      maxInputTokens: 480,
      textMeasureProfileVersion: "unicode-estimate-v1",
    },
    payloadSchemaVersion: 1,
    semanticUnitRevisions: {
      unit_payments: "urv_aaaa",
      unit_payment_failures: "urv_bbbb",
    },
    chunkRevisions: {
      chk_payment_failures: "crv_aaaa",
    },
    recordCount: 1,
    recordSetDigest: digestA,
    scopeRevisions: [
      { scopeId: "scope_payment_failures", scopeVersion: "scpv_aaaa" },
    ],
    fallbackCounts: {},
    publishedAt: "2026-07-29T00:00:00.000Z",
  };
}

export function createVectorRecordFixture(): readonly VectorIndexRecord[] {
  return [
    {
      recordId: "vrec_aaaa",
      chunkRevisionId: "crv_aaaa",
      embedding: [0.1, 0.2, 0.3],
      metadata: {
        payloadSchemaVersion: 1,
        sourceId: "src_payments",
        observationId: "obs_initial",
        documentId: "doc_payments",
        documentIndexId: "didx_payments",
        indexVersion: "idxv_aaaa",
        semanticUnitId: "unit_payment_failures",
        chunkId: "chk_payment_failures",
        chunkRevisionId: "crv_aaaa",
        contentDigest: sha256Digest(chunkText),
      },
    },
  ];
}
