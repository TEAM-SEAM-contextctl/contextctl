import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import { DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE } from "@contextctl/ingestion-indexing";
import {
  CARD_SELECTION_EMBEDDING_PROFILE,
  canonicalDigest,
  HYBRID_SCORING_POLICY_VERSION,
  InMemoryCardCandidateIndexStore,
  QUERY_SCORING_POLICY_VERSION,
  selectContext,
  TransformersJsLocalCardEmbeddingAdapter,
  type ApprovedCard,
  type CardEmbeddingPort,
  type LocalCardEmbeddingInferenceResource,
} from "@contextctl/selection-delivery";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WorkerThreadLocalEmbeddingInferenceResource } from "../src/runtime/worker-thread-local-embedding-inference-resource.js";
import { EMBEDDING_RUNTIME_SCHEDULER_V1 } from "../src/runtime/embedding-runtime-scheduler.js";

const artifactDirectory = process.env.CONTEXTCTL_GRANITE_ASSET_DIRECTORY;
const resultPath = process.env.CONTEXTCTL_SELECTION_SCALE_RESULT_PATH;
const CARD_COUNT = 10_000;
const WARMUP_QUERIES = 5;
const MEASURED_QUERIES = 50;
const LATENCY_GATE_MS = 150;
const RSS_GATE_MIB =
  EMBEDDING_RUNTIME_SCHEDULER_V1.rssLimitBytes / 1024 / 1024;
const QUERY = "What is today's dollar exchange rate?";

describe.skipIf(artifactDirectory === undefined || resultPath === undefined)(
  "selection-scale-v1 · Granite fp32",
  () => {
    let resource: WorkerThreadLocalEmbeddingInferenceResource;
    let report: SelectionScaleReport;

    beforeAll(async () => {
      const peak = trackPeakRss();
      const cards = createScaleCards();
      const datasetDigest = canonicalDigest({
        benchmarkId: "selection-scale-v1",
        cardCount: CARD_COUNT,
        query: QUERY,
        cards,
      });
      const modelStarted = performance.now();
      resource = new WorkerThreadLocalEmbeddingInferenceResource({
        artifactDirectory: artifactDirectory!,
        profile: DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
      });
      await resource.ready();
      const modelLoadMs = performance.now() - modelStarted;
      if (CARD_SELECTION_EMBEDDING_PROFILE.execution.kind !== "local") {
        throw new Error("the production Card profile must be local");
      }
      const cardResource: LocalCardEmbeddingInferenceResource = {
        execution: CARD_SELECTION_EMBEDDING_PROFILE.execution,
        modelMaxTokens: resource.modelMaxTokens,
        tokenCount: async (text) => await resource.tokenCount(text),
        tokenCounts: async (texts) => await resource.tokenCounts(texts),
        embed: async (texts, options) => await resource.embed(texts, options),
      };
      const actualEmbedding = new TransformersJsLocalCardEmbeddingAdapter({
        inferenceResource: cardResource,
        profile: CARD_SELECTION_EMBEDDING_PROFILE,
      });
      let embeddingCalls = 0;
      const embedding: CardEmbeddingPort = {
        providerKind: actualEmbedding.providerKind,
        profile: actualEmbedding.profile,
        embed: async (request) => {
          embeddingCalls += 1;
          return await actualEmbedding.embed(request);
        },
      };
      const index = new InMemoryCardCandidateIndexStore();
      const ports = {
        catalog: { listApprovedCards: async () => cards },
        semantic: { embedding, index, profile: CARD_SELECTION_EMBEDDING_PROFILE },
      } as const;

      const indexStarted = performance.now();
      await selectContext(ports, QUERY);
      const indexBuildMs = performance.now() - indexStarted;
      const indexBuildEmbeddingCalls = embeddingCalls;
      const catalogSnapshotVersion = index.current?.catalogSnapshotVersion;
      if (catalogSnapshotVersion === undefined) {
        throw new Error("the scale run did not publish a candidate index");
      }
      embeddingCalls = 0;
      for (let index = 0; index < WARMUP_QUERIES; index += 1) {
        await selectContext(ports, QUERY);
      }
      embeddingCalls = 0;
      const latencies: number[] = [];
      for (let index = 0; index < MEASURED_QUERIES; index += 1) {
        const started = performance.now();
        await selectContext(ports, QUERY);
        latencies.push(performance.now() - started);
      }
      const peakRssMiB = peak.stop();
      const p95LatencyMs = percentile95(latencies);
      report = {
        benchmarkId: "selection-scale-v1",
        datasetDigest,
        catalogSnapshotVersion,
        profile: CARD_SELECTION_EMBEDDING_PROFILE,
        policy: {
          lexical: QUERY_SCORING_POLICY_VERSION,
          hybrid: HYBRID_SCORING_POLICY_VERSION,
        },
        cardCount: CARD_COUNT,
        warmupQueries: WARMUP_QUERIES,
        measuredQueries: MEASURED_QUERIES,
        modelLoadMs,
        indexBuildMs,
        indexBuildEmbeddingCalls,
        p95LatencyMs,
        latenciesMs: latencies,
        queryEmbeddingCalls: embeddingCalls,
        maxEmbeddingCallsPerQuery: embeddingCalls / MEASURED_QUERIES,
        peakRssMiB,
        gates: {
          latencyMs: LATENCY_GATE_MS,
          maxEmbeddingCallsPerQuery: 1,
          peakRssMiB: RSS_GATE_MIB,
        },
        runtime: {
          node: process.version,
          platform: process.platform,
          architecture: process.arch,
        },
      };
      await writeFile(resultPath!, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }, 900_000);

    afterAll(async () => {
      await resource?.close();
    }, 30_000);

    it("meets the fixed latency, call-count and memory gates", () => {
      expect(report.p95LatencyMs).toBeLessThanOrEqual(LATENCY_GATE_MS);
      expect(report.maxEmbeddingCallsPerQuery).toBeLessThanOrEqual(1);
      expect(report.peakRssMiB).toBeLessThanOrEqual(RSS_GATE_MIB);
    });
  },
);

interface SelectionScaleReport {
  readonly benchmarkId: "selection-scale-v1";
  readonly datasetDigest: string;
  readonly catalogSnapshotVersion: string;
  readonly profile: typeof CARD_SELECTION_EMBEDDING_PROFILE;
  readonly policy: {
    readonly lexical: typeof QUERY_SCORING_POLICY_VERSION;
    readonly hybrid: typeof HYBRID_SCORING_POLICY_VERSION;
  };
  readonly cardCount: number;
  readonly warmupQueries: number;
  readonly measuredQueries: number;
  readonly modelLoadMs: number;
  readonly indexBuildMs: number;
  readonly indexBuildEmbeddingCalls: number;
  readonly p95LatencyMs: number;
  readonly latenciesMs: readonly number[];
  readonly queryEmbeddingCalls: number;
  readonly maxEmbeddingCallsPerQuery: number;
  readonly peakRssMiB: number;
  readonly gates: {
    readonly latencyMs: number;
    readonly maxEmbeddingCallsPerQuery: number;
    readonly peakRssMiB: number;
  };
  readonly runtime: {
    readonly node: string;
    readonly platform: NodeJS.Platform;
    readonly architecture: string;
  };
}

function createScaleCards(): readonly ApprovedCard[] {
  const cards: ApprovedCard[] = [
    {
      cardId: "currency",
      versionId: "currency.v1",
      meaning: {
        description: "Current currency exchange rates",
        representativeQuestions: ["What is today's dollar exchange rate?"],
        aliases: ["exchange rate API"],
        keywords: ["currency", "dollar", "exchange"],
      },
      policy: { sensitive: false, allowedUsage: ["retrieval"] },
      scopes: [
        {
          kind: "http_source",
          reference: { scopeId: "http.currency", scopeVersion: "1" },
          connector: "service-api",
          method: "GET",
          path: "/v1/exchange-rate",
          operationId: "getExchangeRate",
          parameters: [{ location: "query", name: "currency", required: true }],
        },
      ],
    },
  ];
  for (let index = 1; index < CARD_COUNT; index += 1) {
    const suffix = String(index).padStart(5, "0");
    cards.push({
      cardId: `synthetic_${suffix}`,
      versionId: `synthetic_${suffix}.v1`,
      meaning: {
        description: `Synthetic catalog topic ${suffix}`,
        representativeQuestions: [`Where is synthetic topic ${suffix}?`],
        aliases: [`synthetic-${suffix}`],
        keywords: [`topic-${suffix}`],
      },
      policy: { sensitive: false, allowedUsage: ["retrieval"] },
      scopes: [
        {
          kind: "managed_document",
          reference: { scopeId: `managed.synthetic.${suffix}`, scopeVersion: "1" },
          documentIndex: {
            documentIndexId: `index.synthetic.${suffix}`,
            sourceId: `source.synthetic.${suffix}`,
            documentId: `document.synthetic.${suffix}`,
            indexVersion: "1",
          },
          selection: { kind: "document" },
        },
      ],
    });
  }
  return cards;
}

function trackPeakRss(): { stop(): number } {
  let peak = process.memoryUsage.rss();
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage.rss());
  }, 10);
  return {
    stop: () => {
      clearInterval(timer);
      peak = Math.max(peak, process.memoryUsage.rss());
      return peak / 1024 / 1024;
    },
  };
}

function percentile95(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
}
