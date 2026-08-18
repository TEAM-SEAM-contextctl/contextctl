import { beforeEach, describe, expect, it } from "vitest";

import {
  buildMarkdownPublication,
  createDocumentIndexId,
  DEFAULT_DOCUMENT_INDEXING_POLICY,
  DeterministicEmbeddingAdapter,
  documentIndexEquivalenceViolations,
  DocumentIndexPublisher,
  EmbeddingPipeline,
  EmbeddingPipelineError,
  EmbeddingProviderFault,
  generateManagedChunks,
  IncrementalDocumentReindexer,
  InMemoryIndexPublicationStoreV2,
  InMemoryIndexStagingAttemptStore,
  InMemoryVectorIndexAdapter,
  MarkdownCapture,
  reconcileSemanticUnitLineage,
  RemarkMarkdownParser,
  segmentNormalizedDocument,
  sha256Digest,
  VectorIndexFault,
  type BlockIdSource,
  type DocumentIndexingSnapshot,
  type EmbeddingPort,
  type EmbeddingProfile,
  type EmbeddingProviderRequest,
  type ManagedChunkIdSource,
  type PublishedDocumentContentView,
  type ReindexDocumentCommand,
  type SemanticUnitIdSource,
  type VectorIndexPort,
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

const STATE_NAMESPACE_ID = "reindex-test";
const CONNECTOR_ID = "vector.local";
const SECURITY_DOMAIN = "local";

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

const MODIFIED = INITIAL.replace(
  "Retry failed payments after five minutes.",
  "Retry failed payments after ten minutes.",
);


const SECTION_REMOVED = [
  "# Payments",
  "",
  "Retry failed payments after five minutes.",
  "",
  "# Deployments",
  "",
  "Rollback the release when health checks fail.",
].join("\n");

describe("incremental reindex publication", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it("embeds only the affected Chunks and copies every unchanged vector", async () => {
    const previous = createSnapshot(INITIAL, "previous");
    const current = createSnapshot(MODIFIED, "current", previous);
    await harness.reindex({ current: previous });

    harness.provider.resetCounters();
    const result = await harness.reindex({ previous, current });

    expect(result.status).toBe("published");
    expect(result.plan.strategy).toBe("incremental");
    expect(result.metrics.embeddedChunkCount).toBe(
      result.metrics.plannedEmbeddingCallCount,
    );
    expect(result.metrics.embeddedChunkCount).toBeLessThan(
      current.chunks.length,
    );
    expect(result.metrics.reusedVectorCount).toBe(
      current.chunks.length - result.metrics.embeddedChunkCount,
    );
    expect(result.metrics.discardedVectorCount).toBe(0);
    expect(result.metrics.reuseDegradation).toBeUndefined();
    expect(harness.provider.embeddedKeys).toHaveLength(
      result.metrics.embeddedChunkCount,
    );
  });

  it("keeps removed Chunk revisions out of the new current Index", async () => {
    const previous = createSnapshot(INITIAL, "previous");
    const current = createSnapshot(SECTION_REMOVED, "current", previous);
    await harness.reindex({ current: previous });

    const result = await harness.reindex({ previous, current });

    expect(result.metrics.removedChunkRevisionIds.length).toBeGreaterThan(0);
    const publishedRevisions = new Set(
      Object.values(result.publication.manifest.chunkRevisions),
    );
    for (const revisionId of result.metrics.removedChunkRevisionIds) {
      expect(publishedRevisions.has(revisionId)).toBe(false);
    }
    const stored = await harness.vectorIndex.listVersionRecords({
      accessHandle: result.publication.binding.accessHandle,
      documentIndexId: result.publication.manifest.documentIndexId,
      indexVersion: result.publication.manifest.indexVersion,
    });
    expect(stored.map((record) => record.metadata.chunkRevisionId).sort()).toEqual(
      [...publishedRevisions].sort(),
    );
  });

  it("produces an Index logically equivalent to a cold full rebuild", async () => {
    const previous = createSnapshot(INITIAL, "previous");
    const current = createSnapshot(MODIFIED, "current", previous);
    await harness.reindex({ current: previous });
    const incremental = await harness.reindex({ previous, current });

    // Same Observation, no baseline: fresh Block, Unit and Chunk identities.
    const coldSnapshot = createSnapshot(MODIFIED, "rebuild", undefined, PROFILE, "current");
    const rebuilt = await createHarness().reindex({ current: coldSnapshot });

    expect(rebuilt.plan.strategy).toBe("full_rebuild");
    expect(incremental.publication.manifest.indexVersion).not.toBe(
      rebuilt.publication.manifest.indexVersion,
    );
    expect(
      documentIndexEquivalenceViolations(
        contentView(incremental.publication.manifest, current, incremental.plan.chunks),
        contentView(rebuilt.publication.manifest, coldSnapshot, rebuilt.plan.chunks),
      ),
    ).toEqual([]);
  });

  it("keeps serving the previous Index when embedding fails midway", async () => {
    const previous = createSnapshot(INITIAL, "previous");
    const current = createSnapshot(MODIFIED, "current", previous);
    const first = await harness.reindex({ current: previous });
    const documentIndexId = createDocumentIndexId(
      current.document.sourceId,
      current.document.documentId,
    );

    harness.provider.failNext = true;
    await expect(harness.reindex({ previous, current })).rejects.toBeInstanceOf(
      EmbeddingPipelineError,
    );

    const head = await harness.publications.current(documentIndexId);
    expect(head?.manifest.indexVersion).toBe(
      first.publication.manifest.indexVersion,
    );
  });

  it("is idempotent on retry and calls no provider the second time", async () => {
    const previous = createSnapshot(INITIAL, "previous");
    const current = createSnapshot(MODIFIED, "current", previous);
    await harness.reindex({ current: previous });
    const published = await harness.reindex({ previous, current });

    harness.provider.resetCounters();
    const retried = await harness.reindex({ previous, current });

    expect(retried.status).toBe("already_published");
    expect(retried.publication.manifest.indexVersion).toBe(
      published.publication.manifest.indexVersion,
    );
    expect(harness.provider.embeddedKeys).toEqual([]);
    expect(retried.metrics.embeddedChunkCount).toBe(0);
    expect(retried.metrics.reusedVectorCount).toBe(current.chunks.length);
  });

  it("inherits Scopes only for Units whose Chunk revisions are unchanged", async () => {
    const previous = createSnapshot(INITIAL, "previous");
    const current = createSnapshot(MODIFIED, "current", previous);
    await harness.reindex({ current: previous });

    const result = await harness.reindex({ previous, current });

    const changedUnitIds = result.plan.semanticUnitChanges
      .filter((change) => change.kind !== "unchanged")
      .map((change) => change.unitId);
    expect(changedUnitIds.length).toBeGreaterThan(0);
    expect(result.inheritableUnitIds.length).toBeGreaterThan(0);
    for (const unitId of changedUnitIds) {
      expect(result.inheritableUnitIds).not.toContain(unitId);
    }
    const previousRevisions = revisionsByUnit(previous.chunks);
    for (const unitId of result.inheritableUnitIds) {
      expect(revisionsByUnit(result.plan.chunks).get(unitId)).toEqual(
        previousRevisions.get(unitId),
      );
    }
  });

  it("declares no Registry change for Units the edit did not touch", async () => {
    const previous = createSnapshot(INITIAL, "previous");
    const current = createSnapshot(MODIFIED, "current", previous);
    const first = await harness.reindex({ current: previous });
    const initialPublication = buildMarkdownPublication({
      document: previous.document,
      semanticUnits: previous.semanticUnits,
      manifest: first.publication.manifest,
      scopes: first.publication.scopes,
    });

    const second = await harness.reindex({ previous, current });
    const publication = buildMarkdownPublication({
      document: current.document,
      semanticUnits: current.semanticUnits,
      manifest: second.publication.manifest,
      scopes: second.publication.scopes,
      previous: initialPublication,
      previousSemanticUnits: previous.semanticUnits,
      inheritableUnitIds: second.inheritableUnitIds,
    });

    expect(second.inheritableUnitIds.length).toBeGreaterThan(0);
    const changedIds = publication.changes.map((change) => change.knowledgeUnitId);
    for (const unitId of second.inheritableUnitIds) {
      expect(changedIds).not.toContain(unitId);
    }
    // An inherited Unit keeps its predecessor Scope, so its Card sees no
    // `scope.document.indexVersionChanged` either.
    const inherited = new Set(second.inheritableUnitIds);
    const previousById = new Map(
      initialPublication.knowledgeUnits.map((unit) => [unit.id, unit]),
    );
    for (const unit of publication.knowledgeUnits) {
      if (inherited.has(unit.id)) {
        expect(unit.publishedScopes).toEqual(
          previousById.get(unit.id)?.publishedScopes,
        );
      }
    }
  });

  it("rebuilds fully and reuses nothing when the Embedding Profile changes", async () => {
    const previous = createSnapshot(INITIAL, "previous");
    const current = createSnapshot(INITIAL, "current", previous, {
      ...PROFILE,
      version: "2",
    });
    await harness.reindex({ current: previous });

    harness.provider.resetCounters();
    const result = await harness.reindex({ previous, current });

    expect(result.plan.strategy).toBe("full_rebuild");
    expect(result.plan.rebuildReasons).toEqual(["embedding_profile_changed"]);
    expect(result.metrics.reuseDegradation).toBe("incompatible_profile");
    expect(result.metrics.reusedVectorCount).toBe(0);
    expect(harness.provider.embeddedKeys).toHaveLength(current.chunks.length);
  });

  it("degrades to full embedding when published vectors cannot be read", async () => {
    const previous = createSnapshot(INITIAL, "previous");
    const current = createSnapshot(MODIFIED, "current", previous);
    await harness.reindex({ current: previous });

    harness.vectorIndex.failVectorReads = true;
    harness.provider.resetCounters();
    const result = await harness.reindex({ previous, current });

    expect(result.status).toBe("published");
    expect(result.metrics.reuseDegradation).toBe("binding_unavailable");
    expect(result.metrics.reusedVectorCount).toBe(0);
    expect(harness.provider.embeddedKeys).toHaveLength(current.chunks.length);
  });
});

interface Harness {
  readonly provider: CountingEmbeddingProvider;
  readonly vectorIndex: FaultyVectorIndex;
  readonly publications: InMemoryIndexPublicationStoreV2;
  reindex(
    input: Pick<ReindexDocumentCommand, "previous" | "current">,
  ): ReturnType<IncrementalDocumentReindexer["reindex"]>;
}

function createHarness(): Harness {
  const provider = new CountingEmbeddingProvider();
  const vectorIndex = new FaultyVectorIndex(new InMemoryVectorIndexAdapter());
  const publications = new InMemoryIndexPublicationStoreV2();
  const reindexer = new IncrementalDocumentReindexer({
    vectorIndex,
    publications,
    embeddingPipeline: new EmbeddingPipeline({ provider }),
    indexPublisher: new DocumentIndexPublisher({
      vectorIndex,
      publications,
      stagingAttempts: new InMemoryIndexStagingAttemptStore(),
      clock: () => "2026-08-17T00:00:00.000Z",
    }),
  });
  return {
    provider,
    vectorIndex,
    publications,
    reindex: (input) =>
      reindexer.reindex({
        stateNamespaceId: STATE_NAMESPACE_ID,
        connectorId: CONNECTOR_ID,
        securityDomain: SECURITY_DOMAIN,
        ...(input.previous === undefined ? {} : { previous: input.previous }),
        current: input.current,
        semanticScopes: input.current.semanticUnits
          .filter((unit) => unit.kind !== "document")
          .map((unit) => ({ semanticUnitIds: [unit.id] })),
      }),
  };
}

class CountingEmbeddingProvider implements EmbeddingPort {
  readonly providerKind = "test" as const;
  embeddedKeys: string[] = [];
  failNext = false;

  readonly #delegate = new DeterministicEmbeddingAdapter();

  resetCounters(): void {
    this.embeddedKeys = [];
  }

  async embed(request: EmbeddingProviderRequest) {
    if (this.failNext) {
      this.failNext = false;
      throw new EmbeddingProviderFault("provider_unavailable", false);
    }
    this.embeddedKeys.push(...request.inputs.map((input) => input.key));
    return this.#delegate.embed(request);
  }
}

class FaultyVectorIndex implements VectorIndexPort {
  failVectorReads = false;

  constructor(private readonly delegate: VectorIndexPort) {}

  prepare: VectorIndexPort["prepare"] = (input) => this.delegate.prepare(input);
  rehydrate: VectorIndexPort["rehydrate"] = (input) =>
    this.delegate.rehydrate(input);
  upsertRecords: VectorIndexPort["upsertRecords"] = (input) =>
    this.delegate.upsertRecords(input);
  listVersionRecords: VectorIndexPort["listVersionRecords"] = (input) =>
    this.delegate.listVersionRecords(input);
  search: VectorIndexPort["search"] = (input) => this.delegate.search(input);
  retainVersion: VectorIndexPort["retainVersion"] = (input) =>
    this.delegate.retainVersion(input);
  releaseRetentionLease: VectorIndexPort["releaseRetentionLease"] = (input) =>
    this.delegate.releaseRetentionLease(input);
  deleteVersion: VectorIndexPort["deleteVersion"] = (input) =>
    this.delegate.deleteVersion(input);

  async readVersionVectors(
    input: Parameters<VectorIndexPort["readVersionVectors"]>[0],
  ) {
    if (this.failVectorReads) {
      throw new VectorIndexFault("storage_unavailable", true);
    }
    return this.delegate.readVersionVectors(input);
  }
}

function contentView(
  manifest: PublishedDocumentContentView["manifest"],
  snapshot: DocumentIndexingSnapshot,
  chunks: PublishedDocumentContentView["chunks"],
): PublishedDocumentContentView {
  return {
    manifest,
    document: snapshot.document,
    semanticUnits: snapshot.semanticUnits,
    chunks,
  };
}

function revisionsByUnit(
  chunks: PublishedDocumentContentView["chunks"],
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

function createSnapshot(
  content: string,
  seed: string,
  previous?: DocumentIndexingSnapshot,
  embeddingProfile: EmbeddingProfile = PROFILE,
  observationSeed: string = seed,
): DocumentIndexingSnapshot {
  const observationId = `obs_${observationSeed}`;
  const capture = new MarkdownCapture({
    parser: new RemarkMarkdownParser(),
    ids: sequentialBlockIds(seed),
  });
  const document = capture.capture({
    source: { id: "src_incremental", targetKey: "file:/runbook.md" },
    observationId,
    documentId: "doc_runbook",
    snapshot: {
      kind: "markdown",
      targetKey: "file:/runbook.md",
      capturedAt: "2026-08-16T00:00:00.000Z",
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
    embeddingProfile,
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
