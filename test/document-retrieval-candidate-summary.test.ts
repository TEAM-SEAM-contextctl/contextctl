import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const SCRIPT = resolve(
  "scripts/summarize-document-retrieval-candidate.mjs",
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("document retrieval candidate summary", () => {
  it("records five hosted observations without promoting them to release evidence", async () => {
    const fixture = await writeFixture([510, 520, 530, 540, 550]);

    await execFileAsync(process.execPath, [
      SCRIPT,
      fixture.evaluationPath,
      fixture.summaryPath,
      ...fixture.probePaths,
    ]);

    const summary = JSON.parse(await readFile(fixture.summaryPath, "utf8"));
    expect(summary).toMatchObject({
      evidenceAuthority: "hosted_observation",
      releaseEvidence: false,
      candidateObservationPassed: true,
      releaseGatePassed: false,
      resource: {
        runCount: 5,
        minimumPeakRssMiB: 510,
        maximumPeakRssMiB: 550,
        allRunsPassed: true,
      },
      quality: {
        absoluteGatePassed: true,
        nonInferiorityGatePassed: false,
      },
    });
  });

  it("fails the candidate observation when any run exceeds the RSS gate", async () => {
    const fixture = await writeFixture([510, 520, 769, 540, 550]);

    await expect(
      execFileAsync(process.execPath, [
        SCRIPT,
        fixture.evaluationPath,
        fixture.summaryPath,
        ...fixture.probePaths,
      ]),
    ).rejects.toMatchObject({ code: 1 });

    const summary = JSON.parse(await readFile(fixture.summaryPath, "utf8"));
    expect(summary.candidateObservationPassed).toBe(false);
    expect(summary.resource).toMatchObject({
      maximumPeakRssMiB: 769,
      allRunsPassed: false,
    });
  });

  it("fails after preserving a cross-platform quality regression", async () => {
    const fixture = await writeFixture([510, 520, 530, 540, 550], {
      absoluteQualityGatePassed: false,
      recallAt5: 0.624,
      mrrAt10: 0.49,
      quantizedRecallRegression: 0.327,
    });

    await expect(
      execFileAsync(process.execPath, [
        SCRIPT,
        fixture.evaluationPath,
        fixture.summaryPath,
        ...fixture.probePaths,
      ]),
    ).rejects.toMatchObject({ code: 1 });

    const summary = JSON.parse(await readFile(fixture.summaryPath, "utf8"));
    expect(summary).toMatchObject({
      candidateObservationPassed: false,
      quality: {
        recallAt5: 0.624,
        mrrAt10: 0.49,
        recallRegression: 0.327,
        absoluteGatePassed: false,
      },
      resource: { allRunsPassed: true },
    });
  });
});

async function writeFixture(
  peaks: readonly number[],
  evaluationOverrides: Readonly<Record<string, unknown>> = {},
) {
  const directory = await mkdtemp(resolve(tmpdir(), "contextctl-q8-summary-"));
  temporaryDirectories.push(directory);
  const evaluationPath = resolve(directory, "evaluation.json");
  const summaryPath = resolve(directory, "summary.json");
  const evaluation = {
    datasetId: "document-retrieval-eval-v1",
    datasetVersion: "1",
    datasetDigest: "a".repeat(64),
    profileId: "document-granite-97m-multilingual-r2-q8-v1",
    artifactSha256: "b".repeat(64),
    assetManifestSha256: "c".repeat(64),
    nodeVersion: process.version,
    platform: "linux-x64",
    cpuModel: "fixture",
    totalMemoryMiB: 16_384,
    queryCount: 165,
    recallAt5: 0.915,
    mrrAt10: 0.81,
    warmQueryP95Ms: 5,
    resourceGateMode: "hosted_observation",
    qualityGateMode: "candidate_observation",
    absoluteQualityGatePassed: true,
    latencyGatePassed: true,
    quantizedRecallRegression: 0.036,
    quantizedNonInferiorityPassed: false,
    baseline: { recallAt5: 0.951, mrrAt10: 0.87, missedQueryIds: [] },
    gates: {
      recallAt5: 0.9,
      mrrAt10: 0.75,
      maxRecallRegression: 0.02,
      warmQueryP95Ms: 100,
      peakRssMiB: 768,
    },
    quantized: true,
    ...evaluationOverrides,
  };
  await writeFile(evaluationPath, JSON.stringify(evaluation));

  const probePaths = await Promise.all(
    peaks.map(async (peakRssMiB, index) => {
      const path = resolve(directory, `probe-${index + 1}.json`);
      const probe = {
        schemaVersion: 1,
        measurement: "isolated-node-process-v1",
        profileId: "document-granite-97m-multilingual-r2-q8-v1",
        batchSize: 32,
        processStartRssMiB: 90,
        readyRssMiB: 480,
        modelReadyRssDeltaMiB: 390,
        modelLoadPeakRssMiB: 500,
        batchEndRssMiB: peakRssMiB,
        observedBatchPeakRssMiB: peakRssMiB,
        peakRssMiB,
        batchRssDeltaMiB: peakRssMiB - 500,
        lifetimePeakRssMiB: peakRssMiB,
      };
      await writeFile(path, JSON.stringify(probe));
      return path;
    }),
  );

  return { evaluationPath, summaryPath, probePaths };
}
