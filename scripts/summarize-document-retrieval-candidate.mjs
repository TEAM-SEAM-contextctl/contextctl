import { readFile, writeFile } from "node:fs/promises";

const EXPECTED_RUNS = 5;
const EXPECTED_PROFILE_ID =
  "document-granite-97m-multilingual-r2-q8-v1";
const EXPECTED_PEAK_RSS_MIB_GATE = 768;

const [evaluationPath, outputPath, ...probePaths] = process.argv.slice(2);
if (
  evaluationPath === undefined ||
  outputPath === undefined ||
  probePaths.length !== EXPECTED_RUNS ||
  new Set(probePaths).size !== EXPECTED_RUNS
) {
  console.error(
    "usage: node scripts/summarize-document-retrieval-candidate.mjs <evaluation-result> <summary-output> <five-distinct-probe-results>",
  );
  process.exit(2);
}

const evaluation = await readJson(evaluationPath);
const probes = await Promise.all(probePaths.map(readJson));
assertEvaluation(evaluation);
for (const probe of probes) assertProbe(probe);

const peakRssValues = probes.map((probe) => probe.peakRssMiB);
const resourceGatePassed = peakRssValues.every(
  (peakRssMiB) => peakRssMiB <= EXPECTED_PEAK_RSS_MIB_GATE,
);
const candidateObservationPassed =
  evaluation.absoluteQualityGatePassed === true &&
  evaluation.latencyGatePassed === true &&
  resourceGatePassed;
const releaseGatePassed =
  candidateObservationPassed &&
  evaluation.quantizedNonInferiorityPassed === true;

const summary = {
  schemaVersion: 1,
  measurement: "hosted-q8-candidate-5x-v1",
  evidenceAuthority: "hosted_observation",
  releaseEvidence: false,
  profileId: evaluation.profileId,
  artifactSha256: evaluation.artifactSha256,
  assetManifestSha256: evaluation.assetManifestSha256,
  environment: {
    nodeVersion: evaluation.nodeVersion,
    platform: evaluation.platform,
    cpuModel: evaluation.cpuModel,
    totalMemoryMiB: evaluation.totalMemoryMiB,
  },
  dataset: {
    id: evaluation.datasetId,
    version: evaluation.datasetVersion,
    digest: evaluation.datasetDigest,
    queryCount: evaluation.queryCount,
  },
  quality: {
    recallAt5: evaluation.recallAt5,
    mrrAt10: evaluation.mrrAt10,
    fp32Baseline: evaluation.baseline,
    recallRegression: evaluation.quantizedRecallRegression,
    absoluteGatePassed: evaluation.absoluteQualityGatePassed,
    nonInferiorityGatePassed: evaluation.quantizedNonInferiorityPassed,
  },
  latency: {
    warmQueryP95Ms: evaluation.warmQueryP95Ms,
    gateMs: evaluation.gates.warmQueryP95Ms,
    gatePassed: evaluation.latencyGatePassed,
  },
  resource: {
    batchSize: 32,
    runCount: EXPECTED_RUNS,
    peakRssMiBGate: EXPECTED_PEAK_RSS_MIB_GATE,
    minimumPeakRssMiB: Math.min(...peakRssValues),
    maximumPeakRssMiB: Math.max(...peakRssValues),
    allRunsPassed: resourceGatePassed,
    runs: probes,
  },
  candidateObservationPassed,
  releaseGatePassed,
};

await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

if (!candidateObservationPassed) {
  console.error(
    "Granite q8 failed an absolute quality, latency, or hosted RSS candidate gate.",
  );
  process.exitCode = 1;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function assertEvaluation(value) {
  const finiteNumbers = [
    value?.recallAt5,
    value?.mrrAt10,
    value?.warmQueryP95Ms,
    value?.quantizedRecallRegression,
    value?.gates?.warmQueryP95Ms,
    value?.gates?.peakRssMiB,
  ];
  if (
    value?.profileId !== EXPECTED_PROFILE_ID ||
    value?.qualityGateMode !== "candidate_observation" ||
    value?.resourceGateMode !== "hosted_observation" ||
    value?.quantized !== true ||
    value?.gates?.peakRssMiB !== EXPECTED_PEAK_RSS_MIB_GATE ||
    typeof value?.absoluteQualityGatePassed !== "boolean" ||
    typeof value?.latencyGatePassed !== "boolean" ||
    typeof value?.quantizedNonInferiorityPassed !== "boolean" ||
    value?.baseline === undefined ||
    finiteNumbers.some(
      (number) => typeof number !== "number" || !Number.isFinite(number),
    )
  ) {
    throw new Error("candidate evaluation result is invalid");
  }
}

function assertProbe(value) {
  const measurements = [
    value?.processStartRssMiB,
    value?.readyRssMiB,
    value?.modelReadyRssDeltaMiB,
    value?.modelLoadPeakRssMiB,
    value?.batchEndRssMiB,
    value?.observedBatchPeakRssMiB,
    value?.peakRssMiB,
    value?.batchRssDeltaMiB,
    value?.lifetimePeakRssMiB,
  ];
  if (
    value?.schemaVersion !== 1 ||
    value?.measurement !== "isolated-node-process-v1" ||
    value?.profileId !== EXPECTED_PROFILE_ID ||
    value?.batchSize !== 32 ||
    measurements.some(
      (number) =>
        typeof number !== "number" || !Number.isFinite(number) || number < 0,
    ) ||
    value.peakRssMiB < value.readyRssMiB ||
    value.modelLoadPeakRssMiB < value.readyRssMiB ||
    value.lifetimePeakRssMiB < value.modelLoadPeakRssMiB ||
    value.lifetimePeakRssMiB < value.peakRssMiB
  ) {
    throw new Error("candidate resource probe result is invalid");
  }
}
