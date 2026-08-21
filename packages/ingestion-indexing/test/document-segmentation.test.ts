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
import { structuralId } from "./fixtures/root-id-fixture.js";

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
    expect(root?.blockIds).toEqual(["blk_01890f5c-7b1a-75d9-8fea-f267cc8ba8ad"]);
    expect(payments).toMatchObject({
      parentId: root?.id,
      blockIds: ["blk_01890f5c-7b1a-7b3a-85b7-a9cc87b36bea", "blk_01890f5c-7b1a-71b4-819d-86052dbd208e"],
      boundary: { kind: "explicit_heading" },
    });
    expect(retries).toMatchObject({
      parentId: payments?.id,
      blockIds: ["blk_01890f5c-7b1a-7e93-8105-2e02ca1e5930", "blk_01890f5c-7b1a-7a78-8504-16aef15e3c80"],
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
      ["blk_01890f5c-7b1a-75d9-8fea-f267cc8ba8ad", "blk_01890f5c-7b1a-7b3a-85b7-a9cc87b36bea", "blk_01890f5c-7b1a-71b4-819d-86052dbd208e"],
      ["blk_01890f5c-7b1a-7e93-8105-2e02ca1e5930", "blk_01890f5c-7b1a-7a78-8504-16aef15e3c80", "blk_01890f5c-7b1a-71b5-81be-aff12a892cc8"],
      ["blk_01890f5c-7b1a-7127-89be-9a177f5805f9", "blk_01890f5c-7b1a-7171-8196-1028e1ec84d8", "blk_01890f5c-7b1a-76d4-8a2b-fc1fc4994876"],
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

    expect(segment?.blockIds).toEqual(["blk_01890f5c-7b1a-75d9-8fea-f267cc8ba8ad"]);
    expect(segment?.boundary.kind).toBe("size_fallback");
    expect(segment?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "oversized_atomic_block",
          blockIds: ["blk_01890f5c-7b1a-75d9-8fea-f267cc8ba8ad"],
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

  it.each([
    {
      name: "three abrupt topics",
      document: topicShiftDocument(),
      expectedBoundaries: [3, 6],
    },
    {
      name: "one homogeneous topic",
      document: createSegmentationDocument(
        Array.from({ length: 4 }, () => ({
          kind: "paragraph" as const,
          text: repeatedTopic(["payment", "retry", "invoice", "failure"]),
        })),
      ),
      expectedBoundaries: [],
    },
  ])(
    "reports every boundary metric for $name",
    ({ document, expectedBoundaries }) => {
      const units = segmentNormalizedDocument({
        document,
        ids: sequentialUnitIds(),
      });
      const predicted = lexicalBoundaryOrders(document, units);

      expect(
        evaluateBoundaries(
          expectedBoundaries,
          predicted,
          document.blocks.length,
        ),
      ).toEqual({
        precision: 1,
        recall: 1,
        f1: 1,
        pk: 0,
        windowDiff: 0,
      });
    },
  );

  it("distinguishes Pk from WindowDiff when a prediction adds a boundary", () => {
    expect(evaluateBoundaries([4], [3, 4], 8)).toEqual({
      precision: 0.5,
      recall: 1,
      f1: 2 / 3,
      pk: 1 / 6,
      windowDiff: 2 / 6,
    });
  });

  it.each([
    { expected: [0], predicted: [], blockCount: 4 },
    { expected: [2, 2], predicted: [], blockCount: 4 },
    { expected: [], predicted: [4], blockCount: 4 },
    { expected: [], predicted: [], blockCount: 0 },
  ])("rejects malformed boundary fixture %#", (fixture) => {
    expect(() =>
      evaluateBoundaries(
        fixture.expected,
        fixture.predicted,
        fixture.blockCount,
      ),
    ).toThrow(RangeError);
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
      return structuralId("unit", sequence.toString().padStart(4, "0"));
    },
  };
}
