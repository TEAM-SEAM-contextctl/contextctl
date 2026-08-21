import { describe, expect, it } from "vitest";

import {
  generateManagedChunks,
  LINEAGE_POLICY_VERSION,
  MarkdownCapture,
  measureText,
  RemarkMarkdownParser,
  segmentNormalizedDocument,
  sha256Digest,
  toAnalysisText,
  type BlockIdSource,
  type DocumentBlock,
  type DocumentSemanticUnit,
  type ManagedChunk,
  type ManagedChunkIdSource,
  type NormalizedDocument,
  type SemanticUnitIdSource,
} from "../src/index.js";
import { validateManagedChunks } from "../src/domain/document-model.js";
import { structuralId } from "./fixtures/root-id-fixture.js";

describe("Managed Chunk generation", () => {
  it("packs whole Blocks and overlaps only bounded adjacent Blocks", () => {
    const fixture = createFixture([
      { kind: "paragraph", text: words(280, "alpha") },
      { kind: "paragraph", text: words(40, "bridge") },
      { kind: "paragraph", text: words(100, "omega") },
    ]);

    const chunks = generate(fixture);

    expect(chunks).toHaveLength(2);
    expect(chunks.map((chunk) => chunk.sourceSlices.map((slice) => slice.blockId)))
      .toEqual([
        ["blk_01890f5c-7b1a-75d9-8fea-f267cc8ba8ad", "blk_01890f5c-7b1a-7b3a-85b7-a9cc87b36bea"],
        ["blk_01890f5c-7b1a-7b3a-85b7-a9cc87b36bea", "blk_01890f5c-7b1a-71b4-819d-86052dbd208e"],
      ]);
    expect(chunks.every((chunk) => chunk.tokenCount <= 480)).toBe(true);
    expect(chunks[1]?.tokenCount).toBe(140);
    expect(validateManagedChunks(fixture.document, fixture.units, chunks)).toEqual(
      [],
    );
  });

  it("splits oversized paragraphs at sentence boundaries without losing text", () => {
    const text = `${words(190, "first")}. ${words(190, "second")}. ${words(190, "third")}.`;
    const fixture = createFixture([{ kind: "paragraph", text }]);

    const chunks = generate(fixture);

    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.splitKind === "sentence")).toBe(true);
    expect(chunks.every((chunk) => chunk.tokenCount <= 480)).toBe(true);
    expect(reconstructUniqueBlockText(chunks, "blk_01890f5c-7b1a-75d9-8fea-f267cc8ba8ad", text)).toBe(text);
  });

  it("splits oversized code at complete line boundaries", () => {
    const text = [
      words(180, "const"),
      words(180, "return"),
      words(180, "throw"),
    ].join("\n");
    const fixture = createFixture([{ kind: "code", text }]);

    const chunks = generate(fixture);

    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.splitKind === "line")).toBe(true);
    expect(reconstructUniqueBlockText(chunks, "blk_01890f5c-7b1a-75d9-8fea-f267cc8ba8ad", text)).toBe(text);
  });

  it("repeats a bounded table header while splitting complete rows", () => {
    const header = "| code | meaning |\n";
    const rows = [
      `| 409 | ${words(180, "duplicate")} |\n`,
      `| 503 | ${words(180, "retryable")} |\n`,
      `| 504 | ${words(180, "timeout")} |`,
    ];
    const text = header + rows.join("");
    const fixture = createFixture([
      {
        kind: "table",
        text,
        cells: [
          ["code", "meaning"],
          ["409", "duplicate"],
          ["503", "retryable"],
          ["504", "timeout"],
        ],
      },
    ]);

    const chunks = generate(fixture);

    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.splitKind === "table_row")).toBe(true);
    expect(chunks.every((chunk) => chunk.text.startsWith(header))).toBe(true);
    expect(chunks.every((chunk) => chunk.tokenCount <= 480)).toBe(true);
    expect(reconstructUniqueBlockText(chunks, "blk_01890f5c-7b1a-75d9-8fea-f267cc8ba8ad", text)).toBe(text);
  });

  it("uses lossless token windows when no structural boundary can fit", () => {
    const text = words(1_050, "unbroken");
    const fixture = createFixture([{ kind: "list_item", text }]);

    const chunks = generate(fixture);

    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => chunk.splitKind === "token_window")).toBe(
      true,
    );
    expect(chunks.every((chunk) => chunk.tokenCount <= 480)).toBe(true);
    expect(reconstructUniqueBlockText(chunks, "blk_01890f5c-7b1a-75d9-8fea-f267cc8ba8ad", text)).toBe(text);
  });

  it("keeps deterministic content and revision identities across observations", () => {
    const initial = createFixture([
      { kind: "paragraph", text: words(360, "stable") },
    ]);
    const observedAgain = {
      document: { ...initial.document, observationId: "obs_again" },
      units: initial.units.map((unit) => ({
        ...unit,
        observationId: "obs_again",
      })),
    };

    const first = generate(initial);
    const second = generate(observedAgain);

    expect(second.map(stableChunkShape)).toEqual(first.map(stableChunkShape));
    expect(second.every((chunk) => chunk.observationId === "obs_again")).toBe(
      true,
    );
  });

  it("changes the immutable revision for the same allocated logical ID", () => {
    const initial = createFixture([
      { kind: "paragraph", text: words(100, "stable") },
    ]);
    const initialBlock = initial.document.blocks[0];
    const initialUnit = initial.units[0];
    expect(initialBlock).toBeDefined();
    expect(initialUnit).toBeDefined();
    if (initialBlock === undefined || initialUnit === undefined) {
      return;
    }
    const changedText = `${initialBlock.text.slice(0, -4)}edit`;
    const changedDocument = {
      ...initial.document,
      observationId: "obs_changed",
      contentDigest: sha256Digest(changedText),
      blocks: [
        {
          ...initialBlock,
          revisionId: "brv_bbbbbbbbbbbbbbbb",
          text: changedText,
          analysisText: toAnalysisText(changedText),
          contentDigest: sha256Digest(changedText),
        },
      ],
    };
    const changedUnits = [
      {
        ...initialUnit,
        observationId: "obs_changed",
        revisionId: "urv_bbbbbbbbbbbbbbbb",
        contentDigest: sha256Digest(changedText),
      },
    ];

    const before = generate(initial)[0];
    const after = generate({ document: changedDocument, units: changedUnits })[0];

    expect(after?.id).toBe(before?.id);
    expect(after?.revisionId).not.toBe(before?.revisionId);
    expect(after?.contentDigest).not.toBe(before?.contentDigest);
  });

  it("rejects adjacent overlap above the active policy", () => {
    const fixture = createFixture([
      { kind: "paragraph", text: words(280, "first") },
      { kind: "paragraph", text: words(40, "bridge") },
      { kind: "paragraph", text: words(100, "last") },
    ]);
    const chunks = generate(fixture);
    const first = chunks[0];
    const second = chunks[1];
    const firstBlock = fixture.document.blocks[0];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(firstBlock).toBeDefined();
    if (first === undefined || second === undefined || firstBlock === undefined) {
      return;
    }
    const sourceSlices = [
      {
        blockId: firstBlock.id,
        startOffset: 0,
        endOffset: firstBlock.text.length,
        separatorBefore: "" as const,
      },
      ...second.sourceSlices.map((slice) => ({
        ...slice,
        separatorBefore: "\n\n" as const,
      })),
    ];
    const text = `${firstBlock.text}\n\n${second.text}`;
    const excessive = {
      ...second,
      sourceSlices,
      text,
      tokenCount: measureText(text),
      contentDigest: sha256Digest(text),
    };

    expect(
      validateManagedChunks(fixture.document, fixture.units, [first, excessive]),
    ).toContainEqual(
      expect.objectContaining({
        code: "invalid_value",
        message: "adjacent chunk overlap must not exceed the active policy",
      }),
    );
  });

  it("rejects source slices that run backwards inside one Block", () => {
    const text = `${words(190, "first")}. ${words(190, "second")}. ${words(190, "third")}.`;
    const fixture = createFixture([{ kind: "paragraph", text }]);
    const chunks = generate(fixture);
    const first = chunks[0];
    expect(first).toBeDefined();
    if (first === undefined) {
      return;
    }
    const reversed = {
      ...first,
      sourceSlices: [...first.sourceSlices].reverse(),
    };

    expect(
      validateManagedChunks(fixture.document, fixture.units, [
        reversed,
        ...chunks.slice(1),
      ]),
    ).toContainEqual(
      expect.objectContaining({
        code: "invalid_order",
        message: "source slices must follow document and Block offset order",
      }),
    );
  });

  it("does not force non-searchable structural Blocks into empty Chunks", () => {
    const fixture = createFixture([{ kind: "divider", text: "" }]);

    expect(generate(fixture)).toEqual([]);
    expect(validateManagedChunks(fixture.document, fixture.units, [])).toEqual(
      [],
    );
  });

  it("rejects partial documents and malformed allocated IDs", () => {
    const fixture = createFixture([{ kind: "paragraph", text: "Complete." }]);
    const partial = {
      ...fixture,
      document: {
        ...fixture.document,
        completeness: {
          status: "partial" as const,
          diagnostics: [
            { code: "fixture_partial", severity: "warning" as const },
          ],
        },
      },
    };

    expect(() => generate(partial)).toThrowError(
      expect.objectContaining({ code: "incomplete_document" }),
    );
    expect(() =>
      generateManagedChunks({
        ...fixture,
        semanticUnits: fixture.units,
        ids: { nextChunkId: () => "invalid" },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_chunk_id" }));
  });

  it("preserves structure and source coverage through the Markdown pipeline", () => {
    const source = [
      "# Payment operations",
      "",
      "Payment failures require a status check.",
      "",
      "## Retry policy",
      "",
      "Retry only transient failures.",
    ].join("\n");
    const document = captureMarkdown(source);
    const units = segmentNormalizedDocument({
      document,
      ids: sequentialUnitIds(),
    });

    const chunks = generateManagedChunks({
      document,
      semanticUnits: units,
      ids: sequentialChunkIds(),
    });

    expect(chunks.length).toBeGreaterThan(0);
    expect(
      new Set(chunks.map((chunk) => chunk.semanticUnitId)).size,
    ).toBeGreaterThan(1);
    expect(validateManagedChunks(document, units, chunks)).toEqual([]);
    for (const block of document.blocks.filter(
      (candidate) => candidate.text.length > 0,
    )) {
      expect(reconstructUniqueBlockText(chunks, block.id, block.text)).toBe(
        block.text,
      );
    }
  });

  it("rejects duplicate allocated Chunk IDs across Semantic Units", () => {
    const document = captureMarkdown("# First\n\nAlpha.\n\n# Second\n\nBeta.");
    const units = segmentNormalizedDocument({
      document,
      ids: sequentialUnitIds(),
    });

    expect(() =>
      generateManagedChunks({
        document,
        semanticUnits: units,
        ids: { nextChunkId: () => "chk_01890f5c-7b1a-7754-87dd-6681d3b079b5" },
      }),
    ).toThrowError(expect.objectContaining({ code: "duplicate_chunk_id" }));
  });
});

type FixtureBlock =
  | { readonly kind: "paragraph" | "code" | "list_item"; readonly text: string }
  | {
      readonly kind: "table";
      readonly text: string;
      readonly cells: readonly (readonly string[])[];
    }
  | { readonly kind: "divider"; readonly text: "" };

function createFixture(
  specifications: readonly FixtureBlock[],
): { readonly document: NormalizedDocument; readonly units: readonly DocumentSemanticUnit[] } {
  let sourceOffset = 0;
  const blocks: DocumentBlock[] = specifications.map((specification, order) => {
    const id = structuralId("blk", order);
    const common = {
      id,
      revisionId: `brv_${String.fromCharCode(97 + order).repeat(16)}`,
      order,
      sectionPath: [] as readonly string[],
      text: specification.text,
      analysisText: toAnalysisText(specification.text),
      contentDigest: sha256Digest(specification.text),
      sourceSpan: {
        kind: "text" as const,
        startOffset: sourceOffset,
        endOffset: sourceOffset + specification.text.length,
        startLine: order * 2 + 1,
        endLine: order * 2 + 1 + specification.text.split("\n").length - 1,
      },
    };
    sourceOffset += specification.text.length + 2;
    switch (specification.kind) {
      case "paragraph":
        return { ...common, kind: "paragraph", structure: { kind: "paragraph" } };
      case "code":
        return { ...common, kind: "code", structure: { kind: "code" } };
      case "list_item":
        return {
          ...common,
          kind: "list_item",
          structure: { kind: "list_item", ordered: false, depth: 1 },
        };
      case "table":
        return {
          ...common,
          kind: "table",
          structure: { kind: "table", headerRows: 1, cells: specification.cells },
        };
      case "divider":
        return { ...common, kind: "divider", structure: { kind: "divider" } };
    }
  });
  const canonicalText = specifications.map((item) => item.text).join("\n\n");
  const document: NormalizedDocument = {
    schemaVersion: 1,
    documentId: "doc_chunks",
    sourceId: "src_chunks",
    observationId: "obs_chunks",
    mediaType: "text/markdown",
    title: "Chunk fixture",
    parser: { id: "fixture-parser", version: "1.0.0" },
    normalizationPolicyVersion: "document-normalization-v1",
    lineagePolicyVersion: LINEAGE_POLICY_VERSION,
    contentDigest: sha256Digest(canonicalText),
    completeness: { status: "complete", diagnostics: [] },
    blocks,
  };
  const units: readonly DocumentSemanticUnit[] = [
    {
      id: "unit_01890f5c-7b1a-7eb0-8c66-bac8c5b6c444",
      revisionId: "urv_aaaaaaaaaaaaaaaa",
      sourceId: document.sourceId,
      observationId: document.observationId,
      documentId: document.documentId,
      kind: "document",
      title: "Chunk fixture",
      childIds: [],
      blockIds: blocks.map((block) => block.id),
      boundary: { kind: "document_root" },
      contentDigest: document.contentDigest,
      segmentationPolicyVersion: "semantic-unit-v1",
      diagnostics: [],
    },
  ];
  return { document, units };
}

function generate(fixture: {
  readonly document: NormalizedDocument;
  readonly units: readonly DocumentSemanticUnit[];
}): readonly ManagedChunk[] {
  return generateManagedChunks({
    document: fixture.document,
    semanticUnits: fixture.units,
    ids: sequentialChunkIds(),
  });
}

function sequentialChunkIds(): ManagedChunkIdSource {
  let sequence = 0;
  return {
    nextChunkId: () => {
      sequence += 1;
      return structuralId("chk", sequence.toString().padStart(4, "0"));
    },
  };
}

function captureMarkdown(source: string): NormalizedDocument {
  return new MarkdownCapture({
    parser: new RemarkMarkdownParser(),
    ids: sequentialBlockIds(),
  }).capture({
    source: { id: "src_markdown", targetKey: "file:/fixture.md" },
    observationId: "obs_markdown",
    documentId: "doc_markdown",
    snapshot: {
      kind: "markdown",
      targetKey: "file:/fixture.md",
      capturedAt: "2026-08-05T00:00:00.000Z",
      content: source,
      contentDigest: sha256Digest(source),
    },
  });
}

function sequentialBlockIds(): BlockIdSource {
  let sequence = 0;
  return {
    nextBlockId: () => structuralId("blk", `pipeline_${++sequence}`),
  };
}

function sequentialUnitIds(): SemanticUnitIdSource {
  let sequence = 0;
  return {
    nextUnitId: () => structuralId("unit", `pipeline_${++sequence}`),
  };
}

function words(count: number, word: string): string {
  const token = word.slice(0, 4).padEnd(4, "x");
  return Array.from({ length: count }, () => token).join(" ");
}

function reconstructUniqueBlockText(
  chunks: readonly ManagedChunk[],
  blockId: string,
  source: string,
): string {
  const ranges = chunks
    .flatMap((chunk) => chunk.sourceSlices)
    .filter((slice) => slice.blockId === blockId)
    .map((slice) => [slice.startOffset, slice.endOffset] as const)
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const unique: Array<readonly [number, number]> = [];
  for (const range of ranges) {
    const previous = unique.at(-1);
    if (previous?.[0] === range[0] && previous[1] === range[1]) {
      continue;
    }
    unique.push(range);
  }
  return unique.map(([start, end]) => source.slice(start, end)).join("");
}

function stableChunkShape(chunk: ManagedChunk): unknown {
  return {
    id: chunk.id,
    revisionId: chunk.revisionId,
    sourceSlices: chunk.sourceSlices,
    text: chunk.text,
    contentDigest: chunk.contentDigest,
    tokenCount: chunk.tokenCount,
    splitKind: chunk.splitKind,
  };
}

it("keeps the fixture token estimator explicit", () => {
  expect(measureText(words(10, "word"))).toBe(10);
});
