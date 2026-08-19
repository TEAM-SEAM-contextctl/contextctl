import {
  embeddingProfilesMatch,
  validateEmbeddingProfile,
  type EmbeddingProfile,
} from "./embedding-profile.js";
import {
  type DocumentBlock,
  type DocumentSemanticUnit,
  type ManagedChunk,
  type NormalizedDocument,
  validateDocumentSemanticUnits,
  validateManagedChunks,
  validateNormalizedDocument,
} from "./document-model.js";
import {
  parseDocumentIndexingPolicy,
  type DocumentIndexingPolicySet,
} from "./document-indexing-policy.js";
import type { IndexManifest } from "./index-manifest.js";
import { createManagedChunkRevisionId } from "./managed-chunk-generation.js";
import { canonicalJson } from "./revision-identity.js";

export interface DocumentIndexingSnapshot {
  readonly document: NormalizedDocument;
  readonly semanticUnits: readonly DocumentSemanticUnit[];
  readonly chunks: readonly ManagedChunk[];
  readonly indexingPolicy: DocumentIndexingPolicySet;
  readonly embeddingProfile: EmbeddingProfile;
  readonly payloadSchemaVersion: 2;
}

/** Minimal adapter-independent result of a cheap source change probe. */
export type DocumentSourceChangeSignal =
  | { readonly status: "changed"; readonly token?: string }
  | { readonly status: "unchanged"; readonly token?: string };

export type DocumentCaptureDecision =
  | {
      readonly action: "capture";
      readonly reason: "baseline_missing" | "source_changed";
    }
  | {
      readonly action: "skip";
      readonly reason: "source_unchanged";
    };

export type DocumentFullRebuildReason =
  | "baseline_missing"
  | "chunk_policy_changed"
  | "document_schema_changed"
  | "embedding_profile_changed"
  | "lineage_policy_changed"
  | "media_type_changed"
  | "normalization_policy_changed"
  | "parser_changed"
  | "payload_schema_changed"
  | "segmentation_policy_changed"
  | "text_measure_profile_changed";

export type DocumentBlockChange =
  | {
      readonly kind: "unchanged";
      readonly blockId: string;
      readonly previousOrder: number;
      readonly currentOrder: number;
    }
  | {
      readonly kind: "modified";
      readonly blockId: string;
      readonly previousRevisionId: string;
      readonly currentRevisionId: string;
      readonly previousOrder: number;
      readonly currentOrder: number;
      readonly moved: boolean;
    }
  | {
      readonly kind: "moved";
      readonly blockId: string;
      readonly previousOrder: number;
      readonly currentOrder: number;
    }
  | {
      readonly kind: "added";
      readonly blockId: string;
      readonly currentOrder: number;
    }
  | {
      readonly kind: "removed";
      readonly blockId: string;
      readonly previousOrder: number;
    };

export type DocumentSemanticUnitChange =
  | {
      readonly kind: "unchanged";
      readonly unitId: string;
      readonly revisionId: string;
    }
  | {
      readonly kind: "updated";
      readonly unitId: string;
      readonly previousRevisionId: string;
      readonly currentRevisionId: string;
    }
  | {
      readonly kind: "added";
      readonly unitId: string;
      readonly currentRevisionId: string;
    }
  | {
      readonly kind: "removed";
      readonly unitId: string;
      readonly previousRevisionId: string;
    };

export interface PlannedChunkRevision {
  readonly chunkId: string;
  readonly chunkRevisionId: string;
  readonly contentDigest: string;
}

export interface DocumentIncrementalUpdateOperations {
  /** Current revisions that require a provider call. */
  readonly embed: readonly PlannedChunkRevision[];
  /** Byte-compatible previous vectors that can be carried into staging. */
  readonly reuse: readonly PlannedChunkRevision[];
  /** Current logical records that staging must insert or replace. */
  readonly upsert: readonly PlannedChunkRevision[];
  /** Previous logical revisions that staging must remove. */
  readonly delete: readonly PlannedChunkRevision[];
}

export interface AffectedChunkClosure {
  readonly previousChunkIds: readonly string[];
  readonly currentChunkIds: readonly string[];
}

export interface DocumentIncrementalUpdateMetrics {
  readonly previousBlockCount: number;
  readonly currentBlockCount: number;
  readonly changedBlockCount: number;
  readonly previousChunkCount: number;
  readonly currentChunkCount: number;
  readonly embeddingCallCount: number;
  readonly reusedEmbeddingCount: number;
  readonly upsertCount: number;
  readonly deleteCount: number;
}

export interface DocumentIncrementalUpdatePlan {
  readonly strategy: "incremental" | "full_rebuild";
  readonly rebuildReasons: readonly DocumentFullRebuildReason[];
  readonly blockChanges: readonly DocumentBlockChange[];
  readonly semanticUnitChanges: readonly DocumentSemanticUnitChange[];
  /** Current chunks after safe logical-ID inheritance. */
  readonly chunks: readonly ManagedChunk[];
  readonly affectedChunkClosure: AffectedChunkClosure;
  readonly operations: DocumentIncrementalUpdateOperations;
  readonly metrics: DocumentIncrementalUpdateMetrics;
}

export type DocumentIncrementalUpdateErrorCode =
  | "incomplete_snapshot"
  | "invalid_current_snapshot"
  | "invalid_previous_snapshot"
  | "mismatched_document_identity";

export class DocumentIncrementalUpdateError extends Error {
  constructor(readonly code: DocumentIncrementalUpdateErrorCode) {
    super(`Document incremental update planning failed: ${code}`);
    this.name = "DocumentIncrementalUpdateError";
  }
}

export interface PlanDocumentIncrementalUpdateInput {
  readonly previous?: DocumentIndexingSnapshot;
  readonly current: DocumentIndexingSnapshot;
}

/**
 * Turns the adapter's cheap signal into a fail-safe capture decision. An
 * `unchanged` signal is only sufficient when a usable baseline exists.
 */
export function decideDocumentCapture(input: {
  readonly changeSignal: DocumentSourceChangeSignal;
  readonly hasPreviousSnapshot: boolean;
}): DocumentCaptureDecision {
  if (!input.hasPreviousSnapshot) {
    return { action: "capture", reason: "baseline_missing" };
  }
  return input.changeSignal.status === "unchanged"
    ? { action: "skip", reason: "source_unchanged" }
    : { action: "capture", reason: "source_changed" };
}

/**
 * Computes one deterministic logical update plan. It never mutates an index;
 * SEAM-59's staging publisher is the consumer of this plan.
 */
export function planDocumentIncrementalUpdate(
  input: PlanDocumentIncrementalUpdateInput,
): DocumentIncrementalUpdatePlan {
  assertValidDocumentIndexingSnapshot(input.current, "current");
  if (input.previous === undefined) {
    return fullRebuildPlan(undefined, input.current, ["baseline_missing"]);
  }
  assertValidDocumentIndexingSnapshot(input.previous, "previous");
  assertSameDocument(input.previous, input.current);

  const rebuildReasons = fullRebuildReasons(input.previous, input.current);
  if (rebuildReasons.length > 0) {
    return fullRebuildPlan(input.previous, input.current, rebuildReasons);
  }

  const blockChanges = classifyBlockChanges(
    input.previous.document.blocks,
    input.current.document.blocks,
  );
  const semanticUnitChanges = classifySemanticUnitChanges(
    input.previous.semanticUnits,
    input.current.semanticUnits,
  );
  const chunks = reconcileChunkIdentities(input.previous, input.current);
  const operations = incrementalOperations(input.previous.chunks, chunks);
  return createPlan({
    strategy: "incremental",
    rebuildReasons: [],
    previous: input.previous,
    current: input.current,
    blockChanges,
    semanticUnitChanges,
    chunks,
    operations,
  });
}

/**
 * A published Index version described by content alone. Block, Unit and Chunk
 * identifiers are deliberately excluded: an incremental update inherits them
 * from its predecessor while a cold rebuild mints fresh ones, so identity can
 * never be the basis of the equivalence gate.
 */
export interface PublishedDocumentContentView {
  readonly manifest: IndexManifest;
  readonly document: NormalizedDocument;
  readonly semanticUnits: readonly DocumentSemanticUnit[];
  readonly chunks: readonly ManagedChunk[];
}

/**
 * Proves that one incremental update carries the same retrievable meaning as a
 * full rebuild of the same Observation. An empty result is the I6 gate passing.
 */
export function documentIndexEquivalenceViolations(
  incremental: PublishedDocumentContentView,
  rebuilt: PublishedDocumentContentView,
): readonly string[] {
  const violations: string[] = [];
  if (
    canonicalJson(contentManifest(incremental.manifest)) !==
    canonicalJson(contentManifest(rebuilt.manifest))
  ) {
    violations.push("index manifest content differs");
  }
  if (
    canonicalJson(unitContentKeys(incremental)) !==
    canonicalJson(unitContentKeys(rebuilt))
  ) {
    violations.push("semantic unit content differs");
  }
  if (
    canonicalJson(chunkContentKeys(incremental)) !==
    canonicalJson(chunkContentKeys(rebuilt))
  ) {
    violations.push("managed chunk content differs");
  }
  return violations;
}

/**
 * Unit IDs whose previous immutable Scope may be inherited. Beyond an unchanged
 * Unit revision this also requires a byte-identical Chunk revision set, because
 * an inherited Scope keeps pointing at the predecessor Index snapshot.
 */
export function inheritableScopeUnitIds(input: {
  readonly previous: DocumentIndexingSnapshot;
  readonly plan: DocumentIncrementalUpdatePlan;
}): readonly string[] {
  if (input.plan.strategy !== "incremental") {
    return [];
  }
  const previousRevisions = chunkRevisionsByUnit(input.previous.chunks);
  const currentRevisions = chunkRevisionsByUnit(input.plan.chunks);
  return input.plan.semanticUnitChanges
    .filter(
      (change) =>
        change.kind === "unchanged" &&
        canonicalJson(previousRevisions.get(change.unitId) ?? []) ===
          canonicalJson(currentRevisions.get(change.unitId) ?? []),
    )
    .map((change) => change.unitId)
    .sort();
}

function chunkRevisionsByUnit(
  chunks: readonly ManagedChunk[],
): ReadonlyMap<string, readonly string[]> {
  const byUnit = new Map<string, string[]>();
  for (const chunk of chunks) {
    const revisions = byUnit.get(chunk.semanticUnitId) ?? [];
    revisions.push(chunk.revisionId);
    byUnit.set(chunk.semanticUnitId, revisions);
  }
  return new Map(
    [...byUnit].map(([unitId, revisions]) => [unitId, [...revisions].sort()]),
  );
}

function contentManifest(manifest: IndexManifest): unknown {
  const {
    indexVersion: _indexVersion,
    recordSetDigest: _recordSetDigest,
    publishedAt: _publishedAt,
    scopeRevisions: _scopeRevisions,
    semanticUnitRevisions: _semanticUnitRevisions,
    chunkRevisions: _chunkRevisions,
    chunkBindings: _chunkBindings,
    ...content
  } = manifest;
  return content;
}

function unitContentKeys(
  view: PublishedDocumentContentView,
): readonly string[] {
  const digestByBlockId = blockDigests(view.document);
  return view.semanticUnits
    .map((unit) => unitContentKey(unit, digestByBlockId))
    .sort();
}

function chunkContentKeys(
  view: PublishedDocumentContentView,
): readonly string[] {
  const digestByBlockId = blockDigests(view.document);
  const keyByUnitId = new Map(
    view.semanticUnits.map((unit) => [
      unit.id,
      unitContentKey(unit, digestByBlockId),
    ]),
  );
  return view.chunks
    .map((chunk) =>
      canonicalJson({
        unit: keyByUnitId.get(chunk.semanticUnitId) ?? null,
        ordinal: chunk.ordinal,
        splitKind: chunk.splitKind,
        text: chunk.text,
        contentDigest: chunk.contentDigest,
        tokenCount: chunk.tokenCount,
        slices: chunk.sourceSlices.map((slice) => ({
          block: digestByBlockId.get(slice.blockId) ?? null,
          startOffset: slice.startOffset,
          endOffset: slice.endOffset,
          separatorBefore: slice.separatorBefore,
        })),
      }),
    )
    .sort();
}

function unitContentKey(
  unit: DocumentSemanticUnit,
  digestByBlockId: ReadonlyMap<string, string>,
): string {
  return canonicalJson({
    kind: unit.kind,
    title: unit.title ?? null,
    boundary: unit.boundary,
    contentDigest: unit.contentDigest,
    blocks: unit.blockIds.map((blockId) => digestByBlockId.get(blockId) ?? null),
  });
}

function blockDigests(
  document: NormalizedDocument,
): ReadonlyMap<string, string> {
  return new Map(document.blocks.map((block) => [block.id, block.contentDigest]));
}

/** Validates one persisted or newly captured indexing baseline. */
export function assertValidDocumentIndexingSnapshot(
  snapshot: DocumentIndexingSnapshot,
  side: "current" | "previous" = "current",
): void {
  let indexingPolicy: DocumentIndexingPolicySet;
  try {
    indexingPolicy = parseDocumentIndexingPolicy(snapshot.indexingPolicy);
  } catch {
    throw new DocumentIncrementalUpdateError(
      side === "current"
        ? "invalid_current_snapshot"
        : "invalid_previous_snapshot",
    );
  }
  const invalid =
    snapshot.payloadSchemaVersion !== 2 ||
    validateEmbeddingProfile(snapshot.embeddingProfile).length > 0 ||
    validateNormalizedDocument(snapshot.document).length > 0 ||
    validateDocumentSemanticUnits(snapshot.document, snapshot.semanticUnits)
      .length > 0 ||
    validateManagedChunks(
      snapshot.document,
      snapshot.semanticUnits,
      snapshot.chunks,
      indexingPolicy,
    ).length > 0;
  if (invalid) {
    throw new DocumentIncrementalUpdateError(
      side === "current"
        ? "invalid_current_snapshot"
        : "invalid_previous_snapshot",
    );
  }
  if (snapshot.document.completeness.status !== "complete") {
    throw new DocumentIncrementalUpdateError("incomplete_snapshot");
  }
  const unitPolicyVersions = new Set(
    snapshot.semanticUnits.map((unit) => unit.segmentationPolicyVersion),
  );
  const chunkPolicyVersions = new Set(
    snapshot.chunks.map((chunk) => chunk.chunkPolicyVersion),
  );
  const textMeasureVersions = new Set(
    snapshot.chunks.map((chunk) => chunk.textMeasureProfileVersion),
  );
  if (
    unitPolicyVersions.size > 1 ||
    chunkPolicyVersions.size > 1 ||
    textMeasureVersions.size > 1 ||
    [...unitPolicyVersions].some(
      (version) => version !== indexingPolicy.segmentation.version,
    ) ||
    [...chunkPolicyVersions].some(
      (version) => version !== indexingPolicy.chunk.version,
    ) ||
    [...textMeasureVersions].some(
      (version) =>
        version !== indexingPolicy.textMeasureProfile.version ||
        version !== snapshot.embeddingProfile.textMeasureProfileVersion,
    )
  ) {
    throw new DocumentIncrementalUpdateError(
      side === "current"
        ? "invalid_current_snapshot"
        : "invalid_previous_snapshot",
    );
  }
}

function assertSameDocument(
  previous: DocumentIndexingSnapshot,
  current: DocumentIndexingSnapshot,
): void {
  if (
    previous.document.sourceId !== current.document.sourceId ||
    previous.document.documentId !== current.document.documentId
  ) {
    throw new DocumentIncrementalUpdateError("mismatched_document_identity");
  }
}

function fullRebuildReasons(
  previous: DocumentIndexingSnapshot,
  current: DocumentIndexingSnapshot,
): readonly DocumentFullRebuildReason[] {
  const reasons = new Set<DocumentFullRebuildReason>();
  const left = previous.document;
  const right = current.document;
  if (left.schemaVersion !== right.schemaVersion) {
    reasons.add("document_schema_changed");
  }
  if (left.mediaType !== right.mediaType) {
    reasons.add("media_type_changed");
  }
  if (
    left.parser.id !== right.parser.id ||
    left.parser.version !== right.parser.version
  ) {
    reasons.add("parser_changed");
  }
  if (left.normalizationPolicyVersion !== right.normalizationPolicyVersion) {
    reasons.add("normalization_policy_changed");
  }
  if (left.lineagePolicyVersion !== right.lineagePolicyVersion) {
    reasons.add("lineage_policy_changed");
  }
  if (
    canonicalJson(previous.indexingPolicy.lineage) !==
    canonicalJson(current.indexingPolicy.lineage)
  ) {
    reasons.add("lineage_policy_changed");
  }
  if (
    canonicalJson(previous.indexingPolicy.segmentation) !==
    canonicalJson(current.indexingPolicy.segmentation)
  ) {
    reasons.add("segmentation_policy_changed");
  }
  if (
    canonicalJson(previous.indexingPolicy.chunk) !==
    canonicalJson(current.indexingPolicy.chunk)
  ) {
    reasons.add("chunk_policy_changed");
  }
  if (
    canonicalJson(previous.indexingPolicy.textMeasureProfile) !==
    canonicalJson(current.indexingPolicy.textMeasureProfile)
  ) {
    reasons.add("text_measure_profile_changed");
  }
  if (!embeddingProfilesMatch(previous.embeddingProfile, current.embeddingProfile)) {
    reasons.add("embedding_profile_changed");
  }
  if (previous.payloadSchemaVersion !== current.payloadSchemaVersion) {
    reasons.add("payload_schema_changed");
  }
  return [...reasons].sort();
}

function fullRebuildPlan(
  previous: DocumentIndexingSnapshot | undefined,
  current: DocumentIndexingSnapshot,
  reasons: readonly DocumentFullRebuildReason[],
): DocumentIncrementalUpdatePlan {
  const canInheritChunkIdentity =
    previous !== undefined &&
    reasons.every(
      (reason) =>
        reason === "embedding_profile_changed" ||
        reason === "payload_schema_changed",
    );
  const chunks = canInheritChunkIdentity
    ? reconcileChunkIdentities(previous, current)
    : current.chunks;
  const embed = chunks.map(plannedChunkRevision);
  const remove = previous?.chunks.map(plannedChunkRevision) ?? [];
  return createPlan({
    strategy: "full_rebuild",
    rebuildReasons: [...reasons].sort(),
    previous,
    current,
    blockChanges:
      previous === undefined
        ? current.document.blocks.map((block) => ({
            kind: "added" as const,
            blockId: block.id,
            currentOrder: block.order,
          }))
        : classifyBlockChanges(
            previous.document.blocks,
            current.document.blocks,
          ),
    semanticUnitChanges:
      previous === undefined
        ? current.semanticUnits.map((unit) => ({
            kind: "added" as const,
            unitId: unit.id,
            currentRevisionId: unit.revisionId,
          }))
        : classifySemanticUnitChanges(
            previous.semanticUnits,
            current.semanticUnits,
          ),
    chunks,
    operations: { embed, reuse: [], upsert: embed, delete: remove },
  });
}

function classifyBlockChanges(
  previous: readonly DocumentBlock[],
  current: readonly DocumentBlock[],
): readonly DocumentBlockChange[] {
  const previousById = new Map(previous.map((block) => [block.id, block]));
  const currentById = new Map(current.map((block) => [block.id, block]));
  const stableIds = patienceAnchors(previous, current);
  const currentChanges = current.map((block): DocumentBlockChange => {
    const prior = previousById.get(block.id);
    if (prior === undefined) {
      return { kind: "added", blockId: block.id, currentOrder: block.order };
    }
    const moved = !stableIds.has(block.id);
    if (!blockContentEquivalent(prior, block)) {
      return {
        kind: "modified",
        blockId: block.id,
        previousRevisionId: prior.revisionId,
        currentRevisionId: block.revisionId,
        previousOrder: prior.order,
        currentOrder: block.order,
        moved,
      };
    }
    return moved
      ? {
          kind: "moved",
          blockId: block.id,
          previousOrder: prior.order,
          currentOrder: block.order,
        }
      : {
          kind: "unchanged",
          blockId: block.id,
          previousOrder: prior.order,
          currentOrder: block.order,
        };
  });
  const removed = previous
    .filter((block) => !currentById.has(block.id))
    .map((block): DocumentBlockChange => ({
      kind: "removed",
      blockId: block.id,
      previousOrder: block.order,
    }));
  return [...currentChanges, ...removed];
}

function blockContentEquivalent(
  previous: DocumentBlock,
  current: DocumentBlock,
): boolean {
  return (
    previous.kind === current.kind &&
    previous.contentDigest === current.contentDigest &&
    previous.analysisText === current.analysisText &&
    canonicalJson(previous.structure) === canonicalJson(current.structure)
  );
}

/** Unique logical IDs become Patience anchors; the LIS separates insertion
 * shifts from actual moves without guessing between duplicate content. */
function patienceAnchors(
  previous: readonly DocumentBlock[],
  current: readonly DocumentBlock[],
): ReadonlySet<string> {
  const previousIndex = new Map(
    previous.map((block, index) => [block.id, index]),
  );
  const sequence = current.flatMap((block) => {
    const index = previousIndex.get(block.id);
    return index === undefined ? [] : [{ id: block.id, index }];
  });
  if (sequence.length === 0) {
    return new Set();
  }
  const tails: number[] = [];
  const predecessors = sequence.map(() => -1);
  for (let index = 0; index < sequence.length; index += 1) {
    const entry = sequence[index];
    if (entry === undefined) {
      continue;
    }
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const tail = sequence[tails[middle] ?? -1];
      if (tail !== undefined && tail.index < entry.index) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    if (low > 0) {
      predecessors[index] = tails[low - 1] ?? -1;
    }
    tails[low] = index;
  }
  const anchors = new Set<string>();
  let index = tails.at(-1) ?? -1;
  while (index >= 0) {
    const entry = sequence[index];
    if (entry === undefined) {
      break;
    }
    anchors.add(entry.id);
    index = predecessors[index] ?? -1;
  }
  return anchors;
}

function classifySemanticUnitChanges(
  previous: readonly DocumentSemanticUnit[],
  current: readonly DocumentSemanticUnit[],
): readonly DocumentSemanticUnitChange[] {
  const previousById = new Map(previous.map((unit) => [unit.id, unit]));
  const currentById = new Map(current.map((unit) => [unit.id, unit]));
  return [
    ...current.map((unit): DocumentSemanticUnitChange => {
      const prior = previousById.get(unit.id);
      if (prior === undefined) {
        return {
          kind: "added",
          unitId: unit.id,
          currentRevisionId: unit.revisionId,
        };
      }
      return prior.revisionId === unit.revisionId
        ? { kind: "unchanged", unitId: unit.id, revisionId: unit.revisionId }
        : {
            kind: "updated",
            unitId: unit.id,
            previousRevisionId: prior.revisionId,
            currentRevisionId: unit.revisionId,
          };
    }),
    ...previous
      .filter((unit) => !currentById.has(unit.id))
      .map((unit): DocumentSemanticUnitChange => ({
        kind: "removed",
        unitId: unit.id,
        previousRevisionId: unit.revisionId,
      })),
  ];
}

function reconcileChunkIdentities(
  previous: DocumentIndexingSnapshot,
  current: DocumentIndexingSnapshot,
): readonly ManagedChunk[] {
  const matches = matchChunks(previous, current);
  const finalIdByCurrentId = new Map(
    matches.map(({ currentId, previousId }) => [currentId, previousId]),
  );
  const finalId = (id: string): string => finalIdByCurrentId.get(id) ?? id;
  const chunks = current.chunks.map((chunk): ManagedChunk => {
    const common = {
      id: finalId(chunk.id),
      sourceId: chunk.sourceId,
      observationId: chunk.observationId,
      documentId: chunk.documentId,
      semanticUnitId: chunk.semanticUnitId,
      ordinal: chunk.ordinal,
      sourceSlices: chunk.sourceSlices,
      text: chunk.text,
      contentDigest: chunk.contentDigest,
      tokenCount: chunk.tokenCount,
      textMeasureProfileVersion: chunk.textMeasureProfileVersion,
      chunkPolicyVersion: chunk.chunkPolicyVersion,
      splitKind: chunk.splitKind,
    } as const;
    return {
      ...common,
      revisionId: createManagedChunkRevisionId(common),
      ...(chunk.previousChunkId === undefined
        ? {}
        : { previousChunkId: finalId(chunk.previousChunkId) }),
      ...(chunk.nextChunkId === undefined
        ? {}
        : { nextChunkId: finalId(chunk.nextChunkId) }),
    };
  });
  if (
    new Set(chunks.map((chunk) => chunk.id)).size !== chunks.length ||
    validateManagedChunks(
      current.document,
      current.semanticUnits,
      chunks,
      current.indexingPolicy,
    )
      .length > 0
  ) {
    throw new DocumentIncrementalUpdateError("invalid_current_snapshot");
  }
  return chunks;
}

interface ChunkMatch {
  readonly currentId: string;
  readonly previousId: string;
}

function matchChunks(
  previous: DocumentIndexingSnapshot,
  current: DocumentIndexingSnapshot,
): readonly ChunkMatch[] {
  const matches: ChunkMatch[] = [];
  const matchedCurrent = new Set<string>();
  const matchedPrevious = new Set<string>();
  matchUniqueChunks(
    previous,
    current,
    matches,
    matchedPrevious,
    matchedCurrent,
    (snapshot, chunk) => chunkBoundaryKey(snapshot.document, chunk),
  );
  matchUniqueChunks(
    previous,
    current,
    matches,
    matchedPrevious,
    matchedCurrent,
    (_snapshot, chunk) =>
      canonicalJson({
        semanticUnitId: chunk.semanticUnitId,
        contentDigest: chunk.contentDigest,
        splitKind: chunk.splitKind,
      }),
  );
  return matches;
}

function matchUniqueChunks(
  previous: DocumentIndexingSnapshot,
  current: DocumentIndexingSnapshot,
  matches: ChunkMatch[],
  matchedPrevious: Set<string>,
  matchedCurrent: Set<string>,
  key: (snapshot: DocumentIndexingSnapshot, chunk: ManagedChunk) => string,
): void {
  const previousGroups = groupBy(
    previous.chunks.filter((chunk) => !matchedPrevious.has(chunk.id)),
    (chunk) => key(previous, chunk),
  );
  const currentGroups = groupBy(
    current.chunks.filter((chunk) => !matchedCurrent.has(chunk.id)),
    (chunk) => key(current, chunk),
  );
  for (const [candidateKey, currentGroup] of currentGroups) {
    const previousGroup = previousGroups.get(candidateKey);
    const currentChunk = currentGroup[0];
    const previousChunk = previousGroup?.[0];
    if (
      currentGroup.length !== 1 ||
      previousGroup?.length !== 1 ||
      currentChunk === undefined ||
      previousChunk === undefined
    ) {
      continue;
    }
    matches.push({
      currentId: currentChunk.id,
      previousId: previousChunk.id,
    });
    matchedCurrent.add(currentChunk.id);
    matchedPrevious.add(previousChunk.id);
  }
}

function chunkBoundaryKey(
  document: NormalizedDocument,
  chunk: ManagedChunk,
): string {
  const blockById = new Map(document.blocks.map((block) => [block.id, block]));
  return canonicalJson({
    semanticUnitId: chunk.semanticUnitId,
    splitKind: chunk.splitKind,
    sourceSlices: chunk.sourceSlices.map((slice) => {
      const block = blockById.get(slice.blockId);
      return {
        blockId: slice.blockId,
        startOffset: slice.startOffset,
        endOffset:
          block !== undefined && slice.endOffset === block.text.length
            ? "block_end"
            : slice.endOffset,
        separatorBefore: slice.separatorBefore,
      };
    }),
  });
}

function incrementalOperations(
  previous: readonly ManagedChunk[],
  current: readonly ManagedChunk[],
): DocumentIncrementalUpdateOperations {
  const previousByRevision = new Map(
    previous.map((chunk) => [chunk.revisionId, chunk]),
  );
  const currentRevisionIds = new Set(current.map((chunk) => chunk.revisionId));
  const reuse: PlannedChunkRevision[] = [];
  const embed: PlannedChunkRevision[] = [];
  for (const chunk of current) {
    (previousByRevision.has(chunk.revisionId) ? reuse : embed).push(
      plannedChunkRevision(chunk),
    );
  }
  const remove = previous
    .filter((chunk) => !currentRevisionIds.has(chunk.revisionId))
    .map(plannedChunkRevision);
  return { embed, reuse, upsert: embed, delete: remove };
}

function createPlan(input: {
  readonly strategy: DocumentIncrementalUpdatePlan["strategy"];
  readonly rebuildReasons: readonly DocumentFullRebuildReason[];
  readonly previous: DocumentIndexingSnapshot | undefined;
  readonly current: DocumentIndexingSnapshot;
  readonly blockChanges: readonly DocumentBlockChange[];
  readonly semanticUnitChanges: readonly DocumentSemanticUnitChange[];
  readonly chunks: readonly ManagedChunk[];
  readonly operations: DocumentIncrementalUpdateOperations;
}): DocumentIncrementalUpdatePlan {
  const changedBlockCount = input.blockChanges.filter(
    (change) => change.kind !== "unchanged" && change.kind !== "moved",
  ).length;
  return {
    strategy: input.strategy,
    rebuildReasons: input.rebuildReasons,
    blockChanges: input.blockChanges,
    semanticUnitChanges: input.semanticUnitChanges,
    chunks: input.chunks,
    affectedChunkClosure: {
      previousChunkIds: input.operations.delete.map((chunk) => chunk.chunkId),
      currentChunkIds: input.operations.upsert.map((chunk) => chunk.chunkId),
    },
    operations: input.operations,
    metrics: {
      previousBlockCount: input.previous?.document.blocks.length ?? 0,
      currentBlockCount: input.current.document.blocks.length,
      changedBlockCount,
      previousChunkCount: input.previous?.chunks.length ?? 0,
      currentChunkCount: input.chunks.length,
      embeddingCallCount: input.operations.embed.length,
      reusedEmbeddingCount: input.operations.reuse.length,
      upsertCount: input.operations.upsert.length,
      deleteCount: input.operations.delete.length,
    },
  };
}

function plannedChunkRevision(chunk: ManagedChunk): PlannedChunkRevision {
  return {
    chunkId: chunk.id,
    chunkRevisionId: chunk.revisionId,
    contentDigest: chunk.contentDigest,
  };
}

function groupBy<T>(
  values: readonly T[],
  key: (value: T) => string,
): ReadonlyMap<string, readonly T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const groupKey = key(value);
    const group = groups.get(groupKey) ?? [];
    group.push(value);
    groups.set(groupKey, group);
  }
  return groups;
}
