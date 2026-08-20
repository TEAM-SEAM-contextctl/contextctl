import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import {
  GRANITE_FP32_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
  GRANITE_Q4_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
  TransformersJsLocalEmbeddingAdapter,
} from "../packages/ingestion-indexing/dist/index.js";

const BATCH_SIZE = 32;
const MIB = 1024 * 1024;
const CORPUS_FILE = fileURLToPath(
  new URL(
    "../packages/ingestion-indexing/test/fixtures/document-retrieval-eval-v1/corpus.json",
    import.meta.url,
  ),
);

const profileVariant = process.argv[2];
const artifactDirectory = process.argv[3];
if (
  !(profileVariant === "fp32" || profileVariant === "q4") ||
  artifactDirectory === undefined ||
  !isAbsolute(artifactDirectory) ||
  process.argv.length !== 4
) {
  console.error(
    "usage: node scripts/run-document-retrieval-resource-probe.mjs <fp32|q4> <absolute-asset-directory>",
  );
  process.exit(2);
}

const profile =
  profileVariant === "q4"
    ? GRANITE_Q4_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE
    : GRANITE_FP32_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE;
const corpus = JSON.parse(await readFile(CORPUS_FILE, "utf8"));
const entries = readBatchEntries(corpus);
const processStartRssMiB = currentRssMiB();

const provider = new TransformersJsLocalEmbeddingAdapter({
  artifactDirectory,
  profile,
});
await provider.ready();
const readyRssMiB = currentRssMiB();
const modelLoadPeakRssMiB = lifetimePeakRssMiB();

const { value: outputs, peakRssMiB: batchPeakRssMiB } =
  await measureCurrentRssPeak(async () =>
    provider.embed({
      profile,
      inputs: entries,
      signal: new AbortController().signal,
    }),
  );
if (outputs.length !== BATCH_SIZE) {
  throw new Error(
    `resource probe expected ${BATCH_SIZE} outputs, received ${outputs.length}`,
  );
}
const batchEndRssMiB = currentRssMiB();
const lifetimePeakAfterBatchRssMiB = lifetimePeakRssMiB();

process.stdout.write(
  `${JSON.stringify({
    schemaVersion: 1,
    measurement: "isolated-node-process-v1",
    profileId: profile.id,
    batchSize: BATCH_SIZE,
    processStartRssMiB,
    readyRssMiB,
    modelReadyRssDeltaMiB: Math.max(0, readyRssMiB - processStartRssMiB),
    modelLoadPeakRssMiB,
    batchEndRssMiB,
    peakRssMiB: batchPeakRssMiB,
    batchRssDeltaMiB: Math.max(0, batchPeakRssMiB - readyRssMiB),
    lifetimePeakRssMiB: lifetimePeakAfterBatchRssMiB,
  })}\n`,
);

function readBatchEntries(input) {
  if (!Array.isArray(input?.chunks) || input.chunks.length < BATCH_SIZE) {
    throw new Error(`resource probe corpus requires at least ${BATCH_SIZE} chunks`);
  }
  return input.chunks.slice(0, BATCH_SIZE).map((entry, index) => {
    if (
      typeof entry?.id !== "string" ||
      entry.id.length === 0 ||
      typeof entry?.text !== "string" ||
      entry.text.length === 0
    ) {
      throw new Error(`resource probe corpus has an invalid chunk at ${index}`);
    }
    return { key: entry.id, text: entry.text };
  });
}

function currentRssMiB() {
  return process.memoryUsage.rss() / MIB;
}

function lifetimePeakRssMiB() {
  // Node normalizes ru_maxrss to KiB on every supported platform.
  return process.resourceUsage().maxRSS / 1024;
}

async function measureCurrentRssPeak(operation) {
  let peakRssMiB = currentRssMiB();
  const sampler = setInterval(() => {
    peakRssMiB = Math.max(peakRssMiB, currentRssMiB());
  }, 1);
  try {
    const value = await operation();
    peakRssMiB = Math.max(peakRssMiB, currentRssMiB());
    return { value, peakRssMiB };
  } finally {
    clearInterval(sampler);
  }
}
