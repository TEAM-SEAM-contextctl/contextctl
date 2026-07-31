import type {
  Blockquote,
  Code,
  Heading,
  List,
  ListItem,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
  Table,
  ThematicBreak,
} from "mdast";
import { toString as mdastText } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { Node } from "unist";

import {
  DocumentCaptureError,
  type CandidateDocument,
  type CandidateDocumentBlock,
  type CandidateSourceCoverage,
} from "../domain/document-capture.js";
import type {
  BlockStructure,
  ParserDiagnostic,
  TextSourceSpan,
} from "../domain/document-model.js";
import type { MarkdownDocumentParser } from "../ports/document-capture.js";

export class RemarkMarkdownParser implements MarkdownDocumentParser {
  readonly id = "remark-parse";
  readonly version = "11.0.0+gfm-4.0.1";

  parse(source: string): CandidateDocument {
    let root: Root;
    try {
      root = unified().use(remarkParse).use(remarkGfm).parse(source);
    } catch {
      throw new DocumentCaptureError("unsupported_document", [
        {
          code: "markdown_parse_failed",
          severity: "error",
          detail: "Markdown could not be parsed",
        },
      ]);
    }
    const builder = new CandidateBuilder(source);
    for (const node of root.children) {
      builder.visitRoot(node);
    }
    return builder.build();
  }
}

class CandidateBuilder {
  readonly #source: string;
  readonly #blocks: CandidateDocumentBlock[] = [];
  readonly #diagnostics: ParserDiagnostic[] = [];
  readonly #coverage: CandidateSourceCoverage[] = [];
  readonly #headingStack: Array<{ level: number; index: number }> = [];
  #title: string | undefined;

  constructor(source: string) {
    this.#source = source;
  }

  visitRoot(node: RootContent): void {
    const blockCount = this.#blocks.length;
    const diagnosticCount = this.#diagnostics.length;
    this.#visitRootNode(node);
    const span = sourceSpan(node);
    if (this.#blocks.length > blockCount) {
      this.#coverage.push({ status: "accepted", sourceSpan: span });
      return;
    }
    const diagnostic = this.#diagnostics[diagnosticCount];
    if (diagnostic !== undefined) {
      this.#coverage.push({
        status: "omitted",
        sourceSpan: span,
        diagnosticCode: diagnostic.code,
      });
      return;
    }
    throw new DocumentCaptureError("invalid_candidate");
  }

  #visitRootNode(node: RootContent): void {
    switch (node.type) {
      case "heading":
        this.#heading(node);
        return;
      case "paragraph":
        this.#paragraph(node);
        return;
      case "list":
        this.#list(node, 0);
        return;
      case "table":
        this.#table(node);
        return;
      case "code":
        this.#code(node);
        return;
      case "blockquote":
        this.#quote(node);
        return;
      case "thematicBreak":
        this.#divider(node);
        return;
      case "html":
        this.#unsupportedAsText(node);
        return;
      case "definition":
        this.#diagnostic(
          "definition_not_indexed",
          "Link definition was preserved only through references",
          node,
        );
        return;
      default:
        this.#unsupportedAsText(node);
    }
  }

  build(): CandidateDocument {
    return {
      ...(this.#title === undefined ? {} : { title: this.#title }),
      completeness: this.#diagnostics.length === 0 ? "complete" : "partial",
      diagnostics: this.#diagnostics,
      coverage: this.#coverage,
      blocks: this.#blocks,
    };
  }

  #heading(node: Heading): void {
    const text = inlineText(node.children);
    while (
      this.#headingStack.at(-1) !== undefined &&
      requiredLast(this.#headingStack).level >= node.depth
    ) {
      this.#headingStack.pop();
    }
    const index = this.#blocks.length;
    const sectionPath = [
      ...this.#headingStack.map((heading) => heading.index),
      index,
    ];
    this.#push({
      kind: "heading",
      sectionPath,
      text,
      sourceSpan: sourceSpan(node),
      structure: { kind: "heading", level: node.depth },
    });
    this.#headingStack.push({ level: node.depth, index });
    if (this.#title === undefined && node.depth === 1) {
      this.#title = text;
    }
  }

  #paragraph(node: Paragraph, parentIndex?: number): number {
    return this.#push({
      kind: "paragraph",
      ...(parentIndex === undefined ? {} : { parentIndex }),
      sectionPath: this.#sectionPath(),
      text: inlineText(node.children),
      sourceSpan: sourceSpan(node),
      structure: { kind: "paragraph" },
    });
  }

  #list(node: List, depth: number, parentIndex?: number): void {
    for (const item of node.children) {
      this.#listItem(item, node.ordered === true, depth, parentIndex);
    }
  }

  #listItem(
    item: ListItem,
    ordered: boolean,
    depth: number,
    parentIndex?: number,
  ): void {
    let ownIndex: number | undefined;
    for (const child of item.children) {
      if (child.type === "paragraph") {
        const effectiveParent = ownIndex ?? parentIndex;
        const index = this.#push({
          kind: "list_item",
          ...(effectiveParent === undefined
            ? {}
            : { parentIndex: effectiveParent }),
          sectionPath: this.#sectionPath(),
          text: inlineText(child.children),
          sourceSpan: sourceSpan(child),
          structure: { kind: "list_item", ordered, depth },
        });
        ownIndex ??= index;
        continue;
      }
      if (child.type === "list") {
        this.#list(child, depth + 1, ownIndex ?? parentIndex);
        continue;
      }
      if (child.type === "code") {
        ownIndex ??= this.#code(child, parentIndex);
        continue;
      }
      if (child.type === "blockquote") {
        ownIndex ??= this.#quote(child, parentIndex);
        continue;
      }
      this.#unsupportedAsText(child, ownIndex ?? parentIndex);
    }
  }

  #table(node: Table, parentIndex?: number): number {
    const cells = node.children.map((row) =>
      row.children.map((cell) => inlineText(cell.children)),
    );
    const text = cells
      .map((row) => `| ${row.join(" | ")} |`)
      .join("\n");
    return this.#push({
      kind: "table",
      ...(parentIndex === undefined ? {} : { parentIndex }),
      sectionPath: this.#sectionPath(),
      text,
      sourceSpan: sourceSpan(node),
      structure: { kind: "table", headerRows: cells.length === 0 ? 0 : 1, cells },
    });
  }

  #code(node: Code, parentIndex?: number): number {
    const structure: BlockStructure =
      node.lang === null || node.lang === undefined || node.lang.length === 0
        ? { kind: "code" }
        : { kind: "code", language: node.lang };
    return this.#push({
      kind: "code",
      ...(parentIndex === undefined ? {} : { parentIndex }),
      sectionPath: this.#sectionPath(),
      text: node.value,
      sourceSpan: sourceSpan(node),
      structure,
    });
  }

  #quote(node: Blockquote, parentIndex?: number): number {
    return this.#push({
      kind: "quote",
      ...(parentIndex === undefined ? {} : { parentIndex }),
      sectionPath: this.#sectionPath(),
      text: mdastText(node),
      sourceSpan: sourceSpan(node),
      structure: { kind: "quote", depth: 1 },
    });
  }

  #divider(node: ThematicBreak, parentIndex?: number): number {
    return this.#push({
      kind: "divider",
      ...(parentIndex === undefined ? {} : { parentIndex }),
      sectionPath: this.#sectionPath(),
      text: "",
      sourceSpan: sourceSpan(node),
      structure: { kind: "divider" },
    });
  }

  #unsupportedAsText(
    node: Node,
    parentIndex?: number,
  ): number {
    const span = sourceSpan(node);
    const raw = this.#source.slice(span.startOffset, span.endOffset);
    this.#diagnostic(
      "unsupported_markdown_node",
      `Markdown node was preserved as text: ${node.type}`,
      node,
    );
    return this.#push({
      kind: "paragraph",
      ...(parentIndex === undefined ? {} : { parentIndex }),
      sectionPath: this.#sectionPath(),
      text: raw,
      sourceSpan: span,
      structure: { kind: "paragraph" },
    });
  }

  #diagnostic(
    code: string,
    detail: string,
    node: Node,
  ): void {
    this.#diagnostics.push({
      code,
      severity: "warning",
      sourceSpan: sourceSpan(node),
      detail,
    });
  }

  #sectionPath(): readonly number[] {
    return this.#headingStack.map((heading) => heading.index);
  }

  #push(block: CandidateDocumentBlock): number {
    const index = this.#blocks.length;
    this.#blocks.push(block);
    return index;
  }
}

function sourceSpan(node: Node): TextSourceSpan {
  const startOffset = node.position?.start.offset;
  const endOffset = node.position?.end.offset;
  if (
    startOffset === undefined ||
    endOffset === undefined ||
    endOffset < startOffset
  ) {
    throw new DocumentCaptureError("unsupported_document", [
      {
        code: "markdown_position_unavailable",
        severity: "error",
        detail: "Markdown parser did not provide source coordinates",
      },
    ]);
  }
  return {
    kind: "text",
    startOffset,
    endOffset,
    startLine: node.position?.start.line ?? 1,
    endLine: node.position?.end.line ?? 1,
  };
}

function inlineText(children: readonly PhrasingContent[]): string {
  return children.map((child) => phrasingText(child)).join("");
}

function phrasingText(node: PhrasingContent): string {
  switch (node.type) {
    case "text":
    case "inlineCode":
      return node.value;
    case "break":
      return "\n";
    case "image":
    case "imageReference":
      return node.alt ?? "";
    case "footnoteReference":
      return node.label ?? node.identifier;
    default:
      return "children" in node ? inlineText(node.children) : literalValue(node);
  }
}

function literalValue(node: PhrasingContent): string {
  return "value" in node && typeof node.value === "string" ? node.value : "";
}

function requiredLast<T>(values: readonly T[]): T {
  const value = values.at(-1);
  if (value === undefined) {
    throw new DocumentCaptureError("invalid_candidate");
  }
  return value;
}
