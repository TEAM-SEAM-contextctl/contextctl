import { describe, expect, it } from "vitest";

import {
  validateDocumentSemanticUnits,
  validateManagedChunks,
  validateNormalizedDocument,
} from "../src/domain/document-model.js";
import {
  validateIndexManifest,
  validateVectorIndexRecords,
} from "../src/domain/index-manifest.js";
import {
  createDocumentFixture,
  createIndexManifestFixture,
  createManagedChunkFixture,
  createSemanticUnitFixture,
  createVectorRecordFixture,
} from "./fixtures/document-fixture.js";

describe("ingestion document model", () => {
  it("accepts a complete block, semantic unit and chunk lineage", () => {
    const document = createDocumentFixture();
    const units = createSemanticUnitFixture();
    const chunks = createManagedChunkFixture();

    expect(validateNormalizedDocument(document)).toEqual([]);
    expect(validateDocumentSemanticUnits(document, units)).toEqual([]);
    expect(validateManagedChunks(document, units, chunks)).toEqual([]);
  });

  it("rejects duplicate block ownership and cyclic unit hierarchies", () => {
    const document = createDocumentFixture();
    const [root, section] = createSemanticUnitFixture();
    expect(root).toBeDefined();
    expect(section).toBeDefined();
    if (root === undefined || section === undefined) {
      return;
    }

    const invalidUnits = [
      {
        ...root,
        blockIds: ["blk_payment_failures"],
      },
      {
        ...section,
        childIds: [root.id],
      },
    ];

    const codes = validateDocumentSemanticUnits(document, invalidUnits).map(
      (problem) => problem.code,
    );

    expect(codes).toContain("relationship_mismatch");
    expect(codes).toContain("cycle_detected");
  });

  it("rejects a non-heading block that references itself as a section", () => {
    const document = createDocumentFixture();
    const invalid = {
      ...document,
      blocks: document.blocks.map((block) =>
        block.id === "blk_retry_policy"
          ? { ...block, sectionPath: [block.id] }
          : block,
      ),
    };

    expect(validateNormalizedDocument(invalid)).toContainEqual(
      expect.objectContaining({
        code: "invalid_reference",
        path: "blocks[1].sectionPath[0]",
      }),
    );
  });

  it("rejects chunks that cannot be reconstructed from their source blocks", () => {
    const document = createDocumentFixture();
    const units = createSemanticUnitFixture();
    const [chunk] = createManagedChunkFixture();
    expect(chunk).toBeDefined();
    if (chunk === undefined) {
      return;
    }

    const issues = validateManagedChunks(document, units, [
      { ...chunk, text: "untraceable text" },
    ]);

    expect(issues).toContainEqual(
      expect.objectContaining({ code: "text_mismatch", path: "chunks[0].text" }),
    );
  });
});

describe("ingestion index manifest", () => {
  it("accepts a manifest and records that match the immutable document index", () => {
    const document = createDocumentFixture();
    const units = createSemanticUnitFixture();
    const chunks = createManagedChunkFixture();
    const manifest = createIndexManifestFixture();

    expect(
      validateIndexManifest({ document, semanticUnits: units, chunks, manifest }),
    ).toEqual([]);
    expect(
      validateVectorIndexRecords(
        manifest,
        chunks,
        createVectorRecordFixture(),
      ),
    ).toEqual([]);
  });

  it("rejects a manifest whose revision receipt does not match its chunks", () => {
    const document = createDocumentFixture();
    const units = createSemanticUnitFixture();
    const chunks = createManagedChunkFixture();
    const manifest = {
      ...createIndexManifestFixture(),
      recordCount: 2,
      chunkRevisions: { chk_payment_failures: "crv_bbbb" },
    };

    const codes = validateIndexManifest({
      document,
      semanticUnits: units,
      chunks,
      manifest,
    }).map((problem) => problem.code);

    expect(codes).toContain("count_mismatch");
    expect(codes).toContain("relationship_mismatch");
  });

  it("rejects a manifest checksum that does not match its canonical chunk set", () => {
    const issues = validateIndexManifest({
      document: createDocumentFixture(),
      semanticUnits: createSemanticUnitFixture(),
      chunks: createManagedChunkFixture(),
      manifest: {
        ...createIndexManifestFixture(),
        recordSetDigest: `sha256:${"f".repeat(64)}`,
      },
    });

    expect(issues).toContainEqual(
      expect.objectContaining({
        code: "relationship_mismatch",
        path: "recordSetDigest",
      }),
    );
  });

  it("rejects an embedding profile incompatible with the manifest chunks", () => {
    const document = createDocumentFixture();
    const units = createSemanticUnitFixture();
    const chunks = createManagedChunkFixture();
    const base = createIndexManifestFixture();
    const manifest = {
      ...base,
      embeddingProfile: {
        ...base.embeddingProfile,
        maxInputTokens: 1,
        textMeasureProfileVersion: "other-measure",
      },
    };

    const issues = validateIndexManifest({
      document,
      semanticUnits: units,
      chunks,
      manifest,
    });

    expect(issues).toContainEqual(
      expect.objectContaining({
        code: "relationship_mismatch",
        path: "embeddingProfile.textMeasureProfileVersion",
      }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: "invalid_value",
        path: "chunks[0].tokenCount",
      }),
    );
  });

  it("rejects vector records that leak across an index version", () => {
    const manifest = createIndexManifestFixture();
    const chunks = createManagedChunkFixture();
    const [record] = createVectorRecordFixture();
    expect(record).toBeDefined();
    if (record === undefined) {
      return;
    }

    const issues = validateVectorIndexRecords(manifest, chunks, [
      {
        ...record,
        metadata: { ...record.metadata, indexVersion: "idxv_bbbb" },
      },
    ]);

    expect(issues).toContainEqual(
      expect.objectContaining({ code: "relationship_mismatch" }),
    );
  });
});
