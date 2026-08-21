import { describe, expect, it } from "vitest";

import {
  decideDocumentCapture,
  DEFAULT_DOCUMENT_INDEXING_POLICY,
  generateManagedChunks,
  MarkdownCapture,
  planDocumentIncrementalUpdate,
  reconcileSemanticUnitLineage,
  RemarkMarkdownParser,
  segmentNormalizedDocument,
  sha256Digest,
  type BlockIdSource,
  type DocumentIndexingSnapshot,
  type EmbeddingProfile,
  type ManagedChunkIdSource,
  type SemanticUnitIdSource,
} from "../src/index.js";
import { structuralId } from "./fixtures/root-id-fixture.js";

const PROFILE: EmbeddingProfile = {
  id: "document-test",
  version: "1",
  model: "deterministic-test-v1",
  dimensions: 8,
  distance: "cosine",
  maxInputTokens: 480,
  textMeasureProfileVersion: "unicode-estimate-v1",
};

const INITIAL = [
  "# Payments",
  "",
  "Retry failed payments after five minutes.",
  "",
  "# Deployments",
  "",
  "Rollback the release when health checks fail.",
].join("\n");

describe("document incremental update planning", () => {
  it("uses a cheap unchanged signal only when a baseline exists", () => {
    expect(
      decideDocumentCapture({
        changeSignal: { status: "unchanged" },
        hasPreviousSnapshot: true,
      }),
    ).toEqual({ action: "skip", reason: "source_unchanged" });
    expect(
      decideDocumentCapture({
        changeSignal: { status: "unchanged" },
        hasPreviousSnapshot: false,
      }),
    ).toEqual({ action: "capture", reason: "baseline_missing" });
    expect(
      decideDocumentCapture({
        changeSignal: { status: "changed", token: "etag-2" },
        hasPreviousSnapshot: true,
      }),
    ).toEqual({ action: "capture", reason: "source_changed" });
  });

  it("plans an initial snapshot as a complete rebuild", () => {
    const current = createSnapshot(INITIAL, "initial");

    const plan = planDocumentIncrementalUpdate({ current });

    expect(plan.strategy).toBe("full_rebuild");
    expect(plan.rebuildReasons).toEqual(["baseline_missing"]);
    expect(plan.operations.embed).toHaveLength(current.chunks.length);
    expect(plan.operations.upsert).toEqual(plan.operations.embed);
    expect(plan.operations.reuse).toEqual([]);
    expect(plan.operations.delete).toEqual([]);
    expect(plan.metrics).toMatchObject({
      previousBlockCount: 0,
      currentBlockCount: 4,
      embeddingCallCount: current.chunks.length,
      reusedEmbeddingCount: 0,
    });
  });

  it("reuses every Chunk revision for a byte-equivalent observation", () => {
    const previous = createSnapshot(INITIAL, "previous");
    const current = createSnapshot(INITIAL, "current", previous);

    const plan = planDocumentIncrementalUpdate({ previous, current });

    expect(plan.strategy).toBe("incremental");
    expect(plan.blockChanges.every((change) => change.kind === "unchanged"))
      .toBe(true);
    expect(plan.chunks.map((chunk) => chunk.id)).toEqual(
      previous.chunks.map((chunk) => chunk.id),
    );
    expect(plan.chunks.map((chunk) => chunk.revisionId)).toEqual(
      previous.chunks.map((chunk) => chunk.revisionId),
    );
    expect(plan.operations.embed).toEqual([]);
    expect(plan.operations.delete).toEqual([]);
    expect(plan.operations.reuse).toHaveLength(previous.chunks.length);
  });

  it("preserves the logical Chunk ID and re-embeds only a modified section", () => {
    const previous = createSnapshot(INITIAL, "previous");
    const current = createSnapshot(
      INITIAL.replace(
        "Retry failed payments after five minutes.",
        "Retry failed payments after ten minutes.",
      ),
      "current",
      previous,
    );

    const plan = planDocumentIncrementalUpdate({ previous, current });
    const changedBlock = plan.blockChanges.find(
      (change) => change.kind === "modified",
    );

    expect(changedBlock).toMatchObject({ kind: "modified", moved: false });
    expect(plan.operations.embed).toHaveLength(1);
    expect(plan.operations.upsert).toEqual(plan.operations.embed);
    expect(plan.operations.delete).toHaveLength(1);
    expect(plan.operations.reuse).toHaveLength(previous.chunks.length - 1);
    expect(plan.operations.embed[0]?.chunkId).toBe(
      plan.operations.delete[0]?.chunkId,
    );
    expect(plan.operations.embed[0]?.chunkRevisionId).not.toBe(
      plan.operations.delete[0]?.chunkRevisionId,
    );
    expect(plan.affectedChunkClosure).toEqual({
      previousChunkIds: [plan.operations.delete[0]?.chunkId],
      currentChunkIds: [plan.operations.embed[0]?.chunkId],
    });
    expect(plan.metrics).toMatchObject({
      changedBlockCount: 1,
      embeddingCallCount: 1,
      upsertCount: 1,
      deleteCount: 1,
    });
  });

  it("does not misclassify insertion shifts as moves", () => {
    const previous = createSnapshot(INITIAL, "previous");
    const current = createSnapshot(
      ["# Overview", "", "Use this runbook during incidents.", "", INITIAL].join(
        "\n",
      ),
      "current",
      previous,
    );

    const plan = planDocumentIncrementalUpdate({ previous, current });

    expect(plan.blockChanges.filter((change) => change.kind === "added"))
      .toHaveLength(2);
    expect(plan.blockChanges.filter((change) => change.kind === "moved"))
      .toEqual([]);
    expect(
      plan.blockChanges.filter((change) => change.kind === "unchanged"),
    ).toHaveLength(previous.document.blocks.length);
    expect(plan.operations.embed).toHaveLength(1);
    expect(plan.operations.reuse).toHaveLength(previous.chunks.length);
  });

  it("classifies a moved section with Patience anchors without re-embedding it", () => {
    const previous = createSnapshot(INITIAL, "previous");
    const moved = [
      "# Deployments",
      "",
      "Rollback the release when health checks fail.",
      "",
      "# Payments",
      "",
      "Retry failed payments after five minutes.",
    ].join("\n");
    const current = createSnapshot(moved, "current", previous);

    const plan = planDocumentIncrementalUpdate({ previous, current });

    expect(plan.blockChanges.some((change) => change.kind === "moved")).toBe(
      true,
    );
    expect(plan.operations.embed).toEqual([]);
    expect(plan.operations.delete).toEqual([]);
    expect(plan.operations.reuse).toHaveLength(previous.chunks.length);
  });

  it("deletes a removed section while carrying the remaining vector", () => {
    const previous = createSnapshot(INITIAL, "previous");
    const current = createSnapshot(
      [
        "# Payments",
        "",
        "Retry failed payments after five minutes.",
      ].join("\n"),
      "current",
      previous,
    );

    const plan = planDocumentIncrementalUpdate({ previous, current });

    expect(plan.blockChanges.filter((change) => change.kind === "removed"))
      .toHaveLength(2);
    expect(plan.operations.embed).toEqual([]);
    expect(plan.operations.delete).toHaveLength(1);
    expect(plan.operations.reuse).toHaveLength(1);
  });

  it("forces a full rebuild when the embedding model changes", () => {
    const previous = createSnapshot(INITIAL, "previous");
    const current = createSnapshot(INITIAL, "current", previous, {
      ...PROFILE,
      version: "2",
      model: "deterministic-test-v2",
    });

    const plan = planDocumentIncrementalUpdate({ previous, current });

    expect(plan.strategy).toBe("full_rebuild");
    expect(plan.rebuildReasons).toContain("embedding_profile_changed");
    expect(plan.operations.embed).toHaveLength(current.chunks.length);
    expect(plan.operations.reuse).toEqual([]);
    expect(plan.operations.delete).toHaveLength(previous.chunks.length);
    expect(plan.chunks.map((chunk) => chunk.id)).toEqual(
      previous.chunks.map((chunk) => chunk.id),
    );
  });

  it("includes every overlapping Chunk touched by one Block edit", () => {
    const paragraphs = Array.from(
      { length: 80 },
      (_, index) =>
        `marker${String(index).padStart(4, "0")} operational guidance remains stable for every incident response.`,
    );
    const source = `# Large section\n\n${paragraphs.join("\n\n")}`;
    const previous = createSnapshot(source, "previous");
    const overlapToken = findOverlappingToken(previous);
    const replacement = `${overlapToken}changed`;
    const current = createSnapshot(
      source.replace(overlapToken, replacement),
      "current",
      previous,
    );

    const plan = planDocumentIncrementalUpdate({ previous, current });
    const chunksContainingReplacement = plan.chunks.filter((chunk) =>
      chunk.text.includes(replacement),
    );

    expect(chunksContainingReplacement.length).toBeGreaterThan(1);
    expect(plan.operations.embed.map((item) => item.chunkId)).toEqual(
      expect.arrayContaining(
        chunksContainingReplacement.map((chunk) => chunk.id),
      ),
    );
    expect(plan.affectedChunkClosure.currentChunkIds).toEqual(
      plan.operations.upsert.map((item) => item.chunkId),
    );
  });

  it("forces a full rebuild when a capture policy boundary changes", () => {
    const previous = createSnapshot(INITIAL, "previous");
    const unchanged = createSnapshot(INITIAL, "current", previous);
    const current: DocumentIndexingSnapshot = {
      ...unchanged,
      document: {
        ...unchanged.document,
        parser: { ...unchanged.document.parser, version: "2.0.0" },
      },
    };

    const plan = planDocumentIncrementalUpdate({ previous, current });

    expect(plan.strategy).toBe("full_rebuild");
    expect(plan.rebuildReasons).toEqual(["parser_changed"]);
    expect(plan.operations.embed).toHaveLength(current.chunks.length);
  });

  it("rejects snapshots from different logical documents", () => {
    const previous = createSnapshot(INITIAL, "previous");
    const candidate = createSnapshot(INITIAL, "current", previous);
    const current: DocumentIndexingSnapshot = {
      ...candidate,
      document: {
        ...candidate.document,
        sourceId: "src_other",
        documentId: "doc_other",
      },
      semanticUnits: candidate.semanticUnits.map((unit) => ({
        ...unit,
        sourceId: "src_other",
        documentId: "doc_other",
      })),
      chunks: candidate.chunks.map((chunk) => ({
        ...chunk,
        sourceId: "src_other",
        documentId: "doc_other",
      })),
    };

    expect(() =>
      planDocumentIncrementalUpdate({ previous, current }),
    ).toThrowError(
      expect.objectContaining({ code: "mismatched_document_identity" }),
    );
  });

  it("is deterministic for the same immutable snapshots", () => {
    const previous = createSnapshot(INITIAL, "previous");
    const current = createSnapshot(
      INITIAL.replace("five minutes", "ten minutes"),
      "current",
      previous,
    );

    expect(planDocumentIncrementalUpdate({ previous, current })).toEqual(
      planDocumentIncrementalUpdate({ previous, current }),
    );
  });
});

function createSnapshot(
  content: string,
  seed: string,
  previous?: DocumentIndexingSnapshot,
  embeddingProfile: EmbeddingProfile = PROFILE,
): DocumentIndexingSnapshot {
  const observationId = `obs_${seed}`;
  const capture = new MarkdownCapture({
    parser: new RemarkMarkdownParser(),
    ids: sequentialBlockIds(seed),
  });
  const document = capture.capture({
    source: { id: "src_incremental", targetKey: "file:/runbook.md" },
    observationId,
    documentId: "doc_runbook",
    snapshot: {
      kind: "markdown",
      targetKey: "file:/runbook.md",
      capturedAt: "2026-08-16T00:00:00.000Z",
      content,
      contentDigest: sha256Digest(content),
    },
    ...(previous === undefined
      ? {}
      : { previousDocument: previous.document }),
  });
  const provisionalUnits = segmentNormalizedDocument({
    document,
    ids: sequentialUnitIds(seed),
  });
  const semanticUnits =
    previous === undefined
      ? provisionalUnits
      : reconcileSemanticUnitLineage({
          previousDocument: previous.document,
          previousUnits: previous.semanticUnits,
          currentDocument: document,
          currentUnits: provisionalUnits,
        }).units;
  const chunks = generateManagedChunks({
    document,
    semanticUnits,
    ids: sequentialChunkIds(seed),
  });
  return {
    document,
    semanticUnits,
    chunks,
    indexingPolicy: DEFAULT_DOCUMENT_INDEXING_POLICY,
    embeddingProfile,
    payloadSchemaVersion: 2,
  };
}

function sequentialBlockIds(seed: string): BlockIdSource {
  let next = 0;
  return { nextBlockId: () => structuralId("blk", `${seed}_${String(next++)}`) };
}

function sequentialUnitIds(seed: string): SemanticUnitIdSource {
  let next = 0;
  return { nextUnitId: () => structuralId("unit", `${seed}_${String(next++)}`) };
}

function sequentialChunkIds(seed: string): ManagedChunkIdSource {
  let next = 0;
  return { nextChunkId: () => structuralId("chk", `${seed}_${String(next++)}`) };
}

function findOverlappingToken(snapshot: DocumentIndexingSnapshot): string {
  const occurrences = new Map<string, number>();
  for (const chunk of snapshot.chunks) {
    for (const token of new Set(chunk.text.match(/marker\d{4}/gu) ?? [])) {
      occurrences.set(token, (occurrences.get(token) ?? 0) + 1);
    }
  }
  const token = [...occurrences].find(([, count]) => count > 1)?.[0];
  if (token === undefined) {
    throw new Error("Fixture did not produce an overlapping token");
  }
  return token;
}
