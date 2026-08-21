import type {
  DocumentSemanticUnit,
  ManagedChunk,
  NormalizedDocument,
} from "../../src/domain/document-model.js";
import { sha256Digest } from "../../src/domain/document-capture.js";
import {
  computeRecordSetDigest,
  type IndexManifest,
  type VectorIndexRecord,
} from "../../src/domain/index-manifest.js";
import { rootId } from "./root-id-fixture.js";

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
    documentId: rootId("doc", "payments"),
    sourceId: rootId("src", "payments"),
    observationId: rootId("obs", "initial"),
    mediaType: "text/markdown",
    title: "Payments runbook",
    parser: { id: "markdown-parser", version: "1.0.0" },
    normalizationPolicyVersion: "normalize-v1",
    lineagePolicyVersion: "lineage-v1",
    contentDigest: digestA,
    completeness: { status: "complete", diagnostics: [] },
    blocks: [
      {
        id: "blk_01890f5c-7b1a-7fe8-88b6-6988509d5b03",
        revisionId: "brv_aaaa",
        kind: "heading",
        order: 0,
        sectionPath: ["blk_01890f5c-7b1a-7fe8-88b6-6988509d5b03"],
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
        id: "blk_01890f5c-7b1a-70a2-8eda-f1f23edb9f60",
        revisionId: "brv_bbbb",
        kind: "paragraph",
        order: 1,
        sectionPath: ["blk_01890f5c-7b1a-7fe8-88b6-6988509d5b03"],
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
      id: "unit_01890f5c-7b1a-72e9-843d-dfdd184c9ce7",
      revisionId: "urv_aaaa",
      sourceId: rootId("src", "payments"),
      observationId: rootId("obs", "initial"),
      documentId: rootId("doc", "payments"),
      kind: "document",
      title: "Payments runbook",
      childIds: ["unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd"],
      blockIds: [],
      boundary: { kind: "document_root" },
      contentDigest: digestA,
      segmentationPolicyVersion: "semantic-unit-v1",
      diagnostics: [],
    },
    {
      id: "unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd",
      revisionId: "urv_bbbb",
      sourceId: rootId("src", "payments"),
      observationId: rootId("obs", "initial"),
      documentId: rootId("doc", "payments"),
      kind: "section",
      title: "Payment failures",
      parentId: "unit_01890f5c-7b1a-72e9-843d-dfdd184c9ce7",
      childIds: [],
      blockIds: ["blk_01890f5c-7b1a-7fe8-88b6-6988509d5b03", "blk_01890f5c-7b1a-70a2-8eda-f1f23edb9f60"],
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
      id: "chk_01890f5c-7b1a-7537-8d35-9bf8d4ab697a",
      revisionId: "crv_aaaa",
      sourceId: rootId("src", "payments"),
      observationId: rootId("obs", "initial"),
      documentId: rootId("doc", "payments"),
      semanticUnitId: "unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd",
      ordinal: 0,
      sourceSlices: [
        {
          blockId: "blk_01890f5c-7b1a-7fe8-88b6-6988509d5b03",
          startOffset: 0,
          endOffset: heading.length,
          separatorBefore: "",
        },
        {
          blockId: "blk_01890f5c-7b1a-70a2-8eda-f1f23edb9f60",
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
  const chunkBindings = {
    "chk_01890f5c-7b1a-7537-8d35-9bf8d4ab697a": {
      chunkRevisionId: "crv_aaaa",
      semanticUnitId: "unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd",
      semanticUnitRevisionId: "urv_bbbb",
      contentDigest: sha256Digest(chunkText),
    },
  } as const;
  return {
    manifestSchemaVersion: 2,
    stateNamespaceId: "state_test",
    securityDomain: "test-tenant",
    documentIndexId: "didx_payments",
    indexVersion: "idxv_aaaa",
    sourceId: rootId("src", "payments"),
    observationId: rootId("obs", "initial"),
    documentId: rootId("doc", "payments"),
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
    payloadSchemaVersion: 2,
    semanticUnitRevisions: {
      "unit_01890f5c-7b1a-72e9-843d-dfdd184c9ce7": "urv_aaaa",
      "unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd": "urv_bbbb",
    },
    chunkRevisions: {
      "chk_01890f5c-7b1a-7537-8d35-9bf8d4ab697a": "crv_aaaa",
    },
    chunkBindings,
    recordCount: 1,
    recordSetDigest: computeRecordSetDigest(chunkBindings),
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
      retrievalText: chunkText,
      metadata: {
        payloadSchemaVersion: 2,
        stateNamespaceId: "state_test",
        securityDomain: "test-tenant",
        sourceId: rootId("src", "payments"),
        observationId: rootId("obs", "initial"),
        documentId: rootId("doc", "payments"),
        documentIndexId: "didx_payments",
        indexVersion: "idxv_aaaa",
        semanticUnitId: "unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd",
        chunkId: "chk_01890f5c-7b1a-7537-8d35-9bf8d4ab697a",
        chunkRevisionId: "crv_aaaa",
        contentDigest: sha256Digest(chunkText),
      },
    },
  ];
}
