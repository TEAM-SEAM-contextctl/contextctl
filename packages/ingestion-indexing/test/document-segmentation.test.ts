import { describe, expect, it } from "vitest";

import {
  segmentNormalizedDocument,
  type SemanticUnitIdSource,
} from "../src/index.js";
import { validateDocumentSemanticUnits } from "../src/domain/document-model.js";
import {
  createSegmentationDocument,
  evaluateBoundaries,
  repeatedTopic,
} from "./fixtures/semantic-segmentation-fixture.js";

describe("document semantic segmentation", () => {
  it("preserves nested heading ownership before applying lexical boundaries", () => {
    const document = createSegmentationDocument([
      { kind: "paragraph", text: "Document preamble." },
      { kind: "heading", level: 1, text: "Payments" },
      { kind: "paragraph", text: "Payment operations." },
      { kind: "heading", level: 2, text: "Retries" },
      { kind: "paragraph", text: "Retry operations." },
      { kind: "heading", level: 1, text: "Deployments" },
      { kind: "paragraph", text: "Deployment operations." },
    ]);

    const units = segmentNormalizedDocument({
      document,
      ids: sequentialUnitIds(),
    });
    const root = units.find((unit) => unit.kind === "document");
    const payments = units.find((unit) => unit.title === "Payments");
    const retries = units.find((unit) => unit.title === "Retries");
    const deployments = units.find((unit) => unit.title === "Deployments");

    expect(validateDocumentSemanticUnits(document, units)).toEqual([]);
    expect(root?.blockIds).toEqual(["blk_0"]);
    expect(payments).toMatchObject({
      parentId: root?.id,
      blockIds: ["blk_1", "blk_2"],
      boundary: { kind: "explicit_heading" },
    });
    expect(retries).toMatchObject({
      parentId: payments?.id,
      blockIds: ["blk_3", "blk_4"],
    });
    expect(deployments?.parentId).toBe(root?.id);
    expect(payments?.childIds).toContain(retries?.id);
  });

  it("detects clear lexical topic shifts with deterministic Unit output", () => {
    const document = topicShiftDocument();
    const first = segmentNormalizedDocument({
      document,
      ids: sequentialUnitIds(),
    });
    const second = segmentNormalizedDocument({
      document,
      ids: sequentialUnitIds(),
    });
    const lexical = first.filter((unit) => unit.boundary.kind === "lexical");

    expect(second).toEqual(first);
    expect(lexical).toHaveLength(3);
    expect(lexical.map((unit) => unit.blockIds)).toEqual([
      ["blk_0", "blk_1", "blk_2"],
      ["blk_3", "blk_4", "blk_5"],
      ["blk_6", "blk_7", "blk_8"],
    ]);
    expect(
      lexical.every(
        (unit) =>
          unit.boundary.kind === "lexical" &&
          unit.boundary.strength >= 0 &&
          unit.boundary.strength <= 1,
      ),
    ).toBe(true);
  });

  it("keeps a gradual topic transition as a bounded lexical bridge", () => {
    const payment = ["payment", "retry", "invoice", "failure"] as const;
    const deployment = ["deploy", "release", "cluster", "rollback"] as const;
    const document = createSegmentationDocument([
      ...Array.from({ length: 3 }, () => ({
        kind: "paragraph" as const,
        text: repeatedTopic(payment),
      })),
      {
        kind: "paragraph",
        text: repeatedTopic([...payment, ...payment, ...deployment]),
      },
      {
        kind: "paragraph",
        text: repeatedTopic([...payment, ...deployment]),
      },
      {
        kind: "paragraph",
        text: repeatedTopic([...payment, ...deployment, ...deployment]),
      },
      ...Array.from({ length: 3 }, () => ({
        kind: "paragraph" as const,
        text: repeatedTopic(deployment),
      })),
    ]);

    const units = segmentNormalizedDocument({
      document,
      ids: sequentialUnitIds(),
    });
    const predicted = lexicalBoundaryOrders(document, units);

    expect(predicted).toEqual([4, 5]);
    expect(evaluateBoundaries([4, 5], predicted, document.blocks.length)).toMatchObject(
      {
        precision: 1,
        recall: 1,
        f1: 1,
      },
    );
  });

  it("keeps Unit revisions stable across equivalent observations", () => {
    const initial = topicShiftDocument();
    const observedAgain = {
      ...initial,
      observationId: "obs_segmentation_again",
    };
    const first = segmentNormalizedDocument({
      document: initial,
      ids: sequentialUnitIds(),
    });
    const second = segmentNormalizedDocument({
      document: observedAgain,
      ids: sequentialUnitIds(),
    });

    expect(second.map((unit) => unit.revisionId)).toEqual(
      first.map((unit) => unit.revisionId),
    );
    expect(second.every((unit) => unit.observationId === "obs_segmentation_again"))
      .toBe(true);
  });

  it("uses character 3-grams when Unicode word windows are sparse", () => {
    const payment = "결제실패재시도정책".repeat(24);
    const deployment = "배포롤백클러스터운영".repeat(24);
    const document = createSegmentationDocument([
      { kind: "paragraph", text: payment },
      { kind: "paragraph", text: payment },
      { kind: "paragraph", text: payment },
      { kind: "paragraph", text: deployment },
      { kind: "paragraph", text: deployment },
      { kind: "paragraph", text: deployment },
    ]);

    const units = segmentNormalizedDocument({
      document,
      ids: sequentialUnitIds(),
    });
    const predicted = lexicalBoundaryOrders(document, units);

    expect(predicted).toEqual([3]);
    expect(evaluateBoundaries([3], predicted, document.blocks.length)).toMatchObject(
      {
        precision: 1,
        recall: 1,
        f1: 1,
        pk: 0,
        windowDiff: 0,
      },
    );
  });

  it("records size fallback when a long document has no lexical valley", () => {
    const repeated = repeatedTopic(["payment", "retry", "invoice", "failure"]);
    const document = createSegmentationDocument(
      Array.from({ length: 10 }, () => ({
        kind: "paragraph" as const,
        text: repeated,
      })),
    );

    const units = segmentNormalizedDocument({
      document,
      ids: sequentialUnitIds(),
    });
    const segments = units.filter((unit) => unit.kind === "segment");

    expect(segments.length).toBeGreaterThan(1);
    expect(segments.every((unit) => unit.boundary.kind === "size_fallback")).toBe(
      true,
    );
    expect(
      segments.every((unit) =>
        unit.diagnostics.some(
          (diagnostic) => diagnostic.code === "size_fallback_applied",
        ),
      ),
    ).toBe(true);
  });

  it("keeps an oversized atomic Block intact and makes the fallback visible", () => {
    const document = createSegmentationDocument([
      { kind: "code", text: "x".repeat(5_000) },
    ]);

    const units = segmentNormalizedDocument({
      document,
      ids: sequentialUnitIds(),
    });
    const segment = units.find((unit) => unit.kind === "segment");

    expect(segment?.blockIds).toEqual(["blk_0"]);
    expect(segment?.boundary.kind).toBe("size_fallback");
    expect(segment?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "oversized_atomic_block",
          blockIds: ["blk_0"],
        }),
      ]),
    );
  });

  it("assigns every Block to exactly one Unit in document order", () => {
    const document = topicShiftDocument();
    const units = segmentNormalizedDocument({
      document,
      ids: sequentialUnitIds(),
    });
    const owned = units.flatMap((unit) => unit.blockIds);

    expect(owned).toHaveLength(document.blocks.length);
    expect(new Set(owned).size).toBe(document.blocks.length);
    expect(owned.map((id) => document.blocks.find((block) => block.id === id)?.order))
      .toEqual([...document.blocks.map((block) => block.order)]);
  });

  it("rejects partial documents instead of silently segmenting omitted content", () => {
    const document = createSegmentationDocument(
      [{ kind: "paragraph", text: "Partial source." }],
      "partial",
    );

    expect(() =>
      segmentNormalizedDocument({ document, ids: sequentialUnitIds() }),
    ).toThrowError(
      expect.objectContaining({
        code: "incomplete_document",
      }),
    );
  });

  it("rejects malformed Unit IDs at the allocation boundary", () => {
    const document = createSegmentationDocument([
      { kind: "paragraph", text: "Complete source." },
    ]);

    expect(() =>
      segmentNormalizedDocument({
        document,
        ids: { nextUnitId: () => "invalid" },
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "invalid_unit_id",
      }),
    );
  });

  it("meets the lexical boundary quality gate on the labeled fixture", () => {
    const document = topicShiftDocument();
    const units = segmentNormalizedDocument({
      document,
      ids: sequentialUnitIds(),
    });
    const predicted = lexicalBoundaryOrders(document, units);
    const metrics = evaluateBoundaries([3, 6], predicted, document.blocks.length);

    expect(metrics).toMatchObject({ pk: 0, windowDiff: 0 });
    expect(metrics.precision).toBeGreaterThanOrEqual(0.75);
    expect(metrics.recall).toBeGreaterThanOrEqual(0.8);
    expect(metrics.f1).toBeGreaterThanOrEqual(0.75);
  });
});

function topicShiftDocument() {
  const topics = [
    ["payment", "retry", "invoice", "failure"],
    ["deploy", "release", "cluster", "rollback"],
    ["account", "login", "session", "password"],
  ] as const;
  return createSegmentationDocument(
    topics.flatMap((terms) =>
      Array.from({ length: 3 }, () => ({
        kind: "paragraph" as const,
        text: repeatedTopic(terms),
      })),
    ),
  );
}

function lexicalBoundaryOrders(
  document: ReturnType<typeof createSegmentationDocument>,
  units: ReturnType<typeof segmentNormalizedDocument>,
): readonly number[] {
  return units
    .filter((unit) => unit.boundary.kind === "lexical")
    .map((unit) =>
      document.blocks.find((block) => block.id === unit.blockIds[0])?.order,
    )
    .filter((order): order is number => order !== undefined && order > 0);
}

function sequentialUnitIds(): SemanticUnitIdSource {
  let sequence = 0;
  return {
    nextUnitId: () => {
      sequence += 1;
      return `unit_${sequence.toString().padStart(4, "0")}`;
    },
  };
}
