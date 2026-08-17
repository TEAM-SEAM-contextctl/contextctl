import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  MarkdownCapture,
  RemarkMarkdownParser,
  sha256Digest,
  type BlockIdSource,
  type CandidateDocument,
  type MarkdownDocumentParser,
  type MarkdownSourceSnapshot,
  type NormalizedDocument,
} from "../src/index.js";

const STRUCTURE_FIXTURE = fileURLToPath(
  new URL("./fixtures/markdown/structure.md", import.meta.url),
);
const UNSUPPORTED_FIXTURE = fileURLToPath(
  new URL("./fixtures/markdown/unsupported.md", import.meta.url),
);

describe("Markdown capture", () => {
  it("translates supported Markdown structure without leaking parser types", async () => {
    const source = await readFile(STRUCTURE_FIXTURE, "utf8");
    const document = capture(source);

    expect(document.title).toBe("결제 운영");
    expect(document.completeness).toEqual({
      status: "complete",
      diagnostics: [],
    });
    expect(document.blocks.map((block) => block.kind)).toEqual([
      "heading",
      "paragraph",
      "heading",
      "heading",
      "list_item",
      "list_item",
      "list_item",
      "heading",
      "heading",
      "table",
      "code",
      "quote",
      "divider",
    ]);
    expect(document.blocks.map((block) => block.text)).toEqual([
      "결제 운영",
      "운영 문서는 결제 실패를 다룹니다.",
      "재시도",
      "재시도",
      "결제 상태를 확인합니다.",
      "중복 요청을 차단합니다.",
      "재시도를 실행합니다.",
      "빈 섹션",
      "응답 코드",
      "| 코드 | 의미 |\n| 409 | 이미 처리됨 |\n| 503 | 일시적 장애 |",
      "const retryable = status === 503;",
      "승인되지 않은 수동 재시도는 금지합니다.",
      "",
    ]);
    expect(
      document.blocks
        .filter((block) => block.kind === "heading")
        .map((block) => ({
          text: block.text,
          level: block.structure.level,
          sectionDepth: block.sectionPath.length,
        })),
    ).toEqual([
      { text: "결제 운영", level: 1, sectionDepth: 1 },
      { text: "재시도", level: 2, sectionDepth: 2 },
      { text: "재시도", level: 3, sectionDepth: 3 },
      { text: "빈 섹션", level: 2, sectionDepth: 2 },
      { text: "응답 코드", level: 2, sectionDepth: 2 },
    ]);
    expect(document.blocks.filter((block) => block.kind === "list_item")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "중복 요청을 차단합니다.",
          structure: { kind: "list_item", ordered: false, depth: 1 },
        }),
      ]),
    );
    expect(document.blocks.find((block) => block.kind === "table")).toMatchObject({
      text: "| 코드 | 의미 |\n| 409 | 이미 처리됨 |\n| 503 | 일시적 장애 |",
      structure: {
        kind: "table",
        headerRows: 1,
        cells: [
          ["코드", "의미"],
          ["409", "이미 처리됨"],
          ["503", "일시적 장애"],
        ],
      },
    });
    expect(document.blocks.find((block) => block.kind === "code")).toMatchObject({
      text: "const retryable = status === 503;",
      structure: { kind: "code", language: "ts" },
    });

    for (const block of document.blocks) {
      expect(block).not.toHaveProperty("position");
      expect(block).not.toHaveProperty("children");
      expect(block.sourceSpan.kind).toBe("text");
      if (block.sourceSpan.kind === "text") {
        expect(block.sourceSpan.endOffset).toBeLessThanOrEqual(source.length);
        expect(source.slice(block.sourceSpan.startOffset, block.sourceSpan.endOffset))
          .not.toBe("");
      }
      expect(block.analysisText).toBe(
        block.text.normalize("NFKC").toLocaleLowerCase("und").replaceAll(/\s+/g, " ").trim(),
      );
    }
  });

  it("keeps unsupported input as bounded partial output with source coordinates", async () => {
    const source = await readFile(UNSUPPORTED_FIXTURE, "utf8");
    const document = capture(source);

    expect(document.completeness.status).toBe("partial");
    expect(document.completeness.diagnostics).toEqual([
      expect.objectContaining({
        code: "unsupported_markdown_node",
        severity: "warning",
        detail: "Markdown node was preserved as text: html",
      }),
    ]);
    expect(document.blocks.at(-1)).toMatchObject({
      kind: "paragraph",
      text: expect.stringContaining("obviously-fake-sensitive-content"),
    });
    expect(JSON.stringify(document.completeness.diagnostics)).not.toContain(
      "obviously-fake-sensitive-content",
    );
    expect(JSON.stringify(document.completeness.diagnostics).length).toBeLessThan(512);
  });

  it("accounts for an omitted link definition with a bounded diagnostic", () => {
    const document = capture(
      "# References\n\nUse [payments][payments].\n\n[payments]: https://example.test/payments\n",
    );

    expect(document.completeness).toEqual({
      status: "partial",
      diagnostics: [
        expect.objectContaining({
          code: "definition_not_indexed",
          severity: "warning",
          sourceSpan: expect.objectContaining({ kind: "text" }),
        }),
      ],
    });
    expect(document.blocks.map((block) => block.text)).toEqual([
      "References",
      "Use payments.",
    ]);
  });

  it("keeps IDs and revisions stable across insertion, section movement and unambiguous edits", () => {
    const initial = capture(`# A

Alpha payment retry policy remains stable across all normal production operations without operator intervention.

# B

Beta settlement policy remains stable.
`);
    const changed = capture(
      `Introductory note.

# B

Beta settlement policy remains stable.

# A renamed

Alpha payment retry policy remains stable across all normal production operations without audited operator intervention.
`,
      initial,
      "obs_changed",
    );
    const initialByText = new Map(initial.blocks.map((block) => [block.text, block]));
    const changedByText = new Map(changed.blocks.map((block) => [block.text, block]));

    expect(changedByText.get("Beta settlement policy remains stable.")?.id).toBe(
      initialByText.get("Beta settlement policy remains stable.")?.id,
    );
    expect(changedByText.get("B")?.id).toBe(initialByText.get("B")?.id);
    expect(changedByText.get("A renamed")?.id).toBe(initialByText.get("A")?.id);
    expect(
      changedByText.get(
        "Alpha payment retry policy remains stable across all normal production operations without audited operator intervention.",
      )?.id,
    ).toBe(
      initialByText.get(
        "Alpha payment retry policy remains stable across all normal production operations without operator intervention.",
      )?.id,
    );
    expect(changed.contentDigest).not.toBe(initial.contentDigest);

    // A leading insertion moved "B" and shifted every following offset, but its
    // content and containment are untouched, so the revision must survive.
    expect(changedByText.get("B")?.revisionId).toBe(
      initialByText.get("B")?.revisionId,
    );
    expect(
      changedByText.get("Beta settlement policy remains stable.")?.revisionId,
    ).toBe(
      initialByText.get("Beta settlement policy remains stable.")?.revisionId,
    );
    // Only genuinely edited Blocks advance their revision.
    expect(changedByText.get("A renamed")?.revisionId).not.toBe(
      initialByText.get("A")?.revisionId,
    );
    expect(
      changedByText.get(
        "Alpha payment retry policy remains stable across all normal production operations without audited operator intervention.",
      )?.revisionId,
    ).not.toBe(
      initialByText.get(
        "Alpha payment retry policy remains stable across all normal production operations without operator intervention.",
      )?.revisionId,
    );
  });

  it("does not associate ambiguous duplicate paragraphs", () => {
    const initial = capture(`# A

Repeated policy.

# B

Repeated policy.
`);
    const changed = capture(
      `# C

Repeated policy.

# D

Repeated policy.
`,
      initial,
      "obs_changed",
    );
    const oldDuplicateIds = new Set(
      initial.blocks
        .filter((block) => block.text === "Repeated policy.")
        .map((block) => block.id),
    );
    const newDuplicateIds = changed.blocks
      .filter((block) => block.text === "Repeated policy.")
      .map((block) => block.id);

    expect(newDuplicateIds).toHaveLength(2);
    expect(newDuplicateIds.every((id) => !oldDuplicateIds.has(id))).toBe(true);
  });

  it("uses normalized sequence identity without crossing reordered content", () => {
    const initial = capture(`# Stable

First   VALUE.

Second VALUE.
`);
    const changed = capture(
      `# Stable

first value.

second value.
`,
      initial,
      "obs_changed",
    );

    expect(changed.blocks.map((block) => block.id)).toEqual(
      initial.blocks.map((block) => block.id),
    );
  });

  it("rejects a fuzzy identity when two candidates tie for one previous block", () => {
    const initial = capture(`# Stable

Payment retry policy remains stable across normal production operations and audits.
`);
    const oldParagraphId = initial.blocks.at(-1)?.id;
    const changed = capture(
      `# Stable

Payment retry policy remains stable across normal production operations and reviews.

Payment retry policy remains stable across normal production operations and reports.
`,
      initial,
      "obs_changed",
    );
    const changedParagraphIds = changed.blocks
      .filter((block) => block.kind === "paragraph")
      .map((block) => block.id);

    expect(oldParagraphId).toBeDefined();
    expect(changedParagraphIds).toHaveLength(2);
    expect(changedParagraphIds).not.toContain(oldParagraphId);
  });

  it("produces the same digest and inherited identities for the same lineage input", () => {
    const source = "# Stable\n\nCanonical content.\n";
    const initial = capture(source);
    const replayA = capture(source, initial, "obs_replaya");
    const replayB = capture(source, initial, "obs_replayb");

    expect(replayA.contentDigest).toBe(replayB.contentDigest);
    expect(replayA.blocks.map((block) => block.id)).toEqual(
      replayB.blocks.map((block) => block.id),
    );
    expect(replayA.blocks.map((block) => block.revisionId)).toEqual(
      replayB.blocks.map((block) => block.revisionId),
    );
  });

  it("captures a large block without truncation", () => {
    const text = "large-block ".repeat(20_000).trim();
    const document = capture(`# Large\n\n${text}\n`);

    expect(document.blocks.at(-1)?.text).toBe(text);
    expect(document.blocks.at(-1)?.sourceSpan).toMatchObject({
      kind: "text",
      startOffset: 9,
      endOffset: 9 + text.length,
    });
  });

  it("preserves an empty fenced code block as structure", () => {
    const document = capture("# Empty code\n\n```text\n```\n");

    expect(document.blocks.at(-1)).toMatchObject({
      kind: "code",
      text: "",
      analysisText: "",
      structure: { kind: "code", language: "text" },
    });
  });

  it("rejects a snapshot whose digest does not match its content", () => {
    const captureService = createCapture();
    const snapshot = snapshotOf("# Safe\n");

    expect(() =>
      captureService.capture({
        source: sourceIdentity(),
        observationId: "obs_initial",
        documentId: "doc_markdown",
        snapshot: { ...snapshot, contentDigest: `sha256:${"0".repeat(64)}` },
      }),
    ).toThrow(
      expect.objectContaining({
        code: "invalid_candidate",
        message: "Document capture failed: invalid_candidate",
      }),
    );
  });

  it.each([
    {
      name: "non-canonical content",
      snapshot: snapshotOf("# Safe\r\n"),
      mutate: (snapshot: MarkdownSourceSnapshot) => ({
        ...snapshot,
        content: "# Safe\r\n",
        contentDigest: sha256Digest("# Safe\r\n"),
      }),
    },
    {
      name: "invalid capture timestamp",
      snapshot: snapshotOf("# Safe\n"),
      mutate: (snapshot: MarkdownSourceSnapshot) => ({
        ...snapshot,
        capturedAt: "not-an-instant",
      }),
    },
  ])("rejects a snapshot with $name", ({ snapshot, mutate }) => {
    const captureService = createCapture();

    expect(() =>
      captureService.capture({
        source: sourceIdentity(),
        observationId: "obs_initial",
        documentId: "doc_markdown",
        snapshot: mutate(snapshot),
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_candidate" }));
  });

  it("rejects a snapshot captured from a different Source target", () => {
    const captureService = createCapture();
    const command = {
      source: { id: "src_markdown", targetKey: "file:expected" },
      observationId: "obs_initial",
      documentId: "doc_markdown",
      snapshot: {
        ...snapshotOf("# Safe\n"),
        targetKey: "file:other",
      },
    };

    expect(() => captureService.capture(command)).toThrow(
      expect.objectContaining({ code: "invalid_candidate" }),
    );
  });

  it("rejects a non-heading block that references itself as a section", () => {
    const parser: MarkdownDocumentParser = {
      id: "invalid-section-parser",
      version: "1.0.0",
      parse(): CandidateDocument {
        return {
          completeness: "complete",
          diagnostics: [],
          coverage: [
            {
              status: "accepted",
              sourceSpan: {
                kind: "text",
                startOffset: 0,
                endOffset: 4,
                startLine: 1,
                endLine: 1,
              },
            },
          ],
          blocks: [
            {
              kind: "paragraph",
              sectionPath: [0],
              text: "body",
              sourceSpan: {
                kind: "text",
                startOffset: 0,
                endOffset: 4,
                startLine: 1,
                endLine: 1,
              },
              structure: { kind: "paragraph" },
            },
          ],
        };
      },
    };

    expect(() =>
      new MarkdownCapture({
        parser,
        ids: new SequentialBlockIdSource(),
      }).capture({
        source: sourceIdentity(),
        observationId: "obs_initial",
        documentId: "doc_markdown",
        snapshot: snapshotOf("body"),
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_candidate" }));
  });

  it("rejects parser output that silently leaves source text unaccounted for", () => {
    const parser: MarkdownDocumentParser = {
      id: "incomplete-parser",
      version: "1.0.0",
      parse(): CandidateDocument {
        return {
          completeness: "complete",
          diagnostics: [],
          coverage: [
            {
              status: "accepted",
              sourceSpan: {
                kind: "text",
                startOffset: 0,
                endOffset: 4,
                startLine: 1,
                endLine: 1,
              },
            },
          ],
          blocks: [
            {
              kind: "paragraph",
              sectionPath: [],
              text: "kept",
              sourceSpan: {
                kind: "text",
                startOffset: 0,
                endOffset: 4,
                startLine: 1,
                endLine: 1,
              },
              structure: { kind: "paragraph" },
            },
          ],
        };
      },
    };

    expect(() =>
      new MarkdownCapture({
        parser,
        ids: new SequentialBlockIdSource(),
      }).capture({
        source: sourceIdentity(),
        observationId: "obs_initial",
        documentId: "doc_markdown",
        snapshot: snapshotOf("kept\n\nsilently omitted"),
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_candidate" }));
  });

  it("rejects parser output whose source coordinates escape the canonical document", () => {
    const parser: MarkdownDocumentParser = {
      id: "invalid-parser",
      version: "1.0.0",
      parse(): CandidateDocument {
        return {
          completeness: "complete",
          diagnostics: [],
          coverage: [
            {
              status: "accepted",
              sourceSpan: {
                kind: "text",
                startOffset: 0,
                endOffset: 5,
                startLine: 1,
                endLine: 1,
              },
            },
          ],
          blocks: [
            {
              kind: "paragraph",
              sectionPath: [],
              text: "outside",
              sourceSpan: {
                kind: "text",
                startOffset: 0,
                endOffset: 100,
                startLine: 1,
                endLine: 1,
              },
              structure: { kind: "paragraph" },
            },
          ],
        };
      },
    };
    const captureService = new MarkdownCapture({
      parser,
      ids: new SequentialBlockIdSource(),
    });

    expect(() =>
      captureService.capture({
        source: sourceIdentity(),
        observationId: "obs_initial",
        documentId: "doc_markdown",
        snapshot: snapshotOf("short"),
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_candidate" }));
  });
});

function capture(
  source: string,
  previousDocument?: NormalizedDocument,
  observationId = "obs_initial",
): NormalizedDocument {
  const captureService = createCapture();
  return captureService.capture({
    source: sourceIdentity(),
    observationId,
    documentId: "doc_markdown",
    snapshot: snapshotOf(source),
    ...(previousDocument === undefined ? {} : { previousDocument }),
  });
}

function createCapture(): MarkdownCapture {
  return new MarkdownCapture({
    parser: new RemarkMarkdownParser(),
    ids: new SequentialBlockIdSource(),
  });
}

function sourceIdentity(): { readonly id: string; readonly targetKey: string } {
  return { id: "src_markdown", targetKey: "file:/fixture.md" };
}

function snapshotOf(content: string): MarkdownSourceSnapshot {
  return {
    kind: "markdown",
    targetKey: "file:/fixture.md",
    capturedAt: "2026-07-31T00:00:00.000Z",
    content,
    contentDigest: sha256Digest(content),
  };
}

class SequentialBlockIdSource implements BlockIdSource {
  #next = 1;

  nextBlockId(): string {
    return `blk_test${this.#next++}`;
  }
}
