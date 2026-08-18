import { writeFile } from "node:fs/promises";
import { arch, cpus, platform, totalmem } from "node:os";

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

const q8Directory = process.env.CONTEXTCTL_GRANITE_ASSET_DIRECTORY;
const fp32Directory = process.env.CONTEXTCTL_GRANITE_FP32_ASSET_DIRECTORY;
const resultPath = process.env.CONTEXTCTL_EVAL_RESULT_PATH;

const RECALL_AT_5_GATE = 0.9;
const MRR_AT_10_GATE = 0.75;
const MAX_Q8_RECALL_REGRESSION = 0.02;
const WARM_QUERY_P95_MS_GATE = 100;
const PEAK_RSS_MIB_GATE = 768;
const BATCH_SIZE = 32;

/**
 * The release gate for the fixed document retrieval profile.
 *
 * It runs against the installed artifacts rather than a stub, so it is skipped
 * where they are absent. A skipped run is not a pass: the release judgement
 * reads the emitted result, and no result means the gate did not run.
 */
describe.skipIf(q8Directory === undefined)(
  "document-retrieval-eval-v1",
  () => {
    it(
      "meets the pinned quality and resource gates",
      async () => {
        const corpus = await loadEvalCorpus();
        const profile = DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE;
        const provider = createLocalProvider(q8Directory!, profile);
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

        let peakRssBytes = process.memoryUsage().rss;
        for (let offset = 0; offset < corpus.chunks.length; offset += BATCH_SIZE) {
          await embedAll(
            provider,
            profile,
            corpus.chunks.slice(offset, offset + BATCH_SIZE),
            BATCH_SIZE,
          );
          peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
        }

        const baseline = await measureBaseline(corpus, quality);
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
          peakRssMiB: peakRssBytes / 1024 / 1024,
          baseline,
          gates: {
            recallAt5: RECALL_AT_5_GATE,
            mrrAt10: MRR_AT_10_GATE,
            maxRecallRegression: MAX_Q8_RECALL_REGRESSION,
            warmQueryP95Ms: WARM_QUERY_P95_MS_GATE,
            peakRssMiB: PEAK_RSS_MIB_GATE,
          },
          missedQueryIds: quality.missedQueryIds,
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
        expect(result.peakRssMiB).toBeLessThanOrEqual(PEAK_RSS_MIB_GATE);
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

interface BaselineQuality {
  readonly recallAt5: number;
  readonly mrrAt10: number;
  readonly missedQueryIds: readonly string[];
}

/**
 * The q8 non-inferiority check needs the same source revision at fp32. It is
 * reported as absent rather than assumed when those assets are not installed.
 */
async function measureBaseline(
  corpus: Awaited<ReturnType<typeof loadEvalCorpus>>,
  q8: RetrievalQuality,
): Promise<BaselineQuality | undefined> {
  if (fp32Directory === undefined) return undefined;
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
