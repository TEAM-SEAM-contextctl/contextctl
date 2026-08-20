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
import { DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE } from "../src/index.js";
import {
  GRANITE_FP32_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
  GRANITE_Q8_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
} from "../src/infrastructure/transformers-js-local-embedding-adapter.js";

const assetDirectory = process.env.CONTEXTCTL_GRANITE_ASSET_DIRECTORY;
const fp32Directory = process.env.CONTEXTCTL_GRANITE_FP32_ASSET_DIRECTORY;
const resultPath = process.env.CONTEXTCTL_EVAL_RESULT_PATH;
const profileVariant = readProfileVariant(
  process.env.CONTEXTCTL_GRANITE_EVAL_PROFILE,
);
const resourceGateMode = readResourceGateMode(
  process.env.CONTEXTCTL_EVAL_RESOURCE_GATE_MODE,
);
const qualityGateMode = readQualityGateMode(
  process.env.CONTEXTCTL_EVAL_QUALITY_GATE_MODE,
);

const RECALL_AT_5_GATE = 0.9;
const MRR_AT_10_GATE = 0.75;
const MAX_QUANTIZED_RECALL_REGRESSION = 0.02;
const WARM_QUERY_P95_MS_GATE = 100;
const PEAK_RSS_MIB_GATE = 768;
const BATCH_SIZE = 32;
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
 * The default `release` mode enforces every gate. GitHub-hosted Linux uses the
 * explicit `hosted_observation` mode because RSS is platform-specific; that
 * result records the failed resource gate but cannot stand in for release
 * evidence from the deployment reference machine. A quantized candidate may
 * use `candidate_observation` to preserve and report a failed non-inferiority
 * comparison while deciding whether it deserves a new release policy. It does
 * not turn that failed comparison into a release pass.
 */
describe.skipIf(assetDirectory === undefined)(
  "document-retrieval-eval-v1",
  () => {
    it(
      "meets the pinned quality and resource gates",
      async () => {
        const corpus = await loadEvalCorpus();
        const profile =
          profileVariant === "q8"
            ? GRANITE_Q8_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE
            : DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE;
        const resources = await measureIsolatedResources(
          profileVariant === "q8" ? "q8" : "fp32",
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

        const baseline = await measureBaseline(corpus, quality, profile);
        const quantizedRecallRegression =
          baseline === undefined
            ? undefined
            : baseline.recallAt5 - quality.recallAt5;
        const quantizedNonInferiorityPassed =
          quantizedRecallRegression === undefined
            ? undefined
            : quantizedRecallRegression <= MAX_QUANTIZED_RECALL_REGRESSION;
        const result = {
          datasetId: corpus.datasetId,
          datasetVersion: corpus.version,
          datasetDigest: corpus.digest,
          profileId: profile.id,
          assetManifestSha256:
            profile.execution.kind === "local"
              ? profile.execution.assetManifestSha256
              : undefined,
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
          resourceMeasurement: resources.measurement,
          resourceBatchSize: resources.batchSize,
          processStartRssMiB: resources.processStartRssMiB,
          readyRssMiB: resources.readyRssMiB,
          modelReadyRssDeltaMiB: resources.modelReadyRssDeltaMiB,
          modelLoadPeakRssMiB: resources.modelLoadPeakRssMiB,
          batchEndRssMiB: resources.batchEndRssMiB,
          observedBatchPeakRssMiB: resources.observedBatchPeakRssMiB,
          peakRssMiB: resources.peakRssMiB,
          batchRssDeltaMiB: resources.batchRssDeltaMiB,
          lifetimePeakRssMiB: resources.lifetimePeakRssMiB,
          resourceGateMode,
          resourceGatePassed:
            resources.peakRssMiB <= PEAK_RSS_MIB_GATE,
          qualityGateMode,
          absoluteQualityGatePassed:
            quality.recallAt5 >= RECALL_AT_5_GATE &&
            quality.mrrAt10 >= MRR_AT_10_GATE,
          latencyGatePassed:
            warmQueryP95Ms <= WARM_QUERY_P95_MS_GATE,
          quantizedRecallRegression,
          quantizedNonInferiorityPassed,
          baseline,
          gates: {
            recallAt5: RECALL_AT_5_GATE,
            mrrAt10: MRR_AT_10_GATE,
            maxRecallRegression: MAX_QUANTIZED_RECALL_REGRESSION,
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
        if (qualityGateMode === "release") {
          expect(quality.recallAt5).toBeGreaterThanOrEqual(RECALL_AT_5_GATE);
          expect(quality.mrrAt10).toBeGreaterThanOrEqual(MRR_AT_10_GATE);
          expect(warmQueryP95Ms).toBeLessThanOrEqual(WARM_QUERY_P95_MS_GATE);
        }
        if (resourceGateMode === "release") {
          expect(result.peakRssMiB).toBeLessThanOrEqual(PEAK_RSS_MIB_GATE);
        }
        if (baseline !== undefined && qualityGateMode === "release") {
          expect(quantizedRecallRegression).toBeLessThanOrEqual(
            MAX_QUANTIZED_RECALL_REGRESSION,
          );
        }
      },
      600_000,
    );
  },
);

function readResourceGateMode(
  value: string | undefined,
): "release" | "hosted_observation" {
  if (value === undefined || value === "release") return "release";
  if (value === "hosted_observation") return "hosted_observation";
  throw new Error(
    "CONTEXTCTL_EVAL_RESOURCE_GATE_MODE must be release or hosted_observation",
  );
}

function readQualityGateMode(
  value: string | undefined,
): "release" | "candidate_observation" {
  if (value === undefined || value === "release") return "release";
  if (value === "candidate_observation") return "candidate_observation";
  throw new Error(
    "CONTEXTCTL_EVAL_QUALITY_GATE_MODE must be release or candidate_observation",
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
  readonly observedBatchPeakRssMiB: number;
  readonly peakRssMiB: number;
  readonly batchRssDeltaMiB: number;
  readonly lifetimePeakRssMiB: number;
}

async function measureIsolatedResources(
  variant: "fp32" | "q8",
  directory: string,
  expectedProfileId: string,
): Promise<IsolatedResourceMeasurement> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      process.execPath,
      [RESOURCE_PROBE, variant, directory],
      { maxBuffer: 1024 * 1024 },
      (error, childStdout, childStderr) => {
        if (error !== null) {
          reject(
            new Error(
              `isolated resource probe failed: ${childStderr.trim() || error.message}`,
              { cause: error },
            ),
          );
          return;
        }
        resolve(childStdout);
      },
    );
  });
  const parsed = JSON.parse(stdout) as Partial<IsolatedResourceMeasurement>;
  const measurements = [
    parsed.processStartRssMiB,
    parsed.readyRssMiB,
    parsed.modelReadyRssDeltaMiB,
    parsed.modelLoadPeakRssMiB,
    parsed.batchEndRssMiB,
    parsed.observedBatchPeakRssMiB,
    parsed.peakRssMiB,
    parsed.batchRssDeltaMiB,
    parsed.lifetimePeakRssMiB,
  ];
  if (
    parsed.schemaVersion !== 1 ||
    parsed.measurement !== "isolated-node-process-v1" ||
    parsed.profileId !== expectedProfileId ||
    parsed.batchSize !== BATCH_SIZE ||
    measurements.some(
      (value) => typeof value !== "number" || !Number.isFinite(value) || value < 0,
    ) ||
    parsed.peakRssMiB! < parsed.readyRssMiB! ||
    parsed.modelLoadPeakRssMiB! < parsed.readyRssMiB! ||
    parsed.lifetimePeakRssMiB! < parsed.modelLoadPeakRssMiB! ||
    parsed.lifetimePeakRssMiB! < parsed.peakRssMiB!
  ) {
    throw new Error("isolated resource probe returned an invalid result");
  }
  return parsed as IsolatedResourceMeasurement;
}

function readProfileVariant(value: string | undefined): "default" | "q8" {
  if (value === undefined || value === "default") return "default";
  if (value === "q8") return "q8";
  throw new Error(
    "CONTEXTCTL_GRANITE_EVAL_PROFILE must be default or q8",
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
  measured: RetrievalQuality,
  measuredProfile: typeof DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
): Promise<BaselineQuality | undefined> {
  if (
    measuredProfile.execution.kind === "local" &&
    measuredProfile.execution.precision === "fp32"
  ) {
    return undefined;
  }
  if (fp32Directory === undefined) {
    throw new Error(
      "quantized evaluation requires CONTEXTCTL_GRANITE_FP32_ASSET_DIRECTORY",
    );
  }
  const profile = await readBaselineProfile(
    fp32Directory,
    GRANITE_FP32_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
  );
  const provider = createLocalProvider(fp32Directory, profile);
  await provider.ready();
  const chunkVectors = await embedAll(provider, profile, corpus.chunks);
  const queryVectors = await embedAll(provider, profile, corpus.queries);
  const quality = scoreRetrieval(corpus, chunkVectors, queryVectors);
  expect(quality.queryCount).toBe(measured.queryCount);
  return {
    recallAt5: quality.recallAt5,
    mrrAt10: quality.mrrAt10,
    missedQueryIds: quality.missedQueryIds,
  };
}
