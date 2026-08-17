import { describe, expect, it } from "vitest";

import {
  DEFAULT_DOCUMENT_INDEXING_POLICY,
  generateManagedChunks,
  inheritableScopeUnitIds,
  LINEAGE_POLICY_VERSION,
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
  type NormalizedDocument,
  type SemanticUnitIdSource,
} from "../src/index.js";

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
  "",
  "# Alerting",
  "",
  "Page the on-call engineer for sustained error rates.",
].join("\n");

/** Shortens an early paragraph, shifting every following `sourceSpan`. */
const EDITED_EARLY = INITIAL.replace(
  "after five minutes.",
  "after ten minutes.",
);

/** Adds a Block at the top, shifting every following `order` and offset. */
const PREPENDED = ["Introductory note.", "", INITIAL].join("\n");

describe("Block revision position independence", () => {
  it("keeps the revision of Blocks that only moved in the source", () => {
    const previous = createSnapshot(INITIAL, "previous");
    const current = createSnapshot(EDITED_EARLY, "current", previous);

    const previousById = new Map(
      previous.document.blocks.map((block) => [block.id, block]),
    );
    const followers = current.document.blocks.filter((block) => {
      const prior = previousById.get(block.id);
      return prior !== undefined && prior.text === block.text;
    });

    expect(followers.length).toBeGreaterThan(0);
    for (const block of followers) {
      const prior = previousById.get(block.id)!;
      expect(block.contentDigest).toBe(prior.contentDigest);
      expect(block.revisionId).toBe(prior.revisionId);
    }
    // The fixture must actually move something, or the assertion is vacuous.
    expect(
      followers.some(
        (block) =>
          JSON.stringify(block.sourceSpan) !==
          JSON.stringify(previousById.get(block.id)!.sourceSpan),
      ),
    ).toBe(true);
  });

  it("still advances the revision of a Block whose content changed", () => {
    const previous = createSnapshot(INITIAL, "previous");
    const current = createSnapshot(EDITED_EARLY, "current", previous);

    const previousById = new Map(
      previous.document.blocks.map((block) => [block.id, block]),
    );
    const edited = current.document.blocks.filter((block) => {
      const prior = previousById.get(block.id);
      return prior !== undefined && prior.text !== block.text;
    });

    expect(edited).toHaveLength(1);
    expect(edited[0]!.revisionId).not.toBe(
      previousById.get(edited[0]!.id)!.revisionId,
    );
  });

  it("keeps the revision of Blocks pushed down by a leading insertion", () => {
    const previous = createSnapshot(INITIAL, "previous");
    const current = createSnapshot(PREPENDED, "current", previous);

    const previousById = new Map(
      previous.document.blocks.map((block) => [block.id, block]),
    );
    const carried = current.document.blocks.filter((block) =>
      previousById.has(block.id),
    );

    expect(carried.length).toBe(previous.document.blocks.length);
    for (const block of carried) {
      const prior = previousById.get(block.id)!;
      expect(block.order).not.toBe(prior.order);
      expect(block.revisionId).toBe(prior.revisionId);
    }
  });

  it("lets an untouched Unit inherit its Scope after an early edit", () => {
    const previous = createSnapshot(INITIAL, "previous");
    const current = createSnapshot(EDITED_EARLY, "current", previous);

    const plan = planDocumentIncrementalUpdate({ previous, current });
    const unchanged = plan.semanticUnitChanges.filter(
      (change) => change.kind === "unchanged",
    );

    expect(plan.strategy).toBe("incremental");
    // Before the fix every Unit after the edit was reported as `updated`.
    expect(unchanged.length).toBeGreaterThan(0);
    expect(inheritableScopeUnitIds({ previous, plan })).toEqual(
      unchanged.map((change) => change.unitId).sort(),
    );
  });

  it("keeps source spans usable for tracing back to the original text", () => {
    const snapshot = createSnapshot(EDITED_EARLY, "current");

    for (const block of snapshot.document.blocks) {
      expect(block.sourceSpan.kind).toBe("text");
      if (block.sourceSpan.kind === "text") {
        const { startOffset, endOffset } = block.sourceSpan;
        expect(endOffset).toBeLessThanOrEqual(EDITED_EARLY.length);
        expect(startOffset).toBeLessThan(endOffset);
        // Spans cover raw Markdown, so they contain rather than equal the
        // normalized Block text.
        expect(EDITED_EARLY.slice(startOffset, endOffset)).toContain(
          block.text,
        );
      }
    }
  });

  it("restarts Unit lineage when the lineage policy version changes", () => {
    const previous = createSnapshot(INITIAL, "previous");
    // Provisional Units, exactly as the reconciler receives them.
    const current = createSnapshot(INITIAL, "current");
    const staleDocument: NormalizedDocument = {
      ...previous.document,
      lineagePolicyVersion: "lineage-policy-v1",
    };

    const result = reconcileSemanticUnitLineage({
      previousDocument: staleDocument,
      previousUnits: previous.semanticUnits,
      currentDocument: current.document,
      currentUnits: current.semanticUnits,
    });

    expect(current.document.lineagePolicyVersion).toBe(LINEAGE_POLICY_VERSION);
    expect(result.units.map((unit) => unit.id)).toEqual(
      current.semanticUnits.map((unit) => unit.id),
    );
  });
});

function createSnapshot(
  content: string,
  seed: string,
  previous?: DocumentIndexingSnapshot,
): DocumentIndexingSnapshot {
  const capture = new MarkdownCapture({
    parser: new RemarkMarkdownParser(),
    ids: sequentialBlockIds(seed),
  });
  const document = capture.capture({
    source: { id: "src_revision", targetKey: "file:/runbook.md" },
    observationId: `obs_${seed}`,
    documentId: "doc_runbook",
    snapshot: {
      kind: "markdown",
      targetKey: "file:/runbook.md",
      capturedAt: "2026-08-18T00:00:00.000Z",
      content,
      contentDigest: sha256Digest(content),
    },
    ...(previous === undefined ? {} : { previousDocument: previous.document }),
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
    embeddingProfile: PROFILE,
    payloadSchemaVersion: 2,
  };
}

function sequentialBlockIds(seed: string): BlockIdSource {
  let next = 0;
  return { nextBlockId: () => `blk_${seed}_${String(next++)}` };
}

function sequentialUnitIds(seed: string): SemanticUnitIdSource {
  let next = 0;
  return { nextUnitId: () => `unit_${seed}_${String(next++)}` };
}

function sequentialChunkIds(seed: string): ManagedChunkIdSource {
  let next = 0;
  return { nextChunkId: () => `chk_${seed}_${String(next++)}` };
}
