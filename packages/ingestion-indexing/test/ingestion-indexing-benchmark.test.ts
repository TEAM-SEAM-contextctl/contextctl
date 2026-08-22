import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { arch, cpus, platform, totalmem } from "node:os";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  createDocumentIndexId,
  createVectorRecordId,
  DEFAULT_DOCUMENT_INDEXING_POLICY,
  DeterministicEmbeddingAdapter,
  documentIndexEquivalenceViolations,
  DocumentIndexPublisher,
  EmbeddingPipeline,
  generateManagedChunks,
  IncrementalDocumentReindexer,
  InMemoryIndexPublicationStore,
  InMemoryIndexStagingAttemptStore,
  InMemoryVectorIndexAdapter,
  MarkdownCapture,
  QdrantVectorIndexAdapter,
  reconcileSemanticUnitLineage,
  RemarkMarkdownParser,
  segmentNormalizedDocument,
  sha256Digest,
  type BlockIdSource,
  type DocumentIndexingSnapshot,
  type EmbeddingPort,
  type EmbeddingProfile,
  type EmbeddingProviderRequest,
  type ManagedChunkIdSource,
  type PublishedDocumentContentView,
  type ReindexDocumentCommand,
  type SemanticUnitIdSource,
  type VectorIndexRecord,
} from "../src/index.js";
import {
  evaluateBoundaries,
  type BoundaryMetrics,
} from "./fixtures/semantic-segmentation-fixture.js";
import {
  percentile,
} from "./fixtures/document-retrieval-eval.js";
import { rootId, structuralId } from "./fixtures/root-id-fixture.js";

const CORPUS_FILE = fileURLToPath(
  new URL(
    "./fixtures/ingestion-indexing-benchmark-v1/corpus.json",
    import.meta.url,
  ),
);

const PROFILE: EmbeddingProfile = {
  id: "ingestion-indexing-benchmark-deterministic-v1",
  version: "1",
  model: "deterministic-benchmark-only",
  dimensions: 64,
  distance: "cosine",
  maxInputTokens: 480,
  textMeasureProfileVersion: "unicode-estimate-v1",
};
const STATE_NAMESPACE_ID = "state_ingestion_benchmark_v1";
const SECURITY_DOMAIN = "ingestion-benchmark";
const CONNECTOR_ID = "vector.benchmark";
const BOUNDARY_F1_GATE = 0.9;
const BOUNDARY_PK_GATE = 0.1;
const BOUNDARY_WINDOW_DIFF_GATE = 0.1;
const FILTERED_ANN_RECALL_GATE = 0.95;
const DOCUMENT_RECALL_AT_5_GATE = 0.9;
const DOCUMENT_MRR_AT_10_GATE = 0.75;
const DOCUMENT_WARM_QUERY_P95_MS_GATE = 100;
const DOCUMENT_PEAK_RSS_MIB_GATE = 1024;

interface BenchmarkDocumentFixture {
  readonly id: string;
  readonly identityExpectation: "stable" | "ambiguous_duplicates";
  readonly initial: string;
  readonly modified: string;
  readonly expectedBoundaryBlockOrders: readonly number[];
}

interface BenchmarkCorpus {
  readonly schemaVersion: 1;
  readonly datasetId: string;
  readonly version: string;
  readonly description: string;
  readonly documents: readonly BenchmarkDocumentFixture[];
  readonly largeDocument: {
    readonly sectionCount: number;
    readonly paragraphsPerSection: number;
    readonly termsPerParagraph: number;
    readonly oversizedEverySections: number;
  };
  readonly filteredAnn: {
    readonly documentCount: number;
    readonly recordsPerDocument: number;
    readonly semanticUnitsPerDocument: number;
    readonly queryCount: number;
    readonly dimensions: number;
    readonly topK: number;
  };
  readonly digest: string;
}

interface DocumentRetrievalEvaluation {
  readonly datasetId: string;
  readonly datasetVersion: string;
  readonly datasetDigest: string;
  readonly profileId: string;
  readonly recallAt5: number;
  readonly mrrAt10: number;
  readonly warmQueryP95Ms: number;
  readonly peakRssMiB: number;
  readonly resourceGatePassed: boolean;
  readonly quantized: boolean;
  readonly missedQueryIds: readonly string[];
}

describe("ingestion-indexing-benchmark-v1", () => {
  it(
    "measures capture, segmentation, incremental indexing and filtered Qdrant search",
    async () => {
      const qdrantUrl = requiredEnvironment("CONTEXTCTL_QDRANT_URL");
      const retrievalResultPath = requiredEnvironment(
        "CONTEXTCTL_DOCUMENT_RETRIEVAL_RESULT_PATH",
      );
      const resultPath = requiredEnvironment(
        "CONTEXTCTL_INGESTION_BENCHMARK_RESULT_PATH",
      );
      const corpus = await loadCorpus();
      const documentRetrieval = await readDocumentRetrievalEvaluation(
        retrievalResultPath,
      );

      const documents = await Promise.all(
        corpus.documents.map((fixture) => benchmarkDocument(fixture)),
      );
      const largeDocument = await benchmarkLargeDocument(corpus.largeDocument);
      const boundary = aggregateBoundaryMetrics(
        documents.map((document) => document.boundary.metrics),
      );
      const incrementalEmbeddingRatio = weightedRatio(
        documents.map((document) => ({
          numerator: document.incremental.embeddedChunkCount,
          denominator: document.incremental.fullRebuildChunkCount,
        })),
      );
      const incrementalSavingsRatio = 1 - incrementalEmbeddingRatio;
      const chunkSizes = documents.flatMap((document) =>
        document.chunking.tokenCounts,
      );
      assertLocalBenchmarkGates(
        documents,
        boundary,
        chunkSizes,
        incrementalSavingsRatio,
      );
      const filteredAnn = await benchmarkFilteredAnn(
        qdrantUrl,
        corpus.filteredAnn,
      );
      const result = {
        schemaVersion: 1,
        benchmarkId: corpus.datasetId,
        benchmarkVersion: corpus.version,
        benchmarkDigest: corpus.digest,
        generatedAt: new Date().toISOString(),
        environment: {
          nodeVersion: process.version,
          platform: `${platform()}-${arch()}`,
          cpuModel: cpus()[0]?.model ?? "unknown",
          totalMemoryMiB: Math.round(totalmem() / 1024 / 1024),
          qdrantVersion: filteredAnn.qdrantVersion,
        },
        capture: {
          documentCount: documents.length,
          coordinateCoverage: mean(
            documents.map((document) => document.capture.coordinateCoverage),
          ),
          textCoverage: mean(
            documents.map((document) => document.capture.textCoverage),
          ),
          acceptedSourceCoverage: mean(
            documents.map(
              (document) => document.capture.acceptedSourceCoverage,
            ),
          ),
          documents: documents.map((document) => ({
            documentId: document.documentId,
            ...document.capture,
          })),
        },
        segmentation: {
          ...boundary,
          documents: documents.map((document) => ({
            documentId: document.documentId,
            ...document.boundary,
          })),
        },
        chunking: {
          chunkCount: chunkSizes.length,
          tokenCount: distribution(chunkSizes),
          fallbackCounts: mergeCounts(
            documents.map((document) => document.chunking.fallbackCounts),
          ),
          documents: documents.map((document) => ({
            documentId: document.documentId,
            ...document.chunking,
          })),
        },
        incremental: {
          embeddingRatio: incrementalEmbeddingRatio,
          savingsRatio: incrementalSavingsRatio,
          documents: documents.map((document) => ({
            documentId: document.documentId,
            ...document.incremental,
          })),
        },
        filteredAnn,
        largeDocument,
        documentRetrieval: {
          ...documentRetrieval,
          fp32NonInferiority: {
            status: "not_applicable",
            reason: "default_profile_is_fp32",
          },
        },
        gates: {
          sourceCoordinateCoverage: 1,
          sourceTextCoverage: 1,
          boundaryF1: BOUNDARY_F1_GATE,
          boundaryPk: BOUNDARY_PK_GATE,
          boundaryWindowDiff: BOUNDARY_WINDOW_DIFF_GATE,
          maxChunkTokens:
            DEFAULT_DOCUMENT_INDEXING_POLICY.chunk.maxChunkTokens,
          filteredAnnRecallAtK: FILTERED_ANN_RECALL_GATE,
          outOfScopeHitCount: 0,
          documentRecallAt5: DOCUMENT_RECALL_AT_5_GATE,
          documentMrrAt10: DOCUMENT_MRR_AT_10_GATE,
          documentWarmQueryP95Ms: DOCUMENT_WARM_QUERY_P95_MS_GATE,
          documentPeakRssMiB: DOCUMENT_PEAK_RSS_MIB_GATE,
        },
      };

      await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
      console.log(JSON.stringify(result, null, 2));

      expect(filteredAnn.recallAtK).toBeGreaterThanOrEqual(
        FILTERED_ANN_RECALL_GATE,
      );
      expect(filteredAnn.outOfScopeHitCount).toBe(0);
      expect(documentRetrieval.recallAt5).toBeGreaterThanOrEqual(
        DOCUMENT_RECALL_AT_5_GATE,
      );
      expect(documentRetrieval.mrrAt10).toBeGreaterThanOrEqual(
        DOCUMENT_MRR_AT_10_GATE,
      );
      expect(documentRetrieval.warmQueryP95Ms).toBeLessThanOrEqual(
        DOCUMENT_WARM_QUERY_P95_MS_GATE,
      );
      expect(documentRetrieval.peakRssMiB).toBeLessThanOrEqual(
        DOCUMENT_PEAK_RSS_MIB_GATE,
      );
      expect(documentRetrieval.resourceGatePassed).toBe(true);
      expect(documentRetrieval.quantized).toBe(false);
    },
    180_000,
  );
});

async function benchmarkDocument(fixture: BenchmarkDocumentFixture) {
  const parser = new RemarkMarkdownParser();
  const candidate = parser.parse(fixture.initial);
  const initial = createSnapshot(fixture, "initial");
  const repeated = captureMarkdown(
    fixture,
    fixture.initial,
    "repeat",
    initial.document,
  );
  const current = createSnapshot(fixture, "modified", initial);
  const predictedBoundaries = boundaryOrders(
    initial.document,
    initial.semanticUnits,
  );
  const boundaryMetrics = evaluateBoundaries(
    fixture.expectedBoundaryBlockOrders,
    predictedBoundaries,
    initial.document.blocks.length,
  );
  const harness = createReindexHarness();
  await harness.reindex({ current: initial });
  const incremental = await harness.reindex({ previous: initial, current });
  const cold = createSnapshot(fixture, "cold", undefined, "modified");
  const rebuilt = await createReindexHarness().reindex({
    current: cold,
  });
  const equivalenceViolations = documentIndexEquivalenceViolations(
    contentView(
      incremental.publication.manifest,
      current,
      incremental.plan.chunks,
    ),
    contentView(rebuilt.publication.manifest, cold, rebuilt.plan.chunks),
  );
  const sourceCoverage = candidate.coverage.reduce(
    (accumulator, coverage) => {
      const length =
        coverage.sourceSpan.endOffset - coverage.sourceSpan.startOffset;
      return {
        accepted:
          accumulator.accepted +
          (coverage.status === "accepted" ? length : 0),
        total: accumulator.total + length,
      };
    },
    { accepted: 0, total: 0 },
  );
  const validCoordinates = initial.document.blocks.filter((block) =>
    sourceCoordinateContainsBlock(fixture.initial, block),
  );
  const coveredText = validCoordinates.reduce(
    (sum, block) => sum + block.text.length,
    0,
  );
  const totalText = initial.document.blocks.reduce(
    (sum, block) => sum + block.text.length,
    0,
  );
  const fallbackCounts = countBy(
    initial.chunks
      .filter((chunk) => chunk.splitKind !== "block_pack")
      .map((chunk) => chunk.splitKind),
  );

  return {
    documentId: fixture.id,
    identityExpectation: fixture.identityExpectation,
    capture: {
      contentDigestStable:
        repeated.contentDigest === initial.document.contentDigest,
      repeatedBlockIdentityRetention: identityRetention(
        initial.document.blocks,
        repeated.blocks,
      ),
      coordinateCoverage:
        initial.document.blocks.length === 0
          ? 1
          : validCoordinates.length / initial.document.blocks.length,
      textCoverage: totalText === 0 ? 1 : coveredText / totalText,
      acceptedSourceCoverage:
        sourceCoverage.total === 0
          ? 1
          : sourceCoverage.accepted / sourceCoverage.total,
      omittedSourceCount: candidate.coverage.filter(
        (coverage) => coverage.status === "omitted",
      ).length,
      uncoveredBlockOrders: initial.document.blocks
        .filter((block) => !validCoordinates.includes(block))
        .map((block) => block.order),
    },
    boundary: {
      expected: fixture.expectedBoundaryBlockOrders,
      predicted: predictedBoundaries,
      falsePositive: predictedBoundaries.filter(
        (boundary) => !fixture.expectedBoundaryBlockOrders.includes(boundary),
      ),
      falseNegative: fixture.expectedBoundaryBlockOrders.filter(
        (boundary) => !predictedBoundaries.includes(boundary),
      ),
      metrics: boundaryMetrics,
    },
    chunking: {
      semanticUnitCount: initial.semanticUnits.length,
      chunkCount: initial.chunks.length,
      tokenCounts: initial.chunks.map((chunk) => chunk.tokenCount),
      tokenCount: distribution(
        initial.chunks.map((chunk) => chunk.tokenCount),
      ),
      fallbackCounts,
    },
    incremental: {
      strategy: incremental.plan.strategy,
      fullRebuildChunkCount: current.chunks.length,
      embeddedChunkCount: incremental.metrics.embeddedChunkCount,
      reusedVectorCount: incremental.metrics.reusedVectorCount,
      embeddingRatio:
        current.chunks.length === 0
          ? 0
          : incremental.metrics.embeddedChunkCount / current.chunks.length,
      savingsRatio:
        current.chunks.length === 0
          ? 0
          : 1 - incremental.metrics.embeddedChunkCount / current.chunks.length,
      blockIdentityRetention: unchangedIdentityRetention(
        initial.document.blocks,
        current.document.blocks,
      ),
      semanticUnitIdentityRetention: unchangedIdentityRetention(
        initial.semanticUnits,
        current.semanticUnits,
      ),
      chunkRevisionRetention: unchangedRevisionRetention(
        initial.chunks,
        incremental.plan.chunks,
      ),
      equivalenceViolations,
    },
  };
}

async function benchmarkLargeDocument(
  configuration: BenchmarkCorpus["largeDocument"],
) {
  const markdown = largeMarkdown(configuration);
  const fixture: BenchmarkDocumentFixture = {
    id: "large-generated",
    identityExpectation: "ambiguous_duplicates",
    initial: markdown,
    modified: markdown,
    expectedBoundaryBlockOrders: [],
  };
  const rssSamples = [rssMiB()];
  const captureStarted = performance.now();
  const document = captureMarkdown(fixture, markdown, "large");
  const captureMs = performance.now() - captureStarted;
  rssSamples.push(rssMiB());

  const segmentationStarted = performance.now();
  const semanticUnits = segmentNormalizedDocument({
    document,
    ids: sequentialUnitIds("large"),
  });
  const segmentationMs = performance.now() - segmentationStarted;
  rssSamples.push(rssMiB());

  const chunkingStarted = performance.now();
  const chunks = generateManagedChunks({
    document,
    semanticUnits,
    ids: sequentialChunkIds("large"),
  });
  const chunkingMs = performance.now() - chunkingStarted;
  rssSamples.push(rssMiB());

  const snapshot: DocumentIndexingSnapshot = {
    document,
    semanticUnits,
    chunks,
    indexingPolicy: DEFAULT_DOCUMENT_INDEXING_POLICY,
    embeddingProfile: PROFILE,
    payloadSchemaVersion: 2,
  };
  const indexingStarted = performance.now();
  const indexed = await createReindexHarness().reindex({
    current: snapshot,
  });
  const indexingMs = performance.now() - indexingStarted;
  rssSamples.push(rssMiB());

  expect(chunks.length).toBeGreaterThan(0);
  expect(
    chunks.every(
      (chunk) =>
        chunk.tokenCount <=
        DEFAULT_DOCUMENT_INDEXING_POLICY.chunk.maxChunkTokens,
    ),
  ).toBe(true);

  return {
    sourceCharacters: markdown.length,
    blockCount: document.blocks.length,
    semanticUnitCount: semanticUnits.length,
    chunkCount: chunks.length,
    catalogScopeCount: indexed.publication.scopes.length,
    fallbackCounts: countBy(
      chunks
        .filter((chunk) => chunk.splitKind !== "block_pack")
        .map((chunk) => chunk.splitKind),
    ),
    latencyMs: {
      capture: captureMs,
      segmentation: segmentationMs,
      chunking: chunkingMs,
      indexing: indexingMs,
      total: captureMs + segmentationMs + chunkingMs + indexingMs,
    },
    memory: {
      measurement: "stage-boundary-rss-v1",
      samplesMiB: rssSamples,
      peakRssMiB: Math.max(...rssSamples),
      deltaMiB: Math.max(...rssSamples) - rssSamples[0]!,
    },
  };
}

async function benchmarkFilteredAnn(
  qdrantUrl: string,
  configuration: BenchmarkCorpus["filteredAnn"],
) {
  const qdrantVersion = await readQdrantVersion(qdrantUrl);
  const profile: EmbeddingProfile = {
    ...PROFILE,
    id: "filtered-ann-benchmark-v1",
    dimensions: configuration.dimensions,
  };
  const vectorIndex = new QdrantVectorIndexAdapter({
    url: qdrantUrl,
    maxAttempts: 3,
    retryDelayMs: 50,
  });
  const prepared = await vectorIndex.prepare({
    compatibility: {
      stateNamespaceId: STATE_NAMESPACE_ID,
      securityDomain: SECURITY_DOMAIN,
      embeddingProfile: profile,
      payloadSchemaVersion: 2,
    },
    signal: new AbortController().signal,
  });
  const documents = Array.from(
    { length: configuration.documentCount },
    (_unused, documentIndex) =>
      annDocument(documentIndex, configuration, profile.dimensions),
  );
  const latencies: number[] = [];
  const perQuery: Array<{
    queryId: string;
    scopeKind: "document" | "semantic_units";
    recallAtK: number;
    outOfScopeHitCount: number;
  }> = [];

  try {
    for (const document of documents) {
      await vectorIndex.upsertRecords({
        accessHandle: prepared.accessHandle,
        embeddingProfile: profile,
        records: document.records.map((record) => record.record),
        signal: new AbortController().signal,
      });
    }

    for (let queryIndex = 0; queryIndex < configuration.queryCount; queryIndex += 1) {
      const document = documents[queryIndex % documents.length]!;
      const target = document.records[
        (queryIndex * 7) % document.records.length
      ]!;
      const targetUnitIndex = target.unitIndex;
      const semanticUnitIds =
        queryIndex % 2 === 0
          ? undefined
          : Array.from({ length: 4 }, (_unused, offset) =>
              document.semanticUnitIds[
                (targetUnitIndex + offset) % document.semanticUnitIds.length
              ]!,
            );
      const allowedUnits =
        semanticUnitIds === undefined ? undefined : new Set(semanticUnitIds);
      const exact = document.records
        .filter(
          (record) =>
            allowedUnits === undefined ||
            allowedUnits.has(record.record.metadata.semanticUnitId),
        )
        .map((record) => ({
          id: record.record.recordId,
          score: cosine(target.vector, record.vector),
        }))
        .sort(
          (left, right) =>
            right.score - left.score || left.id.localeCompare(right.id),
        )
        .slice(0, configuration.topK)
        .map((record) => record.id);
      const started = performance.now();
      const hits = await vectorIndex.search({
        accessHandle: prepared.accessHandle,
        scope: {
          documentIndexId: document.documentIndexId,
          indexVersion: document.indexVersion,
          documentId: document.documentId,
          ...(semanticUnitIds === undefined ? {} : { semanticUnitIds }),
        },
        queryVector: target.vector,
        limit: configuration.topK,
        signal: new AbortController().signal,
      });
      latencies.push(performance.now() - started);
      const actual = new Set(hits.map((hit) => hit.recordId));
      const outOfScopeHitCount = hits.filter(
        (hit) =>
          hit.metadata.documentId !== document.documentId ||
          hit.metadata.documentIndexId !== document.documentIndexId ||
          hit.metadata.indexVersion !== document.indexVersion ||
          (allowedUnits !== undefined &&
            !allowedUnits.has(hit.metadata.semanticUnitId)),
      ).length;
      perQuery.push({
        queryId: `q${String(queryIndex + 1).padStart(3, "0")}`,
        scopeKind:
          semanticUnitIds === undefined ? "document" : "semantic_units",
        recallAtK:
          exact.length === 0
            ? 1
            : exact.filter((recordId) => actual.has(recordId)).length /
              exact.length,
        outOfScopeHitCount,
      });
    }
  } finally {
    for (const document of documents) {
      await vectorIndex.deleteVersion({
        accessHandle: prepared.accessHandle,
        documentIndexId: document.documentIndexId,
        indexVersion: document.indexVersion,
        now: "2026-08-23T00:00:00.000Z",
        signal: new AbortController().signal,
      });
    }
  }

  return {
    qdrantVersion,
    queryCount: perQuery.length,
    topK: configuration.topK,
    recallAtK: mean(perQuery.map((query) => query.recallAtK)),
    outOfScopeHitCount: perQuery.reduce(
      (sum, query) => sum + query.outOfScopeHitCount,
      0,
    ),
    latencyMs: distribution(latencies),
    perQuery,
  };
}

async function readQdrantVersion(qdrantUrl: string): Promise<string> {
  const response = await fetch(`${qdrantUrl.replace(/\/+$/u, "")}/`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`Qdrant version probe failed with HTTP ${String(response.status)}`);
  }
  const payload = (await response.json()) as { readonly version?: unknown };
  if (typeof payload.version !== "string" || payload.version.trim() === "") {
    throw new Error("Qdrant version probe returned an invalid response");
  }
  return payload.version;
}

function annDocument(
  documentIndex: number,
  configuration: BenchmarkCorpus["filteredAnn"],
  dimensions: number,
) {
  const sourceId = rootId("src", `ann:${String(documentIndex)}`);
  const observationId = rootId("obs", `ann:${String(documentIndex)}`);
  const documentId = rootId("doc", `ann:${String(documentIndex)}`);
  const documentIndexId = createDocumentIndexId(sourceId, documentId);
  const indexVersion = revisionId("idxv", documentIndex);
  const semanticUnitIds = Array.from(
    { length: configuration.semanticUnitsPerDocument },
    (_unused, unitIndex) =>
      structuralId("unit", `ann:${String(documentIndex)}:${String(unitIndex)}`),
  );
  const records = Array.from(
    { length: configuration.recordsPerDocument },
    (_unused, recordIndex) => {
      const globalIndex =
        documentIndex * configuration.recordsPerDocument + recordIndex;
      const chunkRevisionId = revisionId("crv", globalIndex);
      const chunkId = structuralId("chk", `ann:${String(globalIndex)}`);
      const unitIndex =
        recordIndex % configuration.semanticUnitsPerDocument;
      const retrievalText = `benchmark document ${String(documentIndex)} record ${String(recordIndex)}`;
      const vector = seededUnitVector(globalIndex, dimensions);
      const record: VectorIndexRecord = {
        recordId: createVectorRecordId(
          STATE_NAMESPACE_ID,
          documentIndexId,
          indexVersion,
          chunkRevisionId,
        ),
        chunkRevisionId,
        embedding: vector,
        retrievalText,
        metadata: {
          payloadSchemaVersion: 2,
          stateNamespaceId: STATE_NAMESPACE_ID,
          securityDomain: SECURITY_DOMAIN,
          sourceId,
          observationId,
          documentId,
          documentIndexId,
          indexVersion,
          semanticUnitId: semanticUnitIds[unitIndex]!,
          chunkId,
          chunkRevisionId,
          contentDigest: sha256Digest(retrievalText),
        },
      };
      return { record, vector, unitIndex };
    },
  );
  return {
    documentId,
    documentIndexId,
    indexVersion,
    semanticUnitIds,
    records,
  };
}

function createSnapshot(
  fixture: BenchmarkDocumentFixture,
  seed: string,
  previous?: DocumentIndexingSnapshot,
  contentKind: "initial" | "modified" = seed === "initial"
    ? "initial"
    : "modified",
): DocumentIndexingSnapshot {
  const content = fixture[contentKind];
  const document = captureMarkdown(
    fixture,
    content,
    seed,
    previous?.document,
    contentKind,
  );
  const provisionalUnits = segmentNormalizedDocument({
    document,
    ids: sequentialUnitIds(`${fixture.id}:${seed}`),
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
    ids: sequentialChunkIds(`${fixture.id}:${seed}`),
  });
  return {
    document,
    semanticUnits,
    chunks,
    indexingPolicy: DEFAULT_DOCUMENT_INDEXING_POLICY,
    embeddingProfile: PROFILE,
    payloadSchemaVersion: 2,
  };
}

function captureMarkdown(
  fixture: Pick<BenchmarkDocumentFixture, "id">,
  content: string,
  seed: string,
  previousDocument?: DocumentIndexingSnapshot["document"],
  observationSeed = seed,
) {
  return new MarkdownCapture({
    parser: new RemarkMarkdownParser(),
    ids: sequentialBlockIds(`${fixture.id}:${seed}`),
  }).capture({
    source: {
      id: rootId("src", fixture.id),
      targetKey: `file:/benchmark/${fixture.id}.md`,
    },
    observationId: rootId("obs", `${fixture.id}:${observationSeed}`),
    documentId: rootId("doc", fixture.id),
    snapshot: {
      kind: "markdown",
      targetKey: `file:/benchmark/${fixture.id}.md`,
      capturedAt: "2026-08-23T00:00:00.000Z",
      content,
      contentDigest: sha256Digest(content),
    },
    ...(previousDocument === undefined ? {} : { previousDocument }),
  });
}

function createReindexHarness() {
  const provider = new CountingEmbeddingProvider();
  const vectorIndex = new InMemoryVectorIndexAdapter();
  const publications = new InMemoryIndexPublicationStore();
  const reindexer = new IncrementalDocumentReindexer({
    vectorIndex,
    publications,
    embeddingPipeline: new EmbeddingPipeline({ provider }),
    indexPublisher: new DocumentIndexPublisher({
      vectorIndex,
      publications,
      stagingAttempts: new InMemoryIndexStagingAttemptStore(),
      clock: () => "2026-08-23T00:00:00.000Z",
    }),
  });
  return {
    provider,
    reindex: (
      input: Pick<ReindexDocumentCommand, "previous" | "current">,
    ) =>
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
  embeddedInputCount = 0;
  readonly #delegate = new DeterministicEmbeddingAdapter();

  async embed(request: EmbeddingProviderRequest) {
    this.embeddedInputCount += request.inputs.length;
    return this.#delegate.embed(request);
  }
}

function boundaryOrders(
  document: DocumentIndexingSnapshot["document"],
  units: DocumentIndexingSnapshot["semanticUnits"],
): readonly number[] {
  const blockOrder = new Map(document.blocks.map((block) => [block.id, block.order]));
  return [
    ...new Set(
      units
        .filter((unit) => unit.kind !== "document")
        .map((unit) => blockOrder.get(unit.blockIds[0] ?? ""))
        .filter((order): order is number => order !== undefined && order > 0),
    ),
  ].sort((left, right) => left - right);
}

function sourceCoordinateContainsBlock(
  source: string,
  block: DocumentIndexingSnapshot["document"]["blocks"][number],
): boolean {
  if (block.sourceSpan.kind !== "text") return false;
  const { startOffset, endOffset } = block.sourceSpan;
  return (
    Number.isSafeInteger(startOffset) &&
    Number.isSafeInteger(endOffset) &&
    startOffset >= 0 &&
    endOffset > startOffset &&
    endOffset <= source.length &&
    source.slice(startOffset, endOffset).includes(block.text)
  );
}

function identityRetention<T extends { readonly id: string }>(
  previous: readonly T[],
  current: readonly T[],
): number {
  if (previous.length === 0) return 1;
  const currentIds = new Set(current.map((value) => value.id));
  return previous.filter((value) => currentIds.has(value.id)).length /
    previous.length;
}

function unchangedIdentityRetention<
  T extends {
    readonly id: string;
    readonly contentDigest: string;
  },
>(previous: readonly T[], current: readonly T[]): number {
  const previousByDigest = uniqueByDigest(previous);
  const unchanged = current.filter((value) => previousByDigest.has(value.contentDigest));
  if (unchanged.length === 0) return 1;
  return unchanged.filter(
    (value) => previousByDigest.get(value.contentDigest)?.id === value.id,
  ).length / unchanged.length;
}

function unchangedRevisionRetention<
  T extends {
    readonly contentDigest: string;
    readonly revisionId: string;
  },
>(previous: readonly T[], current: readonly T[]): number {
  const previousByDigest = uniqueByDigest(previous);
  const unchanged = current.filter((value) =>
    previousByDigest.has(value.contentDigest),
  );
  if (unchanged.length === 0) return 1;
  return unchanged.filter(
    (value) =>
      previousByDigest.get(value.contentDigest)?.revisionId ===
      value.revisionId,
  ).length / unchanged.length;
}

function uniqueByDigest<
  T extends { readonly contentDigest: string },
>(values: readonly T[]): ReadonlyMap<string, T> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const entries = grouped.get(value.contentDigest) ?? [];
    entries.push(value);
    grouped.set(value.contentDigest, entries);
  }
  return new Map(
    [...grouped]
      .filter(([_digest, entries]) => entries.length === 1)
      .map(([digest, entries]) => [digest, entries[0]!] as const),
  );
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

function largeMarkdown(
  configuration: BenchmarkCorpus["largeDocument"],
): string {
  const lines = ["# Large benchmark document"];
  for (let section = 0; section < configuration.sectionCount; section += 1) {
    lines.push("", `## Section ${String(section + 1)}`);
    for (
      let paragraph = 0;
      paragraph < configuration.paragraphsPerSection;
      paragraph += 1
    ) {
      const multiplier =
        paragraph === 0 &&
        section % configuration.oversizedEverySections === 0
          ? 8
          : 1;
      const terms = Array.from(
        { length: configuration.termsPerParagraph * multiplier },
        (_unused, term) =>
          `s${String(section)}p${String(paragraph)}t${String(term % 17)}`,
      );
      lines.push("", terms.join(" "));
    }
  }
  return lines.join("\n");
}

function aggregateBoundaryMetrics(
  metrics: readonly BoundaryMetrics[],
): BoundaryMetrics {
  return {
    precision: mean(metrics.map((metric) => metric.precision)),
    recall: mean(metrics.map((metric) => metric.recall)),
    f1: mean(metrics.map((metric) => metric.f1)),
    pk: mean(metrics.map((metric) => metric.pk)),
    windowDiff: mean(metrics.map((metric) => metric.windowDiff)),
  };
}

function assertLocalBenchmarkGates(
  documents: readonly Awaited<ReturnType<typeof benchmarkDocument>>[],
  boundary: BoundaryMetrics,
  chunkSizes: readonly number[],
  incrementalSavingsRatio: number,
): void {
  for (const document of documents) {
    expect(
      document.capture,
      `${document.documentId}: source capture must be stable and complete`,
    ).toMatchObject({
      contentDigestStable: true,
      coordinateCoverage: 1,
      textCoverage: 1,
      acceptedSourceCoverage: 1,
    });
    if (document.identityExpectation === "stable") {
      expect(
        document.capture.repeatedBlockIdentityRetention,
        `${document.documentId}: stable Block identity retention`,
      ).toBe(1);
    }
  }
  expect(boundary.f1).toBeGreaterThanOrEqual(BOUNDARY_F1_GATE);
  expect(boundary.pk).toBeLessThanOrEqual(BOUNDARY_PK_GATE);
  expect(boundary.windowDiff).toBeLessThanOrEqual(BOUNDARY_WINDOW_DIFF_GATE);
  for (const document of documents) {
    expect(
      document.boundary.metrics.f1,
      `${document.documentId}: boundary F1`,
    ).toBeGreaterThanOrEqual(BOUNDARY_F1_GATE);
    expect(
      document.boundary.metrics.pk,
      `${document.documentId}: Pk`,
    ).toBeLessThanOrEqual(BOUNDARY_PK_GATE);
    expect(
      document.boundary.metrics.windowDiff,
      `${document.documentId}: WindowDiff`,
    ).toBeLessThanOrEqual(BOUNDARY_WINDOW_DIFF_GATE);
  }
  expect(Math.max(...chunkSizes)).toBeLessThanOrEqual(
    DEFAULT_DOCUMENT_INDEXING_POLICY.chunk.maxChunkTokens,
  );
  for (const document of documents) {
    expect(
      document.incremental,
      `${document.documentId}: incremental output must match a cold rebuild`,
    ).toMatchObject({ strategy: "incremental", equivalenceViolations: [] });
    if (document.identityExpectation === "stable") {
      expect(
        document.incremental,
        `${document.documentId}: incremental output must retain unchanged identities`,
      ).toMatchObject({
        blockIdentityRetention: 1,
        semanticUnitIdentityRetention: 1,
        chunkRevisionRetention: 1,
      });
      expect(
        document.incremental.embeddedChunkCount,
        `${document.documentId}: incremental embedding count`,
      ).toBeLessThan(document.incremental.fullRebuildChunkCount);
    }
  }
  expect(incrementalSavingsRatio).toBeGreaterThan(0);
}

function distribution(values: readonly number[]) {
  if (values.length === 0) {
    return { min: 0, mean: 0, p50: 0, p95: 0, max: 0 };
  }
  return {
    min: Math.min(...values),
    mean: mean(values),
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: Math.max(...values),
  };
}

function mean(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function weightedRatio(
  values: readonly { readonly numerator: number; readonly denominator: number }[],
): number {
  const numerator = values.reduce((sum, value) => sum + value.numerator, 0);
  const denominator = values.reduce(
    (sum, value) => sum + value.denominator,
    0,
  );
  return denominator === 0 ? 0 : numerator / denominator;
}

function countBy(values: readonly string[]): Readonly<Record<string, number>> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries(
    [...counts].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function mergeCounts(
  counts: readonly Readonly<Record<string, number>>[],
): Readonly<Record<string, number>> {
  return countBy(
    counts.flatMap((record) =>
      Object.entries(record).flatMap(([key, count]) =>
        Array.from({ length: count }, () => key),
      ),
    ),
  );
}

function seededUnitVector(seed: number, dimensions: number): readonly number[] {
  let state = Math.imul(seed + 1, 0x9e3779b1) >>> 0;
  const values: number[] = [];
  for (let index = 0; index < dimensions; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    values.push(((state >>> 0) / 0xffffffff) * 2 - 1);
  }
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return values.map((value) => value / norm);
}

function cosine(left: readonly number[], right: readonly number[]): number {
  return left.reduce(
    (sum, value, index) => sum + value * (right[index] ?? 0),
    0,
  );
}

function revisionId(prefix: "crv" | "idxv", value: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let remaining = value + 1;
  let encoded = "";
  while (remaining > 0) {
    encoded = alphabet[remaining % alphabet.length]! + encoded;
    remaining = Math.floor(remaining / alphabet.length);
  }
  return `${prefix}_${encoded.padStart(8, "a")}`;
}

function rssMiB(): number {
  return process.memoryUsage().rss / 1024 / 1024;
}

function sequentialBlockIds(seed: string): BlockIdSource {
  let next = 0;
  return {
    nextBlockId: () => structuralId("blk", `${seed}:${String(next++)}`),
  };
}

function sequentialUnitIds(seed: string): SemanticUnitIdSource {
  let next = 0;
  return {
    nextUnitId: () => structuralId("unit", `${seed}:${String(next++)}`),
  };
}

function sequentialChunkIds(seed: string): ManagedChunkIdSource {
  let next = 0;
  return {
    nextChunkId: () => structuralId("chk", `${seed}:${String(next++)}`),
  };
}

async function loadCorpus(): Promise<BenchmarkCorpus> {
  const bytes = await readFile(CORPUS_FILE);
  const parsed = JSON.parse(bytes.toString("utf8")) as Omit<
    BenchmarkCorpus,
    "digest"
  >;
  if (
    parsed.schemaVersion !== 1 ||
    parsed.datasetId !== "ingestion-indexing-benchmark-v1" ||
    parsed.version.trim() === "" ||
    parsed.documents.length < 3 ||
    new Set(parsed.documents.map((document) => document.id)).size !==
      parsed.documents.length ||
    parsed.documents.some(
      (document) =>
        document.id.trim() === "" ||
        !["stable", "ambiguous_duplicates"].includes(
          document.identityExpectation,
        ) ||
        document.initial.trim() === "" ||
        document.modified.trim() === "" ||
        document.initial === document.modified ||
        document.expectedBoundaryBlockOrders.some(
          (boundary, index, boundaries) =>
            !Number.isSafeInteger(boundary) ||
            boundary <= 0 ||
            (boundaries[index - 1] ?? 0) >= boundary,
        ),
    ) ||
    !positiveIntegers([
      parsed.largeDocument.sectionCount,
      parsed.largeDocument.paragraphsPerSection,
      parsed.largeDocument.termsPerParagraph,
      parsed.largeDocument.oversizedEverySections,
      parsed.filteredAnn.documentCount,
      parsed.filteredAnn.recordsPerDocument,
      parsed.filteredAnn.semanticUnitsPerDocument,
      parsed.filteredAnn.queryCount,
      parsed.filteredAnn.dimensions,
      parsed.filteredAnn.topK,
    ]) ||
    parsed.filteredAnn.recordsPerDocument < parsed.filteredAnn.topK ||
    parsed.filteredAnn.recordsPerDocument %
      parsed.filteredAnn.semanticUnitsPerDocument !==
      0
  ) {
    throw new Error("ingestion-indexing-benchmark-v1 corpus is invalid");
  }
  return {
    ...parsed,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

async function readDocumentRetrievalEvaluation(
  path: string,
): Promise<DocumentRetrievalEvaluation> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<
    DocumentRetrievalEvaluation
  >;
  const numbers = [
    parsed.recallAt5,
    parsed.mrrAt10,
    parsed.warmQueryP95Ms,
    parsed.peakRssMiB,
  ];
  if (
    typeof parsed.datasetId !== "string" ||
    typeof parsed.datasetVersion !== "string" ||
    typeof parsed.datasetDigest !== "string" ||
    typeof parsed.profileId !== "string" ||
    parsed.resourceGatePassed !== true ||
    parsed.quantized !== false ||
    !Array.isArray(parsed.missedQueryIds) ||
    !numbers.every(
      (value) =>
        typeof value === "number" && Number.isFinite(value) && value >= 0,
    )
  ) {
    throw new Error("document retrieval evaluation result is invalid");
  }
  return parsed as DocumentRetrievalEvaluation;
}

function positiveIntegers(values: readonly number[]): boolean {
  return values.every((value) => Number.isSafeInteger(value) && value > 0);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required for ingestion-indexing-benchmark-v1`);
  }
  return value;
}
