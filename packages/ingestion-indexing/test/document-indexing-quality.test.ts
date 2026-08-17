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
      ids: sequentialBlockIds("blk_quality"),
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
      ids: sequentialUnitIds("unit_quality"),
    });
    const managedChunks = generateManagedChunks({
      document,
      semanticUnits,
      ids: sequentialChunkIds("chk_quality"),
    });

    expect({ semanticUnits, managedChunks }).toMatchInlineSnapshot(`
      {
        "managedChunks": [
          {
            "chunkPolicyVersion": "managed-chunk-v1",
            "contentDigest": "sha256:5efb67efa154aad20749afe3f9b57ce3842dac43658c0741b5c285d5eee4ff3f",
            "documentId": "doc_quality",
            "id": "chk_quality_1",
            "observationId": "obs_quality",
            "ordinal": 0,
            "revisionId": "crv_h5zzrimszwu3xyzu7irffsaq34jna3lhgfgtwuagxwynv2w67m7a",
            "semanticUnitId": "unit_quality_2",
            "sourceId": "src_quality",
            "sourceSlices": [
              {
                "blockId": "blk_quality_1",
                "endOffset": 16,
                "separatorBefore": "",
                "startOffset": 0,
              },
              {
                "blockId": "blk_quality_2",
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
            "id": "chk_quality_2",
            "observationId": "obs_quality",
            "ordinal": 0,
            "revisionId": "crv_lwacqoiq7xyaqetoft75q5lmjzf5ts5vo3yq6gnmwwbliecngj6a",
            "semanticUnitId": "unit_quality_3",
            "sourceId": "src_quality",
            "sourceSlices": [
              {
                "blockId": "blk_quality_3",
                "endOffset": 12,
                "separatorBefore": "",
                "startOffset": 0,
              },
              {
                "blockId": "blk_quality_4",
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
            "id": "chk_quality_3",
            "observationId": "obs_quality",
            "ordinal": 0,
            "revisionId": "crv_avibc7cpycarzawnzh5bxyvtpndjhxefktm6p72niniykl3j7q2a",
            "semanticUnitId": "unit_quality_4",
            "sourceId": "src_quality",
            "sourceSlices": [
              {
                "blockId": "blk_quality_5",
                "endOffset": 19,
                "separatorBefore": "",
                "startOffset": 0,
              },
              {
                "blockId": "blk_quality_6",
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
              "unit_quality_2",
              "unit_quality_4",
            ],
            "contentDigest": "sha256:e349e47881551af53c8402d93378644cda5ea6fc589c3388760498e958e139be",
            "diagnostics": [],
            "documentId": "doc_quality",
            "id": "unit_quality_1",
            "kind": "document",
            "observationId": "obs_quality",
            "revisionId": "urv_wk7l2wtupv65wtfru77h4qra247rgyjtjtoaoxb6pvoty5nhf75a",
            "segmentationPolicyVersion": "semantic-unit-v1",
            "sourceId": "src_quality",
            "title": "Payment failures",
          },
          {
            "blockIds": [
              "blk_quality_1",
              "blk_quality_2",
            ],
            "boundary": {
              "kind": "explicit_heading",
            },
            "childIds": [
              "unit_quality_3",
            ],
            "contentDigest": "sha256:5efb67efa154aad20749afe3f9b57ce3842dac43658c0741b5c285d5eee4ff3f",
            "diagnostics": [],
            "documentId": "doc_quality",
            "id": "unit_quality_2",
            "kind": "section",
            "observationId": "obs_quality",
            "parentId": "unit_quality_1",
            "revisionId": "urv_6brwst6szxyqrqgqokenzs73n2hr5a7nl3jmcym6hojtzzkia3sq",
            "segmentationPolicyVersion": "semantic-unit-v1",
            "sourceId": "src_quality",
            "title": "Payment failures",
          },
          {
            "blockIds": [
              "blk_quality_3",
              "blk_quality_4",
            ],
            "boundary": {
              "kind": "explicit_heading",
            },
            "childIds": [],
            "contentDigest": "sha256:752732fa337d9aa97468c4bcf5462305eac2d9de65b55faa7dd89cae7e7c34e3",
            "diagnostics": [],
            "documentId": "doc_quality",
            "id": "unit_quality_3",
            "kind": "section",
            "observationId": "obs_quality",
            "parentId": "unit_quality_2",
            "revisionId": "urv_7px35sk5bho56crzv2lirnc4lya6y2illpaqvojjt6mjffnjjsxq",
            "segmentationPolicyVersion": "semantic-unit-v1",
            "sourceId": "src_quality",
            "title": "Retry policy",
          },
          {
            "blockIds": [
              "blk_quality_5",
              "blk_quality_6",
            ],
            "boundary": {
              "kind": "explicit_heading",
            },
            "childIds": [],
            "contentDigest": "sha256:728ec78d823a2a7f97f6ae1c6fcbf416cf3e03f62016a3c38ce77f1b88255d42",
            "diagnostics": [],
            "documentId": "doc_quality",
            "id": "unit_quality_4",
            "kind": "section",
            "observationId": "obs_quality",
            "parentId": "unit_quality_1",
            "revisionId": "urv_ug7avhlmdgmqriqottwct5a55ogx2dymmsbwbfopxfgagtbo3awa",
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
  return { nextBlockId: () => `${prefix}_${++sequence}` };
}

function sequentialUnitIds(prefix: string): SemanticUnitIdSource {
  let sequence = 0;
  return { nextUnitId: () => `${prefix}_${++sequence}` };
}

function sequentialChunkIds(prefix: string): ManagedChunkIdSource {
  let sequence = 0;
  return { nextChunkId: () => `${prefix}_${++sequence}` };
}
