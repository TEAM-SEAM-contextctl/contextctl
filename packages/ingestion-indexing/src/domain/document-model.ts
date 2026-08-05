import { createHash } from "node:crypto";

import {
  DEFAULT_DOCUMENT_INDEXING_POLICY,
  measureText,
  type DocumentIndexingPolicySet,
} from "./document-indexing-policy.js";
import {
  assertNoModelIssues,
  isDigest,
  isId,
  isRevisionId,
  issue,
  type ModelValidationIssue,
} from "./model-validation.js";

export type DocumentMediaType =
  | "text/markdown"
  | "text/plain"
  | "application/pdf";

/**
 * Structure-preserving representation of one observed document. It retains
 * physical source coordinates for lineage while insulating later stages from
 * parser-specific AST shapes.
 */
export interface NormalizedDocument {
  readonly schemaVersion: 1;
  readonly documentId: string;
  readonly sourceId: string;
  readonly observationId: string;
  readonly mediaType: DocumentMediaType;
  readonly title?: string;
  readonly parser: {
    readonly id: string;
    readonly version: string;
  };
  readonly normalizationPolicyVersion: string;
  readonly lineagePolicyVersion: string;
  readonly contentDigest: string;
  readonly completeness: {
    readonly status: "complete" | "partial";
    readonly diagnostics: readonly ParserDiagnostic[];
  };
  readonly blocks: readonly DocumentBlock[];
}

/**
 * Smallest parser-owned structural element. Blocks preserve source order and
 * coordinates; they are ingredients for meaning boundaries, not search scopes.
 */
export type DocumentBlock =
  | BlockBase<"heading", HeadingStructure>
  | BlockBase<"paragraph", ParagraphStructure>
  | BlockBase<"list_item", ListItemStructure>
  | BlockBase<"table", TableStructure>
  | BlockBase<"code", CodeStructure>
  | BlockBase<"quote", QuoteStructure>
  | BlockBase<"divider", DividerStructure>
  | BlockBase<"page_break", PageBreakStructure>;

interface BlockBase<
  TKind extends string,
  TStructure extends BlockStructure,
> {
  readonly id: string;
  // The logical ID survives revisions; the revision ID pins this exact
  // representation for lineage and incremental processing.
  readonly revisionId: string;
  readonly kind: TKind;
  readonly order: number;
  readonly parentBlockId?: string;
  readonly sectionPath: readonly string[];
  readonly text: string;
  readonly analysisText: string;
  readonly contentDigest: string;
  readonly sourceSpan: TextSourceSpan | PdfSourceSpan;
  readonly structure: TStructure;
}

export interface TextSourceSpan {
  readonly kind: "text";
  readonly startOffset: number;
  readonly endOffset: number;
  readonly startLine: number;
  readonly endLine: number;
}

export interface PdfSourceSpan {
  readonly kind: "pdf";
  readonly pageStart: number;
  readonly pageEnd: number;
  readonly startTextOffset: number;
  readonly endTextOffset: number;
  readonly boxes?: readonly PdfBoundingBox[];
}

export interface PdfBoundingBox {
  readonly page: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type BlockStructure =
  | HeadingStructure
  | ParagraphStructure
  | ListItemStructure
  | TableStructure
  | CodeStructure
  | QuoteStructure
  | DividerStructure
  | PageBreakStructure;

export interface HeadingStructure {
  readonly kind: "heading";
  readonly level: 1 | 2 | 3 | 4 | 5 | 6;
}

export interface ParagraphStructure {
  readonly kind: "paragraph";
}

export interface ListItemStructure {
  readonly kind: "list_item";
  readonly ordered: boolean;
  readonly depth: number;
}

export interface TableStructure {
  readonly kind: "table";
  readonly headerRows: number;
  readonly cells: readonly (readonly string[])[];
}

export interface CodeStructure {
  readonly kind: "code";
  readonly language?: string;
}

export interface QuoteStructure {
  readonly kind: "quote";
  readonly depth: number;
}

export interface DividerStructure {
  readonly kind: "divider";
}

export interface PageBreakStructure {
  readonly kind: "page_break";
  readonly page: number;
}

export interface ParserDiagnostic {
  readonly code: string;
  readonly severity: "warning" | "error";
  readonly sourceSpan?: TextSourceSpan | PdfSourceSpan;
  readonly detail?: string;
}

/**
 * Searchable unit of meaning assembled from directly owned Blocks. Units form
 * a rooted tree so semantic boundaries can cross parser structure without
 * losing the original document identity or Block lineage.
 */
export interface DocumentSemanticUnit {
  readonly id: string;
  readonly revisionId: string;
  readonly sourceId: string;
  readonly observationId: string;
  readonly documentId: string;
  readonly kind: "document" | "section" | "segment";
  readonly title?: string;
  readonly parentId?: string;
  readonly childIds: readonly string[];
  readonly blockIds: readonly string[];
  readonly boundary: SemanticBoundary;
  readonly contentDigest: string;
  readonly segmentationPolicyVersion: string;
  readonly diagnostics: readonly SegmentationDiagnostic[];
}

/** Records whether meaning was found structurally, lexically, or by fallback. */
export type SemanticBoundary =
  | { readonly kind: "document_root" }
  | { readonly kind: "explicit_heading" }
  | { readonly kind: "lexical"; readonly strength: number }
  | { readonly kind: "size_fallback" };

export interface SegmentationDiagnostic {
  readonly code: string;
  readonly blockIds: readonly string[];
  readonly detail?: string;
}

/**
 * Embedding-sized material derived from exactly one Semantic Unit. Chunking may
 * split a Unit for index limits, but it cannot redefine the allowed meaning.
 */
export interface ManagedChunk {
  readonly id: string;
  readonly revisionId: string;
  readonly sourceId: string;
  readonly observationId: string;
  readonly documentId: string;
  readonly semanticUnitId: string;
  readonly ordinal: number;
  readonly sourceSlices: readonly ChunkSourceSlice[];
  readonly text: string;
  readonly contentDigest: string;
  readonly tokenCount: number;
  readonly textMeasureProfileVersion: string;
  readonly chunkPolicyVersion: string;
  readonly splitKind:
    | "block_pack"
    | "sentence"
    | "line"
    | "table_row"
    | "token_window";
  readonly previousChunkId?: string;
  readonly nextChunkId?: string;
}

/** Reversible reference used to reconstruct Chunk text from normalized Blocks. */
export interface ChunkSourceSlice {
  readonly blockId: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly separatorBefore: "" | "\n" | "\n\n";
}

/** Validates structural order, parentage, source spans, and snapshot identity. */
export function validateNormalizedDocument(
  document: NormalizedDocument,
): readonly ModelValidationIssue[] {
  const issues: ModelValidationIssue[] = [];
  validateIdentity(document.sourceId, "src", "sourceId", issues);
  validateIdentity(document.observationId, "obs", "observationId", issues);
  validateIdentity(document.documentId, "doc", "documentId", issues);
  validateDigest(document.contentDigest, "contentDigest", issues);
  validateNonEmpty(document.parser.id, "parser.id", issues);
  validateNonEmpty(document.parser.version, "parser.version", issues);
  validateNonEmpty(
    document.normalizationPolicyVersion,
    "normalizationPolicyVersion",
    issues,
  );
  validateNonEmpty(
    document.lineagePolicyVersion,
    "lineagePolicyVersion",
    issues,
  );

  const blockIds = new Set<string>();
  const headings = new Set<string>();
  document.blocks.forEach((block, index) => {
    const path = `blocks[${index}]`;
    validateIdentity(block.id, "blk", `${path}.id`, issues);
    validateRevision(block.revisionId, "brv", `${path}.revisionId`, issues);
    validateDigest(block.contentDigest, `${path}.contentDigest`, issues);

    if (blockIds.has(block.id)) {
      issues.push(issue("duplicate_id", `${path}.id`, "block ID must be unique"));
    }
    blockIds.add(block.id);

    if (block.order !== index) {
      issues.push(
        issue(
          "non_contiguous_order",
          `${path}.order`,
          "block order must be zero-based and contiguous",
        ),
      );
    }
    if (block.kind !== block.structure.kind) {
      issues.push(
        issue(
          "invalid_discriminator",
          `${path}.structure.kind`,
          "block and structure kinds must match",
        ),
      );
    }
    if (
      block.text.length === 0 &&
      block.kind !== "divider" &&
      block.kind !== "code" &&
      block.kind !== "page_break"
    ) {
      issues.push(
        issue(
          "invalid_value",
          `${path}.text`,
          "content blocks must not be empty",
        ),
      );
    }
    if (block.text.length > 0 && block.analysisText.length === 0) {
      issues.push(
        issue(
          "invalid_value",
          `${path}.analysisText`,
          "content blocks require non-empty analysis text",
        ),
      );
    }
    validateSourceSpan(block.sourceSpan, `${path}.sourceSpan`, issues);
    if (
      (document.mediaType === "application/pdf") !==
      (block.sourceSpan.kind === "pdf")
    ) {
      issues.push(
        issue(
          "invalid_discriminator",
          `${path}.sourceSpan.kind`,
          "source span kind must match the document media type",
        ),
      );
    }
    validateBlockStructure(block, path, issues);

    for (const [sectionIndex, headingId] of block.sectionPath.entries()) {
      if (
        !headings.has(headingId) &&
        !(block.kind === "heading" && headingId === block.id)
      ) {
        issues.push(
          issue(
            "invalid_reference",
            `${path}.sectionPath[${sectionIndex}]`,
            "section path must reference a preceding heading",
          ),
        );
      }
    }
    if (
      block.kind === "heading" &&
      block.sectionPath.at(-1) !== block.id
    ) {
      issues.push(
        issue(
          "invalid_reference",
          `${path}.sectionPath`,
          "heading section path must end with the heading itself",
        ),
      );
    }
    if (block.parentBlockId !== undefined && !blockIds.has(block.parentBlockId)) {
      issues.push(
        issue(
          "invalid_reference",
          `${path}.parentBlockId`,
          "parent block must precede its child",
        ),
      );
    }
    if (block.kind === "heading") {
      headings.add(block.id);
    }
  });

  document.completeness.diagnostics.forEach((diagnostic, index) => {
    const path = `completeness.diagnostics[${index}]`;
    validateNonEmpty(diagnostic.code, `${path}.code`, issues);
    if (diagnostic.sourceSpan !== undefined) {
      validateSourceSpan(diagnostic.sourceSpan, `${path}.sourceSpan`, issues);
    }
  });

  return issues;
}

export function assertValidNormalizedDocument(
  document: NormalizedDocument,
): void {
  assertNoModelIssues(
    "NormalizedDocument",
    validateNormalizedDocument(document),
  );
}

/**
 * Enforces one reachable root, reciprocal Unit links, and exactly one direct
 * Semantic Unit owner for every Block.
 */
export function validateDocumentSemanticUnits(
  document: NormalizedDocument,
  units: readonly DocumentSemanticUnit[],
): readonly ModelValidationIssue[] {
  const issues: ModelValidationIssue[] = [];
  const unitById = new Map<string, DocumentSemanticUnit>();
  const blockById = new Map(document.blocks.map((block) => [block.id, block]));
  const assignedBlocks = new Set<string>();
  let rootCount = 0;

  units.forEach((unit, index) => {
    const path = `units[${index}]`;
    validateIdentity(unit.id, "unit", `${path}.id`, issues);
    validateRevision(unit.revisionId, "urv", `${path}.revisionId`, issues);
    validateDigest(unit.contentDigest, `${path}.contentDigest`, issues);
    validateNonEmpty(
      unit.segmentationPolicyVersion,
      `${path}.segmentationPolicyVersion`,
      issues,
    );

    if (unitById.has(unit.id)) {
      issues.push(issue("duplicate_id", `${path}.id`, "unit ID must be unique"));
    }
    unitById.set(unit.id, unit);
    validateUniqueReferences(unit.childIds, `${path}.childIds`, issues);
    validateUniqueReferences(unit.blockIds, `${path}.blockIds`, issues);
    unit.diagnostics.forEach((diagnostic, diagnosticIndex) => {
      validateNonEmpty(
        diagnostic.code,
        `${path}.diagnostics[${diagnosticIndex}].code`,
        issues,
      );
      validateUniqueReferences(
        diagnostic.blockIds,
        `${path}.diagnostics[${diagnosticIndex}].blockIds`,
        issues,
      );
    });

    if (
      unit.sourceId !== document.sourceId ||
      unit.observationId !== document.observationId ||
      unit.documentId !== document.documentId
    ) {
      issues.push(
        issue(
          "relationship_mismatch",
          path,
          "unit must belong to the validated document snapshot",
        ),
      );
    }
    if (unit.kind === "document") {
      rootCount += 1;
      if (unit.parentId !== undefined || unit.boundary.kind !== "document_root") {
        issues.push(
          issue(
            "relationship_mismatch",
            `${path}.boundary`,
            "document root must have document_root boundary and no parent",
          ),
        );
      }
    } else {
      if (unit.parentId === undefined) {
        issues.push(
          issue(
            "missing_reference",
            `${path}.parentId`,
            "non-root unit requires a parent",
          ),
        );
      }
      if (unit.blockIds.length === 0) {
        issues.push(
          issue(
            "invalid_value",
            `${path}.blockIds`,
            "non-root unit must directly own at least one block",
          ),
        );
      }
    }
    if (
      unit.kind === "section" &&
      unit.boundary.kind !== "explicit_heading"
    ) {
      issues.push(
        issue(
          "invalid_discriminator",
          `${path}.boundary.kind`,
          "section unit requires an explicit heading boundary",
        ),
      );
    }
    if (
      unit.kind === "segment" &&
      unit.boundary.kind !== "lexical" &&
      unit.boundary.kind !== "size_fallback"
    ) {
      issues.push(
        issue(
          "invalid_discriminator",
          `${path}.boundary.kind`,
          "segment unit requires lexical or size fallback boundary",
        ),
      );
    }
    if (
      unit.boundary.kind === "lexical" &&
      (unit.boundary.strength < 0 || unit.boundary.strength > 1)
    ) {
      issues.push(
        issue(
          "invalid_value",
          `${path}.boundary.strength`,
          "lexical boundary strength must be between zero and one",
        ),
      );
    }

    for (const [blockIndex, blockId] of unit.blockIds.entries()) {
      const block = blockById.get(blockId);
      if (block === undefined) {
        issues.push(
          issue(
            "invalid_reference",
            `${path}.blockIds[${blockIndex}]`,
            "unit block must exist in the document",
          ),
        );
        continue;
      }
      if (assignedBlocks.has(blockId)) {
        issues.push(
          issue(
            "relationship_mismatch",
            `${path}.blockIds[${blockIndex}]`,
            "a block may be directly owned by only one unit",
          ),
        );
      }
      assignedBlocks.add(blockId);
      const previousBlockId = unit.blockIds[blockIndex - 1];
      const previousBlock =
        previousBlockId === undefined ? undefined : blockById.get(previousBlockId);
      if (previousBlock !== undefined && previousBlock.order >= block.order) {
        issues.push(
          issue(
            "invalid_order",
            `${path}.blockIds[${blockIndex}]`,
            "unit blocks must follow document order",
          ),
        );
      }
      if (
        unit.boundary.kind === "explicit_heading" &&
        blockIndex === 0 &&
        block.kind !== "heading"
      ) {
        issues.push(
          issue(
            "relationship_mismatch",
            `${path}.blockIds[0]`,
            "explicit heading unit must begin with a heading block",
          ),
        );
      }
    }
  });

  if (rootCount !== 1) {
    issues.push(
      issue(
        "invalid_root_count",
        "units",
        "document must contain exactly one root unit",
      ),
    );
  }

  const root = units.find((unit) => unit.kind === "document");
  if (root !== undefined) {
    validateUnitGraph(root, unitById, issues);
  }

  for (const [index, unit] of units.entries()) {
    const path = `units[${index}]`;
    if (unit.parentId !== undefined) {
      const parent = unitById.get(unit.parentId);
      if (parent === undefined) {
        issues.push(
          issue(
            "invalid_reference",
            `${path}.parentId`,
            "parent unit must exist",
          ),
        );
      } else if (!parent.childIds.includes(unit.id)) {
        issues.push(
          issue(
            "relationship_mismatch",
            `${path}.parentId`,
            "parent and child references must be reciprocal",
          ),
        );
      }
    }
    for (const [childIndex, childId] of unit.childIds.entries()) {
      const child = unitById.get(childId);
      if (child === undefined) {
        issues.push(
          issue(
            "invalid_reference",
            `${path}.childIds[${childIndex}]`,
            "child unit must exist",
          ),
        );
      } else if (child.parentId !== unit.id) {
        issues.push(
          issue(
            "relationship_mismatch",
            `${path}.childIds[${childIndex}]`,
            "child and parent references must be reciprocal",
          ),
        );
      }
    }
  }

  for (const block of document.blocks) {
    if (!assignedBlocks.has(block.id)) {
      issues.push(
        issue(
          "missing_reference",
          "units",
          `document block ${block.id} is not directly owned by a unit`,
        ),
      );
    }
  }

  return issues;
}

export function assertValidDocumentSemanticUnits(
  document: NormalizedDocument,
  units: readonly DocumentSemanticUnit[],
): void {
  assertNoModelIssues(
    "DocumentSemanticUnit",
    validateDocumentSemanticUnits(document, units),
  );
}

/**
 * Ensures every content-bearing Unit is chunked and every Chunk remains
 * reconstructable from ordered slices owned by that Unit.
 */
export function validateManagedChunks(
  document: NormalizedDocument,
  units: readonly DocumentSemanticUnit[],
  chunks: readonly ManagedChunk[],
  policy: DocumentIndexingPolicySet = DEFAULT_DOCUMENT_INDEXING_POLICY,
): readonly ModelValidationIssue[] {
  const issues: ModelValidationIssue[] = [];
  const blockById = new Map(document.blocks.map((block) => [block.id, block]));
  const unitIds = new Set(units.map((unit) => unit.id));
  const blockIdsByUnit = new Map(
    units.map((unit) => [unit.id, new Set(unit.blockIds)]),
  );
  const chunkById = new Map<string, ManagedChunk>();
  const ordinalsByUnit = new Map<string, number[]>();
  const chunksByUnit = new Map<
    string,
    Array<{ readonly chunk: ManagedChunk; readonly index: number }>
  >();
  const slicesByBlock = new Map<string, Array<{ start: number; end: number }>>();

  chunks.forEach((chunk, index) => {
    const path = `chunks[${index}]`;
    validateIdentity(chunk.id, "chk", `${path}.id`, issues);
    validateRevision(chunk.revisionId, "crv", `${path}.revisionId`, issues);
    validateDigest(chunk.contentDigest, `${path}.contentDigest`, issues);
    validateNonEmpty(
      chunk.textMeasureProfileVersion,
      `${path}.textMeasureProfileVersion`,
      issues,
    );
    if (chunk.textMeasureProfileVersion !== policy.textMeasureProfile.version) {
      issues.push(
        issue(
          "relationship_mismatch",
          `${path}.textMeasureProfileVersion`,
          "chunk text measurement profile must match the active policy",
        ),
      );
    }
    if (chunk.chunkPolicyVersion !== policy.chunk.version) {
      issues.push(
        issue(
          "relationship_mismatch",
          `${path}.chunkPolicyVersion`,
          "chunk policy version must match the active policy",
        ),
      );
    }
    validateNonEmpty(
      chunk.chunkPolicyVersion,
      `${path}.chunkPolicyVersion`,
      issues,
    );

    if (chunkById.has(chunk.id)) {
      issues.push(issue("duplicate_id", `${path}.id`, "chunk ID must be unique"));
    }
    chunkById.set(chunk.id, chunk);

    if (
      chunk.sourceId !== document.sourceId ||
      chunk.observationId !== document.observationId ||
      chunk.documentId !== document.documentId
    ) {
      issues.push(
        issue(
          "relationship_mismatch",
          path,
          "chunk must belong to the validated document snapshot",
        ),
      );
    }
    if (!unitIds.has(chunk.semanticUnitId)) {
      issues.push(
        issue(
          "invalid_reference",
          `${path}.semanticUnitId`,
          "chunk semantic unit must exist",
        ),
      );
    }
    if (!Number.isInteger(chunk.ordinal) || chunk.ordinal < 0) {
      issues.push(
        issue(
          "invalid_order",
          `${path}.ordinal`,
          "chunk ordinal must be a non-negative integer",
        ),
      );
    }
    const ordinals = ordinalsByUnit.get(chunk.semanticUnitId) ?? [];
    ordinals.push(chunk.ordinal);
    ordinalsByUnit.set(chunk.semanticUnitId, ordinals);
    const unitChunks = chunksByUnit.get(chunk.semanticUnitId) ?? [];
    unitChunks.push({ chunk, index });
    chunksByUnit.set(chunk.semanticUnitId, unitChunks);

    if (!Number.isInteger(chunk.tokenCount) || chunk.tokenCount <= 0) {
      issues.push(
        issue(
          "invalid_value",
          `${path}.tokenCount`,
          "chunk token count must be a positive integer",
        ),
      );
    }
    const measuredTokens = measureText(chunk.text, policy.textMeasureProfile);
    if (chunk.tokenCount !== measuredTokens) {
      issues.push(
        issue(
          "count_mismatch",
          `${path}.tokenCount`,
          "chunk token count must match the active text measurement profile",
        ),
      );
    }
    if (measuredTokens > policy.chunk.maxChunkTokens) {
      issues.push(
        issue(
          "invalid_value",
          `${path}.tokenCount`,
          "chunk token count must not exceed the active maximum",
        ),
      );
    }
    const expectedDigest = `sha256:${createHash("sha256")
      .update(chunk.text, "utf8")
      .digest("hex")}`;
    if (chunk.contentDigest !== expectedDigest) {
      issues.push(
        issue(
          "invalid_digest",
          `${path}.contentDigest`,
          "chunk content digest must match its canonical text",
        ),
      );
    }
    if (chunk.sourceSlices.length === 0) {
      issues.push(
        issue(
          "invalid_value",
          `${path}.sourceSlices`,
          "chunk requires at least one source slice",
        ),
      );
    }

    // Reconstruction makes Chunk text auditable and prevents transformations
    // from silently severing its lineage to normalized source content.
    let reconstructed = "";
    chunk.sourceSlices.forEach((slice, sliceIndex) => {
      const slicePath = `${path}.sourceSlices[${sliceIndex}]`;
      const block = blockById.get(slice.blockId);
      if (block === undefined) {
        issues.push(
          issue(
            "invalid_reference",
            `${slicePath}.blockId`,
            "source slice block must exist",
          ),
        );
        return;
      }
      if (!blockIdsByUnit.get(chunk.semanticUnitId)?.has(slice.blockId)) {
        issues.push(
          issue(
            "relationship_mismatch",
            `${slicePath}.blockId`,
            "source slice block must be directly owned by the chunk unit",
          ),
        );
      }
      if (
        !Number.isInteger(slice.startOffset) ||
        !Number.isInteger(slice.endOffset) ||
        slice.startOffset < 0 ||
        slice.endOffset <= slice.startOffset ||
        slice.endOffset > block.text.length
      ) {
        issues.push(
          issue(
            "invalid_source_span",
            slicePath,
            "source slice offsets must be a valid non-empty block range",
          ),
        );
        return;
      }
      const ranges = slicesByBlock.get(slice.blockId) ?? [];
      ranges.push({ start: slice.startOffset, end: slice.endOffset });
      slicesByBlock.set(slice.blockId, ranges);
      const previousSlice = chunk.sourceSlices[sliceIndex - 1];
      if (previousSlice !== undefined) {
        const previousBlock = blockById.get(previousSlice.blockId);
        if (
          previousBlock !== undefined &&
          (previousBlock.order > block.order ||
            (previousBlock.order === block.order &&
              previousSlice.endOffset > slice.startOffset))
        ) {
          issues.push(
            issue(
              "invalid_order",
              slicePath,
              "source slices must follow document and Block offset order",
            ),
          );
        }
      }
      if (sliceIndex === 0 && slice.separatorBefore !== "") {
        issues.push(
          issue(
            "invalid_value",
            `${slicePath}.separatorBefore`,
            "first source slice must not have a separator",
          ),
        );
      }
      reconstructed +=
        slice.separatorBefore +
        block.text.slice(slice.startOffset, slice.endOffset);
    });
    if (reconstructed !== chunk.text) {
      issues.push(
        issue(
          "text_mismatch",
          `${path}.text`,
          "chunk text must equal its reconstructed source slices",
        ),
      );
    }
  });

  for (const [unitId, ordinals] of ordinalsByUnit) {
    const sorted = [...ordinals].sort((left, right) => left - right);
    sorted.forEach((ordinal, index) => {
      if (ordinal !== index) {
        issues.push(
          issue(
            "non_contiguous_order",
            "chunks",
            `chunk ordinals for unit ${unitId} must be contiguous`,
          ),
        );
      }
    });
  }

  for (const unit of units) {
    const hasSearchableBlock = unit.blockIds.some((blockId) => {
      const block = blockById.get(blockId);
      return (
        block !== undefined &&
        block.text.length > 0 &&
        measureText(block.text, policy.textMeasureProfile) > 0
      );
    });
    if (hasSearchableBlock && !ordinalsByUnit.has(unit.id)) {
      issues.push(
        issue(
          "missing_reference",
          "chunks",
          `unit ${unit.id} owns blocks but has no managed chunk`,
        ),
      );
    }
  }

  for (const block of document.blocks) {
    if (
      block.text.length === 0 ||
      measureText(block.text, policy.textMeasureProfile) === 0
    ) {
      continue;
    }
    const ranges = [...(slicesByBlock.get(block.id) ?? [])].sort(
      (left, right) => left.start - right.start || left.end - right.end,
    );
    let coveredUntil = 0;
    for (const range of ranges) {
      if (range.start > coveredUntil) {
        break;
      }
      coveredUntil = Math.max(coveredUntil, range.end);
    }
    if (coveredUntil !== block.text.length) {
      issues.push(
        issue(
          "missing_reference",
          "chunks",
          `searchable block ${block.id} is not fully covered by managed chunks`,
        ),
      );
    }
  }

  for (const unit of units) {
    const unitChunks = [...(chunksByUnit.get(unit.id) ?? [])].sort(
      (left, right) => left.chunk.ordinal - right.chunk.ordinal,
    );
    for (let index = 1; index < unitChunks.length; index += 1) {
      const previousEntry = unitChunks[index - 1];
      const currentEntry = unitChunks[index];
      if (previousEntry === undefined || currentEntry === undefined) {
        continue;
      }
      const previous = previousEntry.chunk;
      const current = currentEntry.chunk;
      const overlapTokens = measureChunkOverlap(
        previous,
        current,
        blockById,
        policy,
      );
      if (overlapTokens > policy.chunk.overlapTokens) {
        issues.push(
          issue(
            "invalid_value",
            `chunks[${currentEntry.index}].sourceSlices`,
            "adjacent chunk overlap must not exceed the active policy",
          ),
        );
      }
    }
  }

  for (const [index, chunk] of chunks.entries()) {
    const path = `chunks[${index}]`;
    validateChunkNeighbor(
      chunk,
      chunk.previousChunkId,
      "previousChunkId",
      chunkById,
      path,
      issues,
    );
    validateChunkNeighbor(
      chunk,
      chunk.nextChunkId,
      "nextChunkId",
      chunkById,
      path,
      issues,
    );
  }

  return issues;
}

export function assertValidManagedChunks(
  document: NormalizedDocument,
  units: readonly DocumentSemanticUnit[],
  chunks: readonly ManagedChunk[],
  policy: DocumentIndexingPolicySet = DEFAULT_DOCUMENT_INDEXING_POLICY,
): void {
  assertNoModelIssues(
    "ManagedChunk",
    validateManagedChunks(document, units, chunks, policy),
  );
}

function measureChunkOverlap(
  previous: ManagedChunk,
  current: ManagedChunk,
  blockById: ReadonlyMap<string, DocumentBlock>,
  policy: DocumentIndexingPolicySet,
): number {
  let tokens = 0;
  for (const left of previous.sourceSlices) {
    for (const right of current.sourceSlices) {
      if (left.blockId !== right.blockId) {
        continue;
      }
      const start = Math.max(left.startOffset, right.startOffset);
      const end = Math.min(left.endOffset, right.endOffset);
      const block = blockById.get(left.blockId);
      if (block !== undefined && start < end) {
        tokens += measureText(
          block.text.slice(start, end),
          policy.textMeasureProfile,
        );
      }
    }
  }
  return tokens;
}

function validateIdentity(
  value: string,
  prefix: string,
  path: string,
  issues: ModelValidationIssue[],
): void {
  if (!isId(value, prefix)) {
    issues.push(issue("invalid_id", path, `expected ${prefix}_ identifier`));
  }
}

function validateRevision(
  value: string,
  prefix: string,
  path: string,
  issues: ModelValidationIssue[],
): void {
  if (!isRevisionId(value, prefix)) {
    issues.push(
      issue("invalid_id", path, `expected ${prefix}_ revision identifier`),
    );
  }
}

function validateDigest(
  value: string,
  path: string,
  issues: ModelValidationIssue[],
): void {
  if (!isDigest(value)) {
    issues.push(issue("invalid_digest", path, "expected sha256 digest"));
  }
}

function validateNonEmpty(
  value: string,
  path: string,
  issues: ModelValidationIssue[],
): void {
  if (value.length === 0) {
    issues.push(issue("invalid_value", path, "value must not be empty"));
  }
}

function validateSourceSpan(
  span: TextSourceSpan | PdfSourceSpan,
  path: string,
  issues: ModelValidationIssue[],
): void {
  if (span.kind === "text") {
    if (
      !Number.isInteger(span.startOffset) ||
      !Number.isInteger(span.endOffset) ||
      span.startOffset < 0 ||
      span.endOffset < span.startOffset ||
      !Number.isInteger(span.startLine) ||
      !Number.isInteger(span.endLine) ||
      span.startLine < 1 ||
      span.endLine < span.startLine
    ) {
      issues.push(
        issue(
          "invalid_source_span",
          path,
          "text source span coordinates are invalid",
        ),
      );
    }
    return;
  }

  if (
    !Number.isInteger(span.pageStart) ||
    !Number.isInteger(span.pageEnd) ||
    !Number.isInteger(span.startTextOffset) ||
    !Number.isInteger(span.endTextOffset) ||
    span.pageStart < 1 ||
    span.pageEnd < span.pageStart ||
    span.startTextOffset < 0 ||
    span.endTextOffset < span.startTextOffset
  ) {
    issues.push(
      issue(
        "invalid_source_span",
        path,
        "PDF source span coordinates are invalid",
      ),
    );
  }
  span.boxes?.forEach((box, index) => {
    if (
      !Number.isInteger(box.page) ||
      box.page < span.pageStart ||
      box.page > span.pageEnd ||
      !Number.isFinite(box.x) ||
      !Number.isFinite(box.y) ||
      !Number.isFinite(box.width) ||
      !Number.isFinite(box.height) ||
      box.width < 0 ||
      box.height < 0
    ) {
      issues.push(
        issue(
          "invalid_source_span",
          `${path}.boxes[${index}]`,
          "PDF bounding box coordinates are invalid",
        ),
      );
    }
  });
}

function validateChunkNeighbor(
  chunk: ManagedChunk,
  neighborId: string | undefined,
  field: "previousChunkId" | "nextChunkId",
  chunkById: ReadonlyMap<string, ManagedChunk>,
  path: string,
  issues: ModelValidationIssue[],
): void {
  if (neighborId === undefined) {
    return;
  }
  const neighbor = chunkById.get(neighborId);
  if (neighbor === undefined) {
    issues.push(
      issue(
        "invalid_reference",
        `${path}.${field}`,
        "neighbor chunk must exist",
      ),
    );
    return;
  }
  if (neighbor.semanticUnitId !== chunk.semanticUnitId) {
    issues.push(
      issue(
        "relationship_mismatch",
        `${path}.${field}`,
        "neighbor chunk must belong to the same semantic unit",
      ),
    );
  }
  const expectedOrdinal =
    field === "previousChunkId" ? chunk.ordinal - 1 : chunk.ordinal + 1;
  if (neighbor.ordinal !== expectedOrdinal) {
    issues.push(
      issue(
        "invalid_order",
        `${path}.${field}`,
        "neighbor chunk must have the adjacent ordinal",
      ),
    );
  }
  const reciprocalField =
    field === "previousChunkId" ? "nextChunkId" : "previousChunkId";
  if (neighbor[reciprocalField] !== chunk.id) {
    issues.push(
      issue(
        "relationship_mismatch",
        `${path}.${field}`,
        "chunk neighbor references must be reciprocal",
      ),
    );
  }
}

function validateBlockStructure(
  block: DocumentBlock,
  path: string,
  issues: ModelValidationIssue[],
): void {
  switch (block.structure.kind) {
    case "heading":
      return;
    case "paragraph":
    case "divider":
      return;
    case "list_item":
    case "quote":
      if (
        !Number.isInteger(block.structure.depth) ||
        block.structure.depth < 0
      ) {
        issues.push(
          issue(
            "invalid_value",
            `${path}.structure.depth`,
            "structure depth must be a non-negative integer",
          ),
        );
      }
      return;
    case "table": {
      if (
        !Number.isInteger(block.structure.headerRows) ||
        block.structure.headerRows < 0 ||
        block.structure.headerRows > block.structure.cells.length
      ) {
        issues.push(
          issue(
            "invalid_value",
            `${path}.structure.headerRows`,
            "table header row count is invalid",
          ),
        );
      }
      const columnCount = block.structure.cells[0]?.length;
      if (
        columnCount === undefined ||
        columnCount === 0 ||
        block.structure.cells.some((row) => row.length !== columnCount)
      ) {
        issues.push(
          issue(
            "invalid_value",
            `${path}.structure.cells`,
            "table must be a non-empty rectangular cell matrix",
          ),
        );
      }
      return;
    }
    case "code":
      return;
    case "page_break":
      if (!Number.isInteger(block.structure.page) || block.structure.page < 1) {
        issues.push(
          issue(
            "invalid_value",
            `${path}.structure.page`,
            "page break page must be a positive integer",
          ),
        );
      }
      return;
  }
}

function validateUniqueReferences(
  values: readonly string[],
  path: string,
  issues: ModelValidationIssue[],
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      issues.push(
        issue(
          "duplicate_reference",
          `${path}[${index}]`,
          "reference must not be repeated",
        ),
      );
    }
    seen.add(value);
  });
}

function validateUnitGraph(
  root: DocumentSemanticUnit,
  unitById: ReadonlyMap<string, DocumentSemanticUnit>,
  issues: ModelValidationIssue[],
): void {
  const visited = new Set<string>();
  const active = new Set<string>();

  const visit = (unit: DocumentSemanticUnit): void => {
    if (active.has(unit.id)) {
      issues.push(
        issue(
          "cycle_detected",
          "units",
          `semantic unit hierarchy contains a cycle at ${unit.id}`,
        ),
      );
      return;
    }
    if (visited.has(unit.id)) {
      return;
    }
    visited.add(unit.id);
    active.add(unit.id);
    for (const childId of unit.childIds) {
      const child = unitById.get(childId);
      if (child !== undefined) {
        visit(child);
      }
    }
    active.delete(unit.id);
  };

  visit(root);
  for (const unitId of unitById.keys()) {
    if (!visited.has(unitId)) {
      issues.push(
        issue(
          "invalid_reference",
          "units",
          `semantic unit ${unitId} is not reachable from the document root`,
        ),
      );
    }
  }
}
