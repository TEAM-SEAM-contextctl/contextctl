import { describe, expect, it } from "vitest";

import {
  reconcileSemanticUnitLineage,
  segmentNormalizedDocument,
  sha256Digest,
  type DocumentBlock,
  type DocumentSemanticUnit,
  type NormalizedDocument,
  type SemanticUnitIdSource,
} from "../src/index.js";
import { validateDocumentSemanticUnits } from "../src/domain/document-model.js";
import { createSegmentationDocument } from "./fixtures/semantic-segmentation-fixture.js";

describe("Semantic Unit lineage", () => {
  it("inherits equivalent Unit identities and keeps revisions stable", () => {
    const previousDocument = paragraphDocument(["a", "b", "c"]);
    const currentDocument = observeAgain(previousDocument);
    const previousUnits = segmentNormalizedDocument({
      document: previousDocument,
      ids: sequentialUnitIds("old"),
    });
    const currentUnits = segmentNormalizedDocument({
      document: currentDocument,
      ids: sequentialUnitIds("new"),
    });

    const result = reconcileSemanticUnitLineage({
      previousDocument,
      previousUnits,
      currentDocument,
      currentUnits,
    });

    expect(result.units.map((unit) => unit.id)).toEqual(
      previousUnits.map((unit) => unit.id),
    );
    expect(result.units.map((unit) => unit.revisionId)).toEqual(
      previousUnits.map((unit) => unit.revisionId),
    );
    expect(result.decisions.every((decision) => decision.kind === "inherited"))
      .toBe(true);
  });

  it("inherits a clearly edited Unit and advances only affected revisions", () => {
    const previousDocument = paragraphDocument(["a", "b", "c"]);
    const currentDocument = editBlock(observeAgain(previousDocument), "blk_b");
    const previousUnits = segmentNormalizedDocument({
      document: previousDocument,
      ids: sequentialUnitIds("old"),
    });
    const currentUnits = segmentNormalizedDocument({
      document: currentDocument,
      ids: sequentialUnitIds("new"),
    });
    const result = reconcileSemanticUnitLineage({
      previousDocument,
      previousUnits,
      currentDocument,
      currentUnits,
    });

    expect(result.units.map((unit) => unit.id)).toEqual(
      previousUnits.map((unit) => unit.id),
    );
    expect(result.units.find((unit) => unit.kind === "segment")?.revisionId)
      .not.toBe(previousUnits.find((unit) => unit.kind === "segment")?.revisionId);
    expect(result.units.find((unit) => unit.kind === "document")?.revisionId)
      .not.toBe(previousUnits.find((unit) => unit.kind === "document")?.revisionId);
  });

  it("uses heading Block identity when a section title changes", () => {
    const previousDocument = createSegmentationDocument([
      { kind: "heading", level: 1, text: "Payments" },
      { kind: "paragraph", text: "Retry failed payments." },
    ]);
    const currentDocument = editBlock(
      observeAgain(previousDocument),
      "blk_0",
      "Payment recovery",
    );
    const previousUnits = segmentNormalizedDocument({
      document: previousDocument,
      ids: sequentialUnitIds("old"),
    });
    const currentUnits = segmentNormalizedDocument({
      document: currentDocument,
      ids: sequentialUnitIds("new"),
    });
    const result = reconcileSemanticUnitLineage({
      previousDocument,
      previousUnits,
      currentDocument,
      currentUnits,
    });
    const previousSection = previousUnits.find((unit) => unit.kind === "section");
    const currentSection = result.units.find((unit) => unit.kind === "section");

    expect(currentSection?.id).toBe(previousSection?.id);
    expect(currentSection?.revisionId).not.toBe(previousSection?.revisionId);
    expect(result.decisions).toContainEqual(
      expect.objectContaining({
        kind: "inherited",
        unitId: previousSection?.id,
        match: "heading_block",
      }),
    );
  });

  it("preserves section identity when sections move within the document", () => {
    const previousDocument = createSegmentationDocument([
      { kind: "heading", level: 1, text: "Payments" },
      { kind: "paragraph", text: "Retry failed payments." },
      { kind: "heading", level: 1, text: "Deployments" },
      { kind: "paragraph", text: "Rollback failed deployments." },
    ]);
    const currentDocument = reorderBlocks(
      observeAgain(previousDocument),
      ["blk_2", "blk_3", "blk_0", "blk_1"],
    );
    const previousUnits = segmentNormalizedDocument({
      document: previousDocument,
      ids: sequentialUnitIds("old"),
    });
    const currentUnits = segmentNormalizedDocument({
      document: currentDocument,
      ids: sequentialUnitIds("new"),
    });
    const result = reconcileSemanticUnitLineage({
      previousDocument,
      previousUnits,
      currentDocument,
      currentUnits,
    });

    const previousSections = new Map(
      previousUnits
        .filter((unit) => unit.kind === "section")
        .map((unit) => [unit.title, unit]),
    );
    for (const current of result.units.filter((unit) => unit.kind === "section")) {
      expect(current.id).toBe(previousSections.get(current.title)?.id);
      expect(current.revisionId).toBe(
        previousSections.get(current.title)?.revisionId,
      );
    }
    expect(result.units.find((unit) => unit.kind === "document")?.revisionId)
      .not.toBe(previousUnits.find((unit) => unit.kind === "document")?.revisionId);
  });

  it("inherits a dominant split survivor but gives the secondary Unit a new ID", () => {
    const previousDocument = paragraphDocument(["a", "b", "c", "d"]);
    const currentDocument = observeAgain(previousDocument);
    const previousUnits = unitTree(previousDocument, "old", [["blk_a", "blk_b", "blk_c", "blk_d"]]);
    const currentUnits = unitTree(currentDocument, "new", [
      ["blk_a", "blk_b", "blk_c"],
      ["blk_d"],
    ]);
    const result = reconcileSemanticUnitLineage({
      previousDocument,
      previousUnits,
      currentDocument,
      currentUnits,
    });
    const previousSegment = previousUnits[1];

    expect(result.units[1]?.id).toBe(previousSegment?.id);
    expect(result.units[2]?.id).toBe("unit_new_2");
    expect(result.decisions).toContainEqual({
      kind: "created",
      unitId: "unit_new_2",
      reason: "split",
    });
  });

  it("inherits a dominant merge survivor and removes the absorbed Unit", () => {
    const previousDocument = paragraphDocument(["a", "b", "c", "d"]);
    const currentDocument = observeAgain(previousDocument);
    const previousUnits = unitTree(previousDocument, "old", [
      ["blk_a", "blk_b", "blk_c"],
      ["blk_d"],
    ]);
    const currentUnits = unitTree(currentDocument, "new", [
      ["blk_a", "blk_b", "blk_c", "blk_d"],
    ]);
    const result = reconcileSemanticUnitLineage({
      previousDocument,
      previousUnits,
      currentDocument,
      currentUnits,
    });

    expect(result.units[1]?.id).toBe("unit_old_1");
    expect(result.decisions).toContainEqual({
      kind: "inherited",
      unitId: "unit_old_1",
      provisionalUnitId: "unit_new_1",
      match: "block_jaccard",
      score: 0.75,
    });
    expect(result.decisions).toContainEqual({
      kind: "removed",
      unitId: "unit_old_2",
      reason: "merge",
    });
  });

  it("rejects balanced split and merge candidates instead of guessing identity", () => {
    const previousDocument = paragraphDocument(["a", "b", "c", "d"]);
    const currentDocument = observeAgain(previousDocument);
    const split = reconcileSemanticUnitLineage({
      previousDocument,
      previousUnits: unitTree(previousDocument, "old", [
        ["blk_a", "blk_b", "blk_c", "blk_d"],
      ]),
      currentDocument,
      currentUnits: unitTree(currentDocument, "split", [
        ["blk_a", "blk_b"],
        ["blk_c", "blk_d"],
      ]),
    });
    const merge = reconcileSemanticUnitLineage({
      previousDocument,
      previousUnits: unitTree(previousDocument, "prior", [
        ["blk_a", "blk_b"],
        ["blk_c", "blk_d"],
      ]),
      currentDocument,
      currentUnits: unitTree(currentDocument, "merged", [
        ["blk_a", "blk_b", "blk_c", "blk_d"],
      ]),
    });

    expect(split.decisions.filter((decision) => decision.kind === "created"))
      .toEqual([
        expect.objectContaining({ reason: "split" }),
        expect.objectContaining({ reason: "split" }),
      ]);
    expect(merge.decisions.filter((decision) => decision.kind === "created"))
      .toEqual([expect.objectContaining({ reason: "merge" })]);
    expect(
      [...split.units, ...merge.units]
        .filter((unit) => unit.kind === "segment")
        .every((unit) => !unit.id.startsWith("unit_old_") && !unit.id.startsWith("unit_prior_")),
    ).toBe(true);
  });

  it("applies the 0.60 Block-ID Jaccard threshold and reports deletion", () => {
    const previousDocument = paragraphDocument(["a", "b", "c", "d"]);
    const previousUnits = unitTree(previousDocument, "old", [
      ["blk_a", "blk_b", "blk_c", "blk_d"],
    ]);
    const atThresholdDocument = paragraphDocument(["a", "b", "c", "x"], "obs_threshold");
    const belowThresholdDocument = paragraphDocument(
      ["a", "b", "c", "x", "y"],
      "obs_below",
    );
    const atThreshold = reconcileSemanticUnitLineage({
      previousDocument,
      previousUnits,
      currentDocument: atThresholdDocument,
      currentUnits: unitTree(atThresholdDocument, "threshold", [
        ["blk_a", "blk_b", "blk_c", "blk_x"],
      ]),
    });
    const belowThreshold = reconcileSemanticUnitLineage({
      previousDocument,
      previousUnits,
      currentDocument: belowThresholdDocument,
      currentUnits: unitTree(belowThresholdDocument, "below", [
        ["blk_a", "blk_b", "blk_c", "blk_x", "blk_y"],
      ]),
    });

    expect(atThreshold.units[1]?.id).toBe("unit_old_1");
    expect(belowThreshold.units[1]?.id).toBe("unit_below_1");
    expect(belowThreshold.decisions).toContainEqual({
      kind: "created",
      unitId: "unit_below_1",
      reason: "ambiguous",
    });
    expect(belowThreshold.decisions).toContainEqual({
      kind: "removed",
      unitId: "unit_old_1",
      reason: "ambiguous",
    });
  });

  it("classifies unrelated Units as created and deleted", () => {
    const previousDocument = paragraphDocument(["a", "b"]);
    const currentDocument = paragraphDocument(["x", "y"], "obs_current");
    const result = reconcileSemanticUnitLineage({
      previousDocument,
      previousUnits: unitTree(previousDocument, "old", [["blk_a", "blk_b"]]),
      currentDocument,
      currentUnits: unitTree(currentDocument, "new", [["blk_x", "blk_y"]]),
    });

    expect(result.decisions).toContainEqual({
      kind: "created",
      unitId: "unit_new_1",
      reason: "new",
    });
    expect(result.decisions).toContainEqual({
      kind: "removed",
      unitId: "unit_old_1",
      reason: "deleted",
    });
  });

  it("rejects malformed lineage inputs before remapping identity", () => {
    const previousDocument = paragraphDocument(["a"]);
    const currentDocument = observeAgain(previousDocument);
    const previousUnits = unitTree(previousDocument, "same", [["blk_a"]]);
    const currentUnits = unitTree(currentDocument, "same", [["blk_a"]]);

    expect(() =>
      reconcileSemanticUnitLineage({
        previousDocument,
        previousUnits,
        currentDocument,
        currentUnits,
      }),
    ).toThrowError(expect.objectContaining({ code: "conflicting_provisional_id" }));
  });

  it("rejects mixed segmentation policy versions within one Unit snapshot", () => {
    const previousDocument = paragraphDocument(["a"]);
    const currentDocument = observeAgain(previousDocument);
    const currentUnits = unitTree(currentDocument, "new", [["blk_a"]]).map(
      (unit, index) =>
        index === 1
          ? { ...unit, segmentationPolicyVersion: "semantic-unit-v2" }
          : unit,
    );

    expect(() =>
      reconcileSemanticUnitLineage({
        previousDocument,
        previousUnits: unitTree(previousDocument, "old", [["blk_a"]]),
        currentDocument,
        currentUnits,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "inconsistent_segmentation_policy" }),
    );
  });

  it("starts new Unit lineage when the segmentation policy changes", () => {
    const previousDocument = paragraphDocument(["a", "b"]);
    const currentDocument = observeAgain(previousDocument);
    const previousUnits = unitTree(previousDocument, "old", [["blk_a", "blk_b"]]);
    const currentUnits = unitTree(
      currentDocument,
      "new",
      [["blk_a", "blk_b"]],
      "semantic-unit-v2",
    );
    const result = reconcileSemanticUnitLineage({
      previousDocument,
      previousUnits,
      currentDocument,
      currentUnits,
    });

    expect(result.units.map((unit) => unit.id)).toEqual([
      "unit_new_root",
      "unit_new_1",
    ]);
    expect(
      result.decisions.every(
        (decision) =>
          decision.kind !== "inherited" && decision.reason === "policy_changed",
      ),
    ).toBe(true);
  });

  it("produces the same reconciliation for the same inputs", () => {
    const previousDocument = paragraphDocument(["a", "b", "c"]);
    const currentDocument = observeAgain(previousDocument);
    const input = {
      previousDocument,
      previousUnits: unitTree(previousDocument, "old", [["blk_a", "blk_b", "blk_c"]]),
      currentDocument,
      currentUnits: unitTree(currentDocument, "new", [["blk_a", "blk_b", "blk_c"]]),
    };

    expect(reconcileSemanticUnitLineage(input)).toEqual(
      reconcileSemanticUnitLineage(input),
    );
  });

  it("keeps reconciled output valid", () => {
    const previousDocument = paragraphDocument(["a", "b"]);
    const currentDocument = observeAgain(previousDocument);
    const result = reconcileSemanticUnitLineage({
      previousDocument,
      previousUnits: unitTree(previousDocument, "old", [["blk_a", "blk_b"]]),
      currentDocument,
      currentUnits: unitTree(currentDocument, "new", [["blk_a", "blk_b"]]),
    });

    expect(validateDocumentSemanticUnits(currentDocument, result.units)).toEqual(
      [],
    );
  });
});

function paragraphDocument(
  names: readonly string[],
  observationId = "obs_previous",
): NormalizedDocument {
  const base = createSegmentationDocument(
    names.map((name) => ({ kind: "paragraph" as const, text: `content ${name}` })),
  );
  const blocks = base.blocks.map((block, index) => ({
    ...block,
    id: `blk_${names[index]}`,
    sectionPath: [],
  }));
  return {
    ...base,
    observationId,
    contentDigest: sha256Digest(blocks.map((block) => block.text).join("\n\n")),
    blocks,
  };
}

function observeAgain(document: NormalizedDocument): NormalizedDocument {
  return { ...document, observationId: "obs_current" };
}

function editBlock(
  document: NormalizedDocument,
  blockId: string,
  text = "edited content with preserved identity",
): NormalizedDocument {
  const blocks = document.blocks.map((block): DocumentBlock =>
    block.id === blockId
      ? {
          ...block,
          text,
          analysisText: text.toLowerCase(),
          contentDigest: sha256Digest(text),
          revisionId: `brv_${"b".repeat(52)}`,
        }
      : block,
  );
  return {
    ...document,
    contentDigest: sha256Digest(blocks.map((block) => block.text).join("\n\n")),
    blocks,
  };
}

function reorderBlocks(
  document: NormalizedDocument,
  blockIds: readonly string[],
): NormalizedDocument {
  const byId = new Map(document.blocks.map((block) => [block.id, block]));
  let offset = 0;
  const blocks = blockIds.map((id, order): DocumentBlock => {
    const block = byId.get(id);
    if (block === undefined) {
      throw new Error(`Fixture Block is missing: ${id}`);
    }
    const startOffset = offset;
    offset += block.text.length;
    const reordered = {
      ...block,
      order,
      sourceSpan: {
        kind: "text" as const,
        startOffset,
        endOffset: offset,
        startLine: order * 2 + 1,
        endLine: order * 2 + 1,
      },
    };
    offset += 2;
    return reordered;
  });
  return {
    ...document,
    contentDigest: sha256Digest(blocks.map((block) => block.text).join("\n\n")),
    blocks,
  };
}

function unitTree(
  document: NormalizedDocument,
  prefix: string,
  groups: readonly (readonly string[])[],
  segmentationPolicyVersion = "semantic-unit-v1",
): readonly DocumentSemanticUnit[] {
  const rootId = `unit_${prefix}_root`;
  const childIds = groups.map((_, index) => `unit_${prefix}_${index + 1}`);
  const common = {
    sourceId: document.sourceId,
    observationId: document.observationId,
    documentId: document.documentId,
    segmentationPolicyVersion,
    diagnostics: [],
  } as const;
  return [
    {
      ...common,
      id: rootId,
      revisionId: validUnitRevision("a"),
      kind: "document",
      childIds,
      blockIds: [],
      boundary: { kind: "document_root" },
      contentDigest: document.contentDigest,
    },
    ...groups.map((blockIds, index): DocumentSemanticUnit => ({
      ...common,
      id: childIds[index] ?? "unit_missing",
      revisionId: validUnitRevision("b"),
      kind: "segment",
      parentId: rootId,
      childIds: [],
      blockIds,
      boundary: { kind: "size_fallback" },
      contentDigest: sha256Digest(
        blockIds
          .map((id) => document.blocks.find((block) => block.id === id)?.text ?? "")
          .join("\n\n"),
      ),
    })),
  ];
}

function validUnitRevision(character: "a" | "b"): string {
  return `urv_${character.repeat(52)}`;
}

function sequentialUnitIds(prefix: string): SemanticUnitIdSource {
  let sequence = 0;
  return {
    nextUnitId: () => {
      sequence += 1;
      return `unit_${prefix}_${sequence}`;
    },
  };
}
