import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { arch, cpus, platform, totalmem } from "node:os";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  createLocalProvider,
  embedAll,
  loadEvalCorpus,
  percentile,
  readBaselineProfile,
  scoreRetrieval,
  type RetrievalQuality,
} from "./fixtures/document-retrieval-eval.js";
import {
  DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
  DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST_SHA256,
} from "../src/index.js";

const assetDirectory = process.env.CONTEXTCTL_GRANITE_ASSET_DIRECTORY;
const fp32Directory = process.env.CONTEXTCTL_GRANITE_FP32_ASSET_DIRECTORY;
const resultPath = process.env.CONTEXTCTL_EVAL_RESULT_PATH;
const resourceGateMode = readResourceGateMode(
  process.env.CONTEXTCTL_EVAL_RESOURCE_GATE_MODE,
);

const RECALL_AT_5_GATE = 0.9;
const MRR_AT_10_GATE = 0.75;
const MAX_Q8_RECALL_REGRESSION = 0.02;
const WARM_QUERY_P95_MS_GATE = 100;
const PEAK_RSS_MIB_GATE = 1024;
const BATCH_SIZE = 32;
const RESOURCE_PROBE_REPETITIONS = 5;
const RESOURCE_PROBE = fileURLToPath(
  new URL(
    "../../../scripts/run-document-retrieval-resource-probe.mjs",
    import.meta.url,
  ),
);

/**
 * The release gate for the fixed document retrieval profile.
 *
 * It runs against the installed artifacts rather than a stub, so it is skipped
 * where they are absent. A skipped run is not a pass: the release judgement
 * reads the emitted result, and no result means the gate did not run.
 * The default `release` mode enforces every gate. The resource result comes
 * from five fresh, sequential Node processes so evaluator vectors and a warm
 * model from an earlier run cannot hide model-load or first-batch peaks.
 */
describe.skipIf(assetDirectory === undefined)(
  "document-retrieval-eval-v1",
  () => {
    it(
      "meets the pinned quality and resource gates",
      async () => {
        const corpus = await loadEvalCorpus();
        const profile = DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE;
        const resources = await measureIsolatedResources(
          assetDirectory!,
          profile.id,
        );
        const provider = createLocalProvider(assetDirectory!, profile);
        await provider.ready();

        const chunkVectors = await embedAll(provider, profile, corpus.chunks);
        const queryVectors = await embedAll(provider, profile, corpus.queries);
        const quality = scoreRetrieval(corpus, chunkVectors, queryVectors);

        // Warm measurement: the first calls load and page in the model.
        const warmup = corpus.queries.slice(0, 5);
        for (const query of warmup) {
          await embedAll(provider, profile, [query], 1);
        }
        const latencies: number[] = [];
        for (const query of corpus.queries) {
          const started = performance.now();
          await embedAll(provider, profile, [query], 1);
          latencies.push(performance.now() - started);
        }
        const warmQueryP95Ms = percentile(latencies, 0.95);

        const baseline = await measureBaseline(corpus, quality);
        const readyRssMiB = Math.max(
          ...resources.map((measurement) => measurement.readyRssMiB),
        );
        const peakRssMiB = Math.max(
          ...resources.map((measurement) => measurement.peakRssMiB),
        );
        const batchRssDeltaMiB = Math.max(
          ...resources.map((measurement) => measurement.batchRssDeltaMiB),
        );
        const result = {
          datasetId: corpus.datasetId,
          datasetVersion: corpus.version,
          datasetDigest: corpus.digest,
          profileId: profile.id,
          assetManifestSha256: DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST_SHA256,
          artifactSha256: profile.execution.kind === "local"
            ? profile.execution.artifactSha256
            : undefined,
          adapterVersion: profile.execution.adapterVersion,
          nodeVersion: process.version,
          platform: `${platform()}-${arch()}`,
          cpuModel: cpus()[0]?.model ?? "unknown",
          totalMemoryMiB: Math.round(totalmem() / 1024 / 1024),
          queryCount: quality.queryCount,
          recallAt5: quality.recallAt5,
          mrrAt10: quality.mrrAt10,
          warmQueryP95Ms,
          resourceMeasurement: "isolated-node-process-v1",
          resourceBatchSize: BATCH_SIZE,
          resourceProbeRepetitions: RESOURCE_PROBE_REPETITIONS,
          resourceMeasurements: resources,
          readyRssMiB,
          peakRssMiB,
          batchRssDeltaMiB,
          resourceGateMode,
          resourceGatePassed: resources.every(
            (measurement) => measurement.peakRssMiB <= PEAK_RSS_MIB_GATE,
          ),
          baseline,
          gates: {
            recallAt5: RECALL_AT_5_GATE,
            mrrAt10: MRR_AT_10_GATE,
            maxRecallRegression: MAX_Q8_RECALL_REGRESSION,
            warmQueryP95Ms: WARM_QUERY_P95_MS_GATE,
            peakRssMiB: PEAK_RSS_MIB_GATE,
          },
          missedQueryIds: quality.missedQueryIds,
          quantized:
            profile.execution.kind === "local" &&
            profile.execution.precision !== "fp32",
        };
        if (resultPath !== undefined) {
          await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
        }
        // Printed so a run that fails a gate still reports every measurement.
        console.log(JSON.stringify(result, null, 2));

        expect(quality.queryCount).toBeGreaterThanOrEqual(60);
        expect(quality.recallAt5).toBeGreaterThanOrEqual(RECALL_AT_5_GATE);
        expect(quality.mrrAt10).toBeGreaterThanOrEqual(MRR_AT_10_GATE);
        expect(warmQueryP95Ms).toBeLessThanOrEqual(WARM_QUERY_P95_MS_GATE);
        if (resourceGateMode === "release") {
          expect(result.resourceGatePassed).toBe(true);
        }
        if (baseline !== undefined) {
          expect(baseline.recallAt5 - quality.recallAt5).toBeLessThanOrEqual(
            MAX_Q8_RECALL_REGRESSION,
          );
        }
      },
      600_000,
    );
  },
);

function readResourceGateMode(
  value: string | undefined,
): "release" {
  if (value === undefined || value === "release") return "release";
  throw new Error(
    "CONTEXTCTL_EVAL_RESOURCE_GATE_MODE must be release",
  );
}

interface IsolatedResourceMeasurement {
  readonly schemaVersion: 1;
  readonly measurement: "isolated-node-process-v1";
  readonly profileId: string;
  readonly batchSize: 32;
  readonly processStartRssMiB: number;
  readonly readyRssMiB: number;
  readonly modelReadyRssDeltaMiB: number;
  readonly modelLoadPeakRssMiB: number;
  readonly batchEndRssMiB: number;
  readonly sampledBatchPeakRssMiB: number;
  readonly batchRssDeltaMiB: number;
  readonly peakRssMiB: number;
}

async function measureIsolatedResources(
  directory: string,
  expectedProfileId: string,
): Promise<readonly IsolatedResourceMeasurement[]> {
  const measurements: IsolatedResourceMeasurement[] = [];
  for (let run = 1; run <= RESOURCE_PROBE_REPETITIONS; run += 1) {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        [RESOURCE_PROBE, directory],
        { maxBuffer: 1024 * 1024 },
        (error, childStdout, childStderr) => {
          if (error !== null) {
            reject(
              new Error(
                `isolated resource probe ${run} failed: ${childStderr.trim() || error.message}`,
                { cause: error },
              ),
            );
            return;
          }
          resolve(childStdout);
        },
      );
    });
    const lines = stdout.trim().split("\n");
    const parsed = JSON.parse(
      lines.at(-1) ?? "null",
    ) as Partial<IsolatedResourceMeasurement> | null;
    if (!isValidResourceMeasurement(parsed, expectedProfileId)) {
      throw new Error(`isolated resource probe ${run} returned an invalid result`);
    }
    measurements.push(parsed);
  }
  return measurements;
}

function isValidResourceMeasurement(
  value: Partial<IsolatedResourceMeasurement> | null,
  expectedProfileId: string,
): value is IsolatedResourceMeasurement {
  if (value === null) return false;
  const numbers = [
    value.processStartRssMiB,
    value.readyRssMiB,
    value.modelReadyRssDeltaMiB,
    value.modelLoadPeakRssMiB,
    value.batchEndRssMiB,
    value.sampledBatchPeakRssMiB,
    value.batchRssDeltaMiB,
    value.peakRssMiB,
  ];
  return (
    value.schemaVersion === 1 &&
    value.measurement === "isolated-node-process-v1" &&
    value.profileId === expectedProfileId &&
    value.batchSize === BATCH_SIZE &&
    numbers.every(
      (measurement) =>
        typeof measurement === "number" &&
        Number.isFinite(measurement) &&
        measurement >= 0,
    ) &&
    value.modelLoadPeakRssMiB! >= value.readyRssMiB! &&
    value.peakRssMiB! >= value.modelLoadPeakRssMiB! &&
    value.peakRssMiB! >= value.sampledBatchPeakRssMiB!
  );
}

interface BaselineQuality {
  readonly recallAt5: number;
  readonly mrrAt10: number;
  readonly missedQueryIds: readonly string[];
}

/**
 * The non-inferiority check only means something for a quantized profile: it
 * asks what quantization cost. A profile that already ships full precision is
 * its own baseline, so the comparison is recorded as not applicable rather
 * than run against itself.
 */
async function measureBaseline(
  corpus: Awaited<ReturnType<typeof loadEvalCorpus>>,
  q8: RetrievalQuality,
): Promise<BaselineQuality | undefined> {
  if (
    fp32Directory === undefined ||
    (DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE.execution.kind === "local" &&
      DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE.execution.precision === "fp32")
  ) {
    return undefined;
  }
  const profile = await readBaselineProfile(
    fp32Directory,
    DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
  );
  const provider = createLocalProvider(fp32Directory, profile);
  await provider.ready();
  const chunkVectors = await embedAll(provider, profile, corpus.chunks);
  const queryVectors = await embedAll(provider, profile, corpus.queries);
  const quality = scoreRetrieval(corpus, chunkVectors, queryVectors);
  expect(quality.queryCount).toBe(q8.queryCount);
  return {
    recallAt5: quality.recallAt5,
    mrrAt10: quality.mrrAt10,
    missedQueryIds: quality.missedQueryIds,
  };
}
