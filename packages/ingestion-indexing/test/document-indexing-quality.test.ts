import { describe, expect, it } from "vitest";

import {
  generateManagedChunks,
  MarkdownCapture,
  RemarkMarkdownParser,
  segmentNormalizedDocument,
  sha256Digest,
  type BlockIdSource,
  type ManagedChunkIdSource,
  type SemanticUnitIdSource,
} from "../src/index.js";
import { structuralId } from "./fixtures/root-id-fixture.js";

describe("document indexing quality gate", () => {
  it("pins the complete Markdown Semantic Unit and Managed Chunk result", () => {
    const source = [
      "# Payment failures",
      "",
      "Inspect the payment status before retrying a failed charge.",
      "",
      "## Retry policy",
      "",
      "Retry transient failures after a bounded delay.",
      "",
      "# Deployment recovery",
      "",
      "Roll back the release when cluster health checks keep failing.",
    ].join("\n");
    const document = new MarkdownCapture({
      parser: new RemarkMarkdownParser(),
      ids: sequentialBlockIds("blk_01890f5c-7b1a-7849-807c-0721fef85d03"),
    }).capture({
      source: { id: "src_quality", targetKey: "file:/quality.md" },
      observationId: "obs_quality",
      documentId: "doc_quality",
      snapshot: {
        kind: "markdown",
        targetKey: "file:/quality.md",
        capturedAt: "2026-08-05T00:00:00.000Z",
        content: source,
        contentDigest: sha256Digest(source),
      },
    });
    const semanticUnits = segmentNormalizedDocument({
      document,
      ids: sequentialUnitIds("unit_01890f5c-7b1a-7fbd-8efe-611ee1ec4eff"),
    });
    const managedChunks = generateManagedChunks({
      document,
      semanticUnits,
      ids: sequentialChunkIds("chk_01890f5c-7b1a-7457-828b-f00461eded63"),
    });

    expect({ semanticUnits, managedChunks }).toMatchInlineSnapshot(`
      {
        "managedChunks": [
          {
            "chunkPolicyVersion": "managed-chunk-v1",
            "contentDigest": "sha256:5efb67efa154aad20749afe3f9b57ce3842dac43658c0741b5c285d5eee4ff3f",
            "documentId": "doc_quality",
            "id": "chk_01890f5c-7b1a-7337-8094-53facee5352e",
            "observationId": "obs_quality",
            "ordinal": 0,
            "revisionId": "crv_2epk324mgkd6zrrejei5rfsoz2oktjba7pguaaehamvv6lqtqcuq",
            "semanticUnitId": "unit_01890f5c-7b1a-7517-88b8-40c3623439dd",
            "sourceId": "src_quality",
            "sourceSlices": [
              {
                "blockId": "blk_01890f5c-7b1a-7566-8c00-42c4cde0657a",
                "endOffset": 16,
                "separatorBefore": "",
                "startOffset": 0,
              },
              {
                "blockId": "blk_01890f5c-7b1a-7943-8b68-2a6b2a384c0b",
                "endOffset": 59,
                "separatorBefore": "

      ",
                "startOffset": 0,
              },
            ],
            "splitKind": "block_pack",
            "text": "Payment failures

      Inspect the payment status before retrying a failed charge.",
            "textMeasureProfileVersion": "unicode-estimate-v1",
            "tokenCount": 21,
          },
          {
            "chunkPolicyVersion": "managed-chunk-v1",
            "contentDigest": "sha256:752732fa337d9aa97468c4bcf5462305eac2d9de65b55faa7dd89cae7e7c34e3",
            "documentId": "doc_quality",
            "id": "chk_01890f5c-7b1a-78db-808e-09b1992791de",
            "observationId": "obs_quality",
            "ordinal": 0,
            "revisionId": "crv_xpngi3lxrz4wzvnya7lkhzb73syydygvimhwuvcigzaaykapljtq",
            "semanticUnitId": "unit_01890f5c-7b1a-7b11-82ee-704da3529b3a",
            "sourceId": "src_quality",
            "sourceSlices": [
              {
                "blockId": "blk_01890f5c-7b1a-7cfd-8ec9-ec5f78a21ef4",
                "endOffset": 12,
                "separatorBefore": "",
                "startOffset": 0,
              },
              {
                "blockId": "blk_01890f5c-7b1a-7baf-8903-58ac5fdd7b5c",
                "endOffset": 47,
                "separatorBefore": "

      ",
                "startOffset": 0,
              },
            ],
            "splitKind": "block_pack",
            "text": "Retry policy

      Retry transient failures after a bounded delay.",
            "textMeasureProfileVersion": "unicode-estimate-v1",
            "tokenCount": 19,
          },
          {
            "chunkPolicyVersion": "managed-chunk-v1",
            "contentDigest": "sha256:728ec78d823a2a7f97f6ae1c6fcbf416cf3e03f62016a3c38ce77f1b88255d42",
            "documentId": "doc_quality",
            "id": "chk_01890f5c-7b1a-7564-8ccc-6d61366071e5",
            "observationId": "obs_quality",
            "ordinal": 0,
            "revisionId": "crv_dczhvyyyedqk4b3rac42w772tvrt5dmwo5erv5ylkax3bfvd2taa",
            "semanticUnitId": "unit_01890f5c-7b1a-7554-8c9e-bdf07e270d78",
            "sourceId": "src_quality",
            "sourceSlices": [
              {
                "blockId": "blk_01890f5c-7b1a-7d91-8d82-32d277422c53",
                "endOffset": 19,
                "separatorBefore": "",
                "startOffset": 0,
              },
              {
                "blockId": "blk_01890f5c-7b1a-7c5e-8d69-ba7dcac104d3",
                "endOffset": 62,
                "separatorBefore": "

      ",
                "startOffset": 0,
              },
            ],
            "splitKind": "block_pack",
            "text": "Deployment recovery

      Roll back the release when cluster health checks keep failing.",
            "textMeasureProfileVersion": "unicode-estimate-v1",
            "tokenCount": 21,
          },
        ],
        "semanticUnits": [
          {
            "blockIds": [],
            "boundary": {
              "kind": "document_root",
            },
            "childIds": [
              "unit_01890f5c-7b1a-7517-88b8-40c3623439dd",
              "unit_01890f5c-7b1a-7554-8c9e-bdf07e270d78",
            ],
            "contentDigest": "sha256:e349e47881551af53c8402d93378644cda5ea6fc589c3388760498e958e139be",
            "diagnostics": [],
            "documentId": "doc_quality",
            "id": "unit_01890f5c-7b1a-7a62-85d8-b4560117b21b",
            "kind": "document",
            "observationId": "obs_quality",
            "revisionId": "urv_pp3xvhcfhpooglgsww52zjybaec52gkxs3nev5amdtbce473wk2a",
            "segmentationPolicyVersion": "semantic-unit-v1",
            "sourceId": "src_quality",
            "title": "Payment failures",
          },
          {
            "blockIds": [
              "blk_01890f5c-7b1a-7566-8c00-42c4cde0657a",
              "blk_01890f5c-7b1a-7943-8b68-2a6b2a384c0b",
            ],
            "boundary": {
              "kind": "explicit_heading",
            },
            "childIds": [
              "unit_01890f5c-7b1a-7b11-82ee-704da3529b3a",
            ],
            "contentDigest": "sha256:5efb67efa154aad20749afe3f9b57ce3842dac43658c0741b5c285d5eee4ff3f",
            "diagnostics": [],
            "documentId": "doc_quality",
            "id": "unit_01890f5c-7b1a-7517-88b8-40c3623439dd",
            "kind": "section",
            "observationId": "obs_quality",
            "parentId": "unit_01890f5c-7b1a-7a62-85d8-b4560117b21b",
            "revisionId": "urv_xvvbnlxsh2dlw6qyzho7cgkqyvz3wqjl2pvqqfkumftevksswz5q",
            "segmentationPolicyVersion": "semantic-unit-v1",
            "sourceId": "src_quality",
            "title": "Payment failures",
          },
          {
            "blockIds": [
              "blk_01890f5c-7b1a-7cfd-8ec9-ec5f78a21ef4",
              "blk_01890f5c-7b1a-7baf-8903-58ac5fdd7b5c",
            ],
            "boundary": {
              "kind": "explicit_heading",
            },
            "childIds": [],
            "contentDigest": "sha256:752732fa337d9aa97468c4bcf5462305eac2d9de65b55faa7dd89cae7e7c34e3",
            "diagnostics": [],
            "documentId": "doc_quality",
            "id": "unit_01890f5c-7b1a-7b11-82ee-704da3529b3a",
            "kind": "section",
            "observationId": "obs_quality",
            "parentId": "unit_01890f5c-7b1a-7517-88b8-40c3623439dd",
            "revisionId": "urv_kgqss3mi6qxh5ykzitoga7u3dpzri3w5izuyen5aac35f4zmoqbq",
            "segmentationPolicyVersion": "semantic-unit-v1",
            "sourceId": "src_quality",
            "title": "Retry policy",
          },
          {
            "blockIds": [
              "blk_01890f5c-7b1a-7d91-8d82-32d277422c53",
              "blk_01890f5c-7b1a-7c5e-8d69-ba7dcac104d3",
            ],
            "boundary": {
              "kind": "explicit_heading",
            },
            "childIds": [],
            "contentDigest": "sha256:728ec78d823a2a7f97f6ae1c6fcbf416cf3e03f62016a3c38ce77f1b88255d42",
            "diagnostics": [],
            "documentId": "doc_quality",
            "id": "unit_01890f5c-7b1a-7554-8c9e-bdf07e270d78",
            "kind": "section",
            "observationId": "obs_quality",
            "parentId": "unit_01890f5c-7b1a-7a62-85d8-b4560117b21b",
            "revisionId": "urv_aothghsohfacllohmawine2opqfx4hdyzc62y3p4mypaof3p473q",
            "segmentationPolicyVersion": "semantic-unit-v1",
            "sourceId": "src_quality",
            "title": "Deployment recovery",
          },
        ],
      }
    `);
  });
});

function sequentialBlockIds(prefix: string): BlockIdSource {
  let sequence = 0;
  return {
    nextBlockId: () => structuralId("blk", `${prefix}-${String(++sequence)}`),
  };
}

function sequentialUnitIds(prefix: string): SemanticUnitIdSource {
  let sequence = 0;
  return {
    nextUnitId: () => structuralId("unit", `${prefix}-${String(++sequence)}`),
  };
}

function sequentialChunkIds(prefix: string): ManagedChunkIdSource {
  let sequence = 0;
  return {
    nextChunkId: () => structuralId("chk", `${prefix}-${String(++sequence)}`),
  };
}
