import { describe, expect, it } from "vitest";

import {
  canonicalizeDocumentIndexingPolicy,
  DEFAULT_DOCUMENT_INDEXING_POLICY,
  digestDocumentIndexingPolicy,
  DocumentIndexingPolicyValidationError,
  measureText,
  parseDocumentIndexingPolicy,
  validateDocumentIndexingPolicy,
} from "../src/index.js";

describe("document indexing policy", () => {
  it("exposes immutable defaults fixed by the v1 policy versions", () => {
    expect(DEFAULT_DOCUMENT_INDEXING_POLICY).toEqual({
      textMeasureProfile: {
        version: "unicode-estimate-v1",
        algorithm: "unicode_codepoint_estimate",
      },
      segmentation: {
        version: "semantic-unit-v1",
        textMeasureProfileVersion: "unicode-estimate-v1",
        minUnitTokens: 120,
        targetUnitTokens: 600,
        maxUnitTokens: 1200,
        lexicalWindowBlocks: 3,
        boundaryMadMultiplier: 1,
        zeroMadMinDepth: 0.35,
      },
      chunk: {
        version: "managed-chunk-v1",
        textMeasureProfileVersion: "unicode-estimate-v1",
        targetChunkTokens: 320,
        maxChunkTokens: 480,
        overlapTokens: 48,
      },
      lineage: {
        version: "lineage-policy-v1",
        blockMinTokenJaccard: 0.85,
        blockMinRunnerUpMargin: 0.1,
        unitMinBlockIdJaccard: 0.6,
        unitMinRunnerUpMargin: 0.15,
      },
    });
    expect(Object.isFrozen(DEFAULT_DOCUMENT_INDEXING_POLICY)).toBe(true);
    expect(Object.isFrozen(DEFAULT_DOCUMENT_INDEXING_POLICY.segmentation)).toBe(
      true,
    );
    expect(validateDocumentIndexingPolicy(DEFAULT_DOCUMENT_INDEXING_POLICY)).toEqual(
      [],
    );
    expect(parseDocumentIndexingPolicy(DEFAULT_DOCUMENT_INDEXING_POLICY)).toBe(
      DEFAULT_DOCUMENT_INDEXING_POLICY,
    );
  });

  it("measures Unicode text deterministically without an embedding tokenizer", () => {
    expect(measureText("abcd1234")).toBe(2);
    expect(measureText("ab cd")).toBe(2);
    expect(measureText("한글 漢字 カナ")).toBe(6);
    expect(measureText("abc!🙂")).toBe(3);
    expect(measureText("\t\n\u0000")).toBe(0);
  });

  it("rejects unsupported text measurement profiles", () => {
    expect(() =>
      measureText("text", {
        version: "tokenizer-v2",
        algorithm: "model_tokenizer",
      } as never),
    ).toThrow(DocumentIndexingPolicyValidationError);
  });

  it("rejects unsupported policy versions", () => {
    const invalid = {
      ...DEFAULT_DOCUMENT_INDEXING_POLICY,
      segmentation: {
        ...DEFAULT_DOCUMENT_INDEXING_POLICY.segmentation,
        version: "semantic-unit-v2",
      },
    };

    expect(validateDocumentIndexingPolicy(invalid)).toContainEqual(
      expect.objectContaining({
        code: "invalid_discriminator",
        path: "$.segmentation.version",
      }),
    );
  });

  it("rejects value changes made without a policy version bump", () => {
    const invalid = {
      ...DEFAULT_DOCUMENT_INDEXING_POLICY,
      segmentation: {
        ...DEFAULT_DOCUMENT_INDEXING_POLICY.segmentation,
        targetUnitTokens: 601,
      },
    };

    expect(validateDocumentIndexingPolicy(invalid)).toContainEqual(
      expect.objectContaining({
        code: "invalid_value",
        path: "$.segmentation.targetUnitTokens",
      }),
    );
  });

  it("rejects invalid hard limits and incompatible profile versions", () => {
    const invalid = {
      ...DEFAULT_DOCUMENT_INDEXING_POLICY,
      segmentation: {
        ...DEFAULT_DOCUMENT_INDEXING_POLICY.segmentation,
        textMeasureProfileVersion: "unicode-estimate-v2",
        minUnitTokens: 700,
      },
      chunk: {
        ...DEFAULT_DOCUMENT_INDEXING_POLICY.chunk,
        maxChunkTokens: 1300,
        overlapTokens: 320,
      },
    };

    expect(validateDocumentIndexingPolicy(invalid)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "relationship_mismatch",
          path: "$.segmentation.minUnitTokens",
        }),
        expect.objectContaining({
          code: "relationship_mismatch",
          path: "$.segmentation.textMeasureProfileVersion",
        }),
        expect.objectContaining({
          code: "relationship_mismatch",
          path: "$.chunk.maxChunkTokens",
        }),
        expect.objectContaining({
          code: "relationship_mismatch",
          path: "$.chunk.overlapTokens",
        }),
      ]),
    );
  });

  it("rejects thresholds outside their valid domains", () => {
    const invalid = {
      ...DEFAULT_DOCUMENT_INDEXING_POLICY,
      segmentation: {
        ...DEFAULT_DOCUMENT_INDEXING_POLICY.segmentation,
        boundaryMadMultiplier: -1,
      },
      chunk: {
        ...DEFAULT_DOCUMENT_INDEXING_POLICY.chunk,
        targetChunkTokens: 0,
      },
      lineage: {
        ...DEFAULT_DOCUMENT_INDEXING_POLICY.lineage,
        blockMinTokenJaccard: 1.1,
      },
    };

    expect(validateDocumentIndexingPolicy(invalid)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid_value",
          path: "$.segmentation.boundaryMadMultiplier",
        }),
        expect.objectContaining({
          code: "invalid_value",
          path: "$.chunk.targetChunkTokens",
        }),
        expect.objectContaining({
          code: "invalid_value",
          path: "$.lineage.blockMinTokenJaccard",
        }),
      ]),
    );
  });

  it("rejects fields outside the fixed v1 contract", () => {
    const invalid = {
      ...DEFAULT_DOCUMENT_INDEXING_POLICY,
      experimental: true,
    };

    expect(validateDocumentIndexingPolicy(invalid)).toContainEqual(
      expect.objectContaining({ code: "invalid_value", path: "$" }),
    );
  });

  it("canonicalizes equivalent object layouts to the same digest", () => {
    const reordered = {
      lineage: {
        unitMinRunnerUpMargin: 0.15,
        version: "lineage-policy-v1",
        unitMinBlockIdJaccard: 0.6,
        blockMinRunnerUpMargin: 0.1,
        blockMinTokenJaccard: 0.85,
      },
      chunk: {
        overlapTokens: 48,
        maxChunkTokens: 480,
        version: "managed-chunk-v1",
        targetChunkTokens: 320,
        textMeasureProfileVersion: "unicode-estimate-v1",
      },
      textMeasureProfile: {
        algorithm: "unicode_codepoint_estimate",
        version: "unicode-estimate-v1",
      },
      segmentation: {
        zeroMadMinDepth: 0.35,
        lexicalWindowBlocks: 3,
        version: "semantic-unit-v1",
        maxUnitTokens: 1200,
        targetUnitTokens: 600,
        minUnitTokens: 120,
        textMeasureProfileVersion: "unicode-estimate-v1",
        boundaryMadMultiplier: 1,
      },
    };

    expect(canonicalizeDocumentIndexingPolicy(reordered)).toBe(
      canonicalizeDocumentIndexingPolicy(DEFAULT_DOCUMENT_INDEXING_POLICY),
    );
    expect(digestDocumentIndexingPolicy(reordered)).toBe(
      digestDocumentIndexingPolicy(DEFAULT_DOCUMENT_INDEXING_POLICY),
    );
    expect(digestDocumentIndexingPolicy(reordered)).toBe(
      "sha256:8a6dc5272db45aa8d78f31e982ddc3ba81e9d4c9636c2249a81735b2530289a8",
    );
  });
});
