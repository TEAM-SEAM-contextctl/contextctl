import { sha256Digest } from "./document-capture.js";
import {
  assertValidManagedChunks,
  type ChunkSourceSlice,
  type DocumentBlock,
  type DocumentSemanticUnit,
  type ManagedChunk,
  type NormalizedDocument,
  validateDocumentSemanticUnits,
  validateNormalizedDocument,
} from "./document-model.js";
import {
  DEFAULT_DOCUMENT_INDEXING_POLICY,
  measureText,
  parseDocumentIndexingPolicy,
  type ChunkPolicy,
  type DocumentIndexingPolicySet,
  type TextMeasureProfile,
} from "./document-indexing-policy.js";
import { type ModelValidationIssue } from "./model-validation.js";
import { revisionIdentity } from "./revision-identity.js";

const CHUNK_ID_PATTERN = /^chk_[a-z0-9]+(?:[a-z0-9_-]*[a-z0-9])?$/;

export interface ManagedChunkIdSource {
  nextChunkId(): string;
}

export interface GenerateManagedChunksInput {
  readonly document: NormalizedDocument;
  readonly semanticUnits: readonly DocumentSemanticUnit[];
  readonly ids: ManagedChunkIdSource;
  readonly policy?: DocumentIndexingPolicySet;
}

export type ManagedChunkGenerationErrorCode =
  | "duplicate_chunk_id"
  | "incomplete_document"
  | "inconsistent_segmentation_policy"
  | "invalid_chunk_id"
  | "invalid_document"
  | "invalid_semantic_units";

export class ManagedChunkGenerationError extends Error {
  constructor(
    readonly code: ManagedChunkGenerationErrorCode,
    readonly issues: readonly ModelValidationIssue[] = [],
  ) {
    super(`Managed Chunk generation failed: ${code}`);
    this.name = "ManagedChunkGenerationError";
  }
}

interface ChunkPlan {
  readonly splitKind: ManagedChunk["splitKind"];
  sourceSlices: ChunkSourceSlice[];
}

interface TextSpan {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly splitKind: ManagedChunk["splitKind"];
}

/**
 * Turns directly owned Unit Blocks into bounded, reversible search material.
 * Structural Blocks remain whole whenever possible; only an oversized Block
 * enters the type-aware splitting chain. Allocated IDs are initial logical
 * identities; the incremental re-indexing stage may later reconcile them with
 * a previous Chunk set without changing these boundaries.
 */
export function generateManagedChunks(
  input: GenerateManagedChunksInput,
): readonly ManagedChunk[] {
  validateInput(input);
  const policy = parseDocumentIndexingPolicy(
    input.policy ?? DEFAULT_DOCUMENT_INDEXING_POLICY,
  );
  if (
    input.semanticUnits.some(
      (unit) => unit.segmentationPolicyVersion !== policy.segmentation.version,
    )
  ) {
    throw new ManagedChunkGenerationError("inconsistent_segmentation_policy");
  }

  const blockById = new Map(
    input.document.blocks.map((block) => [block.id, block]),
  );
  const orderedUnits = [...input.semanticUnits]
    .filter((unit) => unit.blockIds.some((id) => isSearchable(requiredBlock(blockById, id))))
    .sort(
      (left, right) =>
        firstBlockOrder(left, blockById) - firstBlockOrder(right, blockById),
    );
  const chunks: ManagedChunk[] = [];
  const allocatedChunkIds = new Set<string>();

  for (const unit of orderedUnits) {
    const blocks = unit.blockIds.map((id) => requiredBlock(blockById, id));
    const plans = addWholeBlockOverlap(
      createChunkPlans(
        blocks,
        blockById,
        policy.chunk,
        policy.textMeasureProfile,
      ),
      blockById,
      policy.chunk,
      policy.textMeasureProfile,
    );
    const ids = allocateChunkIds(
      plans.length,
      input.ids,
      allocatedChunkIds,
    );
    for (const [ordinal, plan] of plans.entries()) {
      const id = requiredAt(ids, ordinal);
      const text = reconstruct(plan.sourceSlices, blockById);
      const contentDigest = sha256Digest(text);
      const common = {
        id,
        sourceId: input.document.sourceId,
        observationId: input.document.observationId,
        documentId: input.document.documentId,
        semanticUnitId: unit.id,
        ordinal,
        sourceSlices: plan.sourceSlices,
        text,
        contentDigest,
        tokenCount: measureText(text, policy.textMeasureProfile),
        textMeasureProfileVersion: policy.textMeasureProfile.version,
        chunkPolicyVersion: policy.chunk.version,
        splitKind: plan.splitKind,
      } as const;
      chunks.push({
        ...common,
        revisionId: chunkRevisionId(common),
        ...(ordinal === 0 ? {} : { previousChunkId: requiredAt(ids, ordinal - 1) }),
        ...(ordinal === plans.length - 1
          ? {}
          : { nextChunkId: requiredAt(ids, ordinal + 1) }),
      });
    }
  }

  assertValidManagedChunks(
    input.document,
    input.semanticUnits,
    chunks,
    policy,
  );
  return chunks;
}

function validateInput(input: GenerateManagedChunksInput): void {
  const documentIssues = validateNormalizedDocument(input.document);
  if (documentIssues.length > 0) {
    throw new ManagedChunkGenerationError("invalid_document", documentIssues);
  }
  if (input.document.completeness.status !== "complete") {
    throw new ManagedChunkGenerationError("incomplete_document");
  }
  const unitIssues = validateDocumentSemanticUnits(
    input.document,
    input.semanticUnits,
  );
  if (unitIssues.length > 0) {
    throw new ManagedChunkGenerationError("invalid_semantic_units", unitIssues);
  }
}

function createChunkPlans(
  blocks: readonly DocumentBlock[],
  blockById: ReadonlyMap<string, DocumentBlock>,
  policy: ChunkPolicy,
  profile: TextMeasureProfile,
): readonly ChunkPlan[] {
  const plans: ChunkPlan[] = [];
  let packed: ChunkSourceSlice[] = [];

  const flushPacked = (): void => {
    if (measureSlices(packed, blockById, profile) > 0) {
      plans.push({
        splitKind: "block_pack",
        sourceSlices: normalizeSeparators(packed),
      });
    }
    packed = [];
  };

  for (const block of blocks) {
    if (block.text.length === 0) {
      continue;
    }
    const blockTokens = measureText(block.text, profile);
    if (blockTokens > policy.maxChunkTokens) {
      flushPacked();
      plans.push(...splitOversizedBlock(block, blockById, policy, profile));
      continue;
    }

    const slice = wholeBlockSlice(block);
    const candidate = normalizeSeparators([...packed, slice]);
    const currentTokens = measureSlices(packed, blockById, profile);
    if (
      packed.length > 0 &&
      (currentTokens >= policy.targetChunkTokens ||
        measureSlices(candidate, blockById, profile) > policy.maxChunkTokens)
    ) {
      flushPacked();
    }
    packed.push(slice);
  }
  flushPacked();
  return plans;
}

function splitOversizedBlock(
  block: DocumentBlock,
  blockById: ReadonlyMap<string, DocumentBlock>,
  policy: ChunkPolicy,
  profile: TextMeasureProfile,
): readonly ChunkPlan[] {
  if (block.kind === "table") {
    return splitTable(block, blockById, policy, profile);
  }

  const structural = structuralSpans(block);
  const bounded = structural.flatMap((span) =>
    measureText(block.text.slice(span.startOffset, span.endOffset), profile) <=
    policy.maxChunkTokens
      ? [span]
      : tokenWindowSpans(
          block.text,
          span.startOffset,
          span.endOffset,
          policy.targetChunkTokens,
          policy.maxChunkTokens,
          profile,
        ),
  );
  return packBlockSpans(block, bounded, policy, profile);
}

function structuralSpans(block: DocumentBlock): readonly TextSpan[] {
  switch (block.kind) {
    case "paragraph":
    case "quote":
      return sentenceSpans(block.text);
    case "code":
      return lineSpans(block.text, "line");
    case "list_item": {
      const sentences = sentenceSpans(block.text);
      return sentences.length > 1
        ? sentences
        : lineSpans(block.text, "line");
    }
    default:
      return [
        {
          startOffset: 0,
          endOffset: block.text.length,
          splitKind: "token_window",
        },
      ];
  }
}

function splitTable(
  block: Extract<DocumentBlock, { readonly kind: "table" }>,
  blockById: ReadonlyMap<string, DocumentBlock>,
  policy: ChunkPolicy,
  profile: TextMeasureProfile,
): readonly ChunkPlan[] {
  const rows = lineSpans(block.text, "table_row");
  const headerCount = Math.min(block.structure.headerRows, rows.length);
  const headers = rows.slice(0, headerCount);
  const body = rows.slice(headerCount);
  const headerSlices = headers.map((span) => sliceFromSpan(block, span));
  const headerTokens = measureSlices(headerSlices, blockById, profile);

  if (
    body.length === 0 ||
    headerTokens > policy.overlapTokens ||
    headerTokens >= policy.maxChunkTokens
  ) {
    return packBlockSpans(
      block,
      tokenWindowSpans(
        block.text,
        0,
        block.text.length,
        policy.targetChunkTokens,
        policy.maxChunkTokens,
        profile,
      ),
      policy,
      profile,
    );
  }

  const plans: ChunkPlan[] = [];
  let rowSlices: ChunkSourceSlice[] = [];
  const flush = (): void => {
    if (rowSlices.length === 0) {
      return;
    }
    plans.push({
      splitKind: rowSlices.some(
        (slice) =>
          !rows.some(
            (row) =>
              row.startOffset === slice.startOffset &&
              row.endOffset === slice.endOffset,
          ),
      )
        ? "token_window"
        : "table_row",
      sourceSlices: normalizeSeparators([...headerSlices, ...rowSlices]),
    });
    rowSlices = [];
  };

  for (const row of body) {
    const rowText = block.text.slice(row.startOffset, row.endOffset);
    const availableMax = policy.maxChunkTokens - headerTokens;
    const availableTarget = Math.max(1, policy.targetChunkTokens - headerTokens);
    const rowParts =
      measureText(rowText, profile) <= availableMax
        ? [row]
        : tokenWindowSpans(
            block.text,
            row.startOffset,
            row.endOffset,
            availableTarget,
            availableMax,
            profile,
          );
    for (const part of rowParts) {
      const candidate = normalizeSeparators([
        ...headerSlices,
        ...rowSlices,
        sliceFromSpan(block, part),
      ]);
      const current = normalizeSeparators([...headerSlices, ...rowSlices]);
      if (
        rowSlices.length > 0 &&
        (measureSlices(current, blockById, profile) >=
          policy.targetChunkTokens ||
          measureSlices(candidate, blockById, profile) > policy.maxChunkTokens)
      ) {
        flush();
      }
      rowSlices.push(sliceFromSpan(block, part));
    }
  }
  flush();
  return plans;
}

function packBlockSpans(
  block: DocumentBlock,
  spans: readonly TextSpan[],
  policy: ChunkPolicy,
  profile: TextMeasureProfile,
): readonly ChunkPlan[] {
  const plans: ChunkPlan[] = [];
  let current: TextSpan[] = [];
  const flush = (): void => {
    if (current.length === 0) {
      return;
    }
    plans.push({
      splitKind: current.some((span) => span.splitKind === "token_window")
        ? "token_window"
        : requiredAt(current, 0).splitKind,
      sourceSlices: normalizeSeparators(
        current.map((span) => sliceFromSpan(block, span)),
      ),
    });
    current = [];
  };

  for (const span of spans) {
    const candidate = [...current, span];
    const currentText = spansText(block.text, current);
    const candidateText = spansText(block.text, candidate);
    if (
      current.length > 0 &&
      (measureText(currentText, profile) >= policy.targetChunkTokens ||
        measureText(candidateText, profile) > policy.maxChunkTokens)
    ) {
      flush();
    }
    current.push(span);
  }
  flush();
  return plans;
}

function addWholeBlockOverlap(
  plans: readonly ChunkPlan[],
  blockById: ReadonlyMap<string, DocumentBlock>,
  policy: ChunkPolicy,
  profile: TextMeasureProfile,
): readonly ChunkPlan[] {
  const result = plans.map((plan) => ({
    splitKind: plan.splitKind,
    sourceSlices: [...plan.sourceSlices],
  }));
  for (let index = 1; index < result.length; index += 1) {
    const previous = requiredAt(result, index - 1);
    const current = requiredAt(result, index);
    const overlap: ChunkSourceSlice[] = [];
    let overlapTokens = 0;

    for (const slice of [...previous.sourceSlices].reverse()) {
      const block = requiredBlock(blockById, slice.blockId);
      if (
        slice.startOffset !== 0 ||
        slice.endOffset !== block.text.length ||
        current.sourceSlices.some((candidate) => candidate.blockId === block.id)
      ) {
        break;
      }
      const tokens = measureText(block.text, profile);
      if (overlapTokens + tokens > policy.overlapTokens) {
        break;
      }
      overlap.unshift(wholeBlockSlice(block));
      overlapTokens += tokens;
    }

    if (overlap.length === 0) {
      continue;
    }
    const candidate = normalizeSeparators([...overlap, ...current.sourceSlices]);
    if (measureSlices(candidate, blockById, profile) <= policy.maxChunkTokens) {
      current.sourceSlices = candidate;
    }
  }
  return result;
}

function sentenceSpans(text: string): readonly TextSpan[] {
  const spans: TextSpan[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (!".!?。！？".includes(text[index] ?? "")) {
      continue;
    }
    let end = index + 1;
    while (end < text.length && /\s/u.test(text[end] ?? "")) {
      end += 1;
    }
    spans.push({ startOffset: start, endOffset: end, splitKind: "sentence" });
    start = end;
    index = end - 1;
  }
  if (start < text.length) {
    spans.push({ startOffset: start, endOffset: text.length, splitKind: "sentence" });
  }
  return spans.length === 0
    ? [{ startOffset: 0, endOffset: text.length, splitKind: "sentence" }]
    : spans;
}

function lineSpans(
  text: string,
  splitKind: "line" | "table_row",
): readonly TextSpan[] {
  const spans: TextSpan[] = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline + 1;
    spans.push({ startOffset: start, endOffset: end, splitKind });
    start = end;
  }
  return spans;
}

function tokenWindowSpans(
  text: string,
  startOffset: number,
  endOffset: number,
  targetTokens: number,
  maxTokens: number,
  profile: TextMeasureProfile,
): readonly TextSpan[] {
  const boundaries = utf16Boundaries(text, startOffset, endOffset);
  const spans: TextSpan[] = [];
  let startIndex = 0;
  while (startIndex < boundaries.length - 1) {
    const start = requiredAt(boundaries, startIndex);
    const targetEndIndex = largestBoundaryWithinTokenLimit(
      text,
      boundaries,
      startIndex,
      targetTokens,
      profile,
    );
    const maxEndIndex =
      targetEndIndex ??
      largestBoundaryWithinTokenLimit(
        text,
        boundaries,
        startIndex,
        maxTokens,
        profile,
      );
    const endIndex = maxEndIndex ?? startIndex + 1;
    const end = requiredAt(boundaries, endIndex);
    spans.push({ startOffset: start, endOffset: end, splitKind: "token_window" });
    startIndex = endIndex;
  }
  return spans;
}

function largestBoundaryWithinTokenLimit(
  text: string,
  boundaries: readonly number[],
  startIndex: number,
  tokenLimit: number,
  profile: TextMeasureProfile,
): number | undefined {
  const start = requiredAt(boundaries, startIndex);
  let low = startIndex + 1;
  let high = boundaries.length - 1;
  let accepted: number | undefined;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const end = requiredAt(boundaries, middle);
    if (measureText(text.slice(start, end), profile) <= tokenLimit) {
      accepted = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return accepted;
}

function utf16Boundaries(
  text: string,
  startOffset: number,
  endOffset: number,
): readonly number[] {
  const boundaries = [startOffset];
  let offset = startOffset;
  for (const codePoint of text.slice(startOffset, endOffset)) {
    offset += codePoint.length;
    boundaries.push(offset);
  }
  return boundaries;
}

function allocateChunkIds(
  count: number,
  source: ManagedChunkIdSource,
  allocated: Set<string>,
): readonly string[] {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    let id: string | undefined;
    for (let attempt = 0; attempt < 1_024; attempt += 1) {
      const candidate = source.nextChunkId();
      if (!CHUNK_ID_PATTERN.test(candidate)) {
        throw new ManagedChunkGenerationError("invalid_chunk_id");
      }
      if (!allocated.has(candidate)) {
        id = candidate;
        break;
      }
    }
    if (id === undefined) {
      throw new ManagedChunkGenerationError("duplicate_chunk_id");
    }
    allocated.add(id);
    ids.push(id);
  }
  return ids;
}

function chunkRevisionId(
  chunk: Omit<ManagedChunk, "nextChunkId" | "previousChunkId" | "revisionId">,
): string {
  const value = {
    id: chunk.id,
    sourceId: chunk.sourceId,
    documentId: chunk.documentId,
    semanticUnitId: chunk.semanticUnitId,
    sourceSlices: chunk.sourceSlices,
    contentDigest: chunk.contentDigest,
    tokenCount: chunk.tokenCount,
    textMeasureProfileVersion: chunk.textMeasureProfileVersion,
    chunkPolicyVersion: chunk.chunkPolicyVersion,
    splitKind: chunk.splitKind,
  };
  return revisionIdentity("crv", value);
}

function wholeBlockSlice(block: DocumentBlock): ChunkSourceSlice {
  return {
    blockId: block.id,
    startOffset: 0,
    endOffset: block.text.length,
    separatorBefore: "",
  };
}

function sliceFromSpan(block: DocumentBlock, span: TextSpan): ChunkSourceSlice {
  return {
    blockId: block.id,
    startOffset: span.startOffset,
    endOffset: span.endOffset,
    separatorBefore: "",
  };
}

function normalizeSeparators(
  slices: readonly ChunkSourceSlice[],
): ChunkSourceSlice[] {
  return slices.map((slice, index) => ({
    ...slice,
    separatorBefore:
      index === 0
        ? ""
        : requiredAt(slices, index - 1).blockId === slice.blockId
          ? ""
          : "\n\n",
  }));
}

function reconstruct(
  slices: readonly ChunkSourceSlice[],
  blockById: ReadonlyMap<string, DocumentBlock>,
): string {
  return slices
    .map((slice) => {
      const block = requiredBlock(blockById, slice.blockId);
      return (
        slice.separatorBefore +
        block.text.slice(slice.startOffset, slice.endOffset)
      );
    })
    .join("");
}

function measureSlices(
  slices: readonly ChunkSourceSlice[],
  blockById: ReadonlyMap<string, DocumentBlock>,
  profile: TextMeasureProfile,
): number {
  return measureText(
    reconstruct(normalizeSeparators(slices), blockById),
    profile,
  );
}

function spansText(text: string, spans: readonly TextSpan[]): string {
  return spans.map((span) => text.slice(span.startOffset, span.endOffset)).join("");
}

function isSearchable(block: DocumentBlock): boolean {
  return block.text.length > 0 && measureText(block.text) > 0;
}

function firstBlockOrder(
  unit: DocumentSemanticUnit,
  blockById: ReadonlyMap<string, DocumentBlock>,
): number {
  const firstId = unit.blockIds[0];
  return firstId === undefined
    ? Number.MAX_SAFE_INTEGER
    : requiredBlock(blockById, firstId).order;
}

function requiredBlock(
  blockById: ReadonlyMap<string, DocumentBlock>,
  id: string,
): DocumentBlock {
  const block = blockById.get(id);
  if (block === undefined) {
    throw new ManagedChunkGenerationError("invalid_semantic_units");
  }
  return block;
}

function requiredAt<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) {
    throw new RangeError("Managed Chunk index is out of range");
  }
  return value;
}
