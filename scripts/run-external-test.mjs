import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const targets = Object.freeze({
  qdrant: Object.freeze({
    requiredEnvironment: Object.freeze(["CONTEXTCTL_QDRANT_URL"]),
    testFiles: Object.freeze([
      "packages/ingestion-indexing/test/qdrant-vector-index.integration.test.ts",
      "apps/contextctl-daemon/test/ingestion-maintenance-worker.integration.test.ts",
      "apps/contextctl-daemon/test/state-backup-recovery.integration.test.ts",
    ]),
  }),
  granite: Object.freeze({
    requiredEnvironment: Object.freeze([
      "CONTEXTCTL_GRANITE_ASSET_DIRECTORY",
      "CONTEXTCTL_EMBEDDING_RUNTIME_RESULT_PATH",
    ]),
    testFiles: Object.freeze([
      "packages/ingestion-indexing/test/local-embedding-adapter.integration.test.ts",
      "apps/contextctl-daemon/test/embedding-runtime-load.integration.test.ts",
    ]),
    isolateTestFiles: true,
  }),
  "document-retrieval": Object.freeze({
    requiredEnvironment: Object.freeze([
      "CONTEXTCTL_GRANITE_ASSET_DIRECTORY",
      "CONTEXTCTL_EVAL_RESULT_PATH",
    ]),
    testFiles: Object.freeze([
      "packages/ingestion-indexing/test/document-retrieval-eval.test.ts",
    ]),
  }),
  "ingestion-indexing-benchmark": Object.freeze({
    requiredEnvironment: Object.freeze([
      "CONTEXTCTL_QDRANT_URL",
      "CONTEXTCTL_DOCUMENT_RETRIEVAL_RESULT_PATH",
      "CONTEXTCTL_INGESTION_BENCHMARK_RESULT_PATH",
    ]),
    testFiles: Object.freeze([
      "packages/ingestion-indexing/test/ingestion-indexing-benchmark.test.ts",
    ]),
  }),
});

const targetName = process.argv[2];
const target = Object.hasOwn(targets, targetName ?? "")
  ? targets[targetName]
  : undefined;

if (target === undefined || process.argv.length !== 3) {
  fail(
    `usage: node scripts/run-external-test.mjs <${Object.keys(targets).join("|")}>`,
  );
}

const missing = target.requiredEnvironment.filter((name) => {
  const value = process.env[name];
  return value === undefined || value.trim() === "";
});
if (missing.length > 0) {
  fail(
    `external test ${targetName} requires ${missing.join(", ")}; refusing to report a skipped test as success`,
  );
}

const vitest = resolve(repositoryRoot, "node_modules", "vitest", "vitest.mjs");
const testGroups = target.isolateTestFiles === true
  ? target.testFiles.map((file) => [file])
  : [target.testFiles];

for (const files of testGroups) {
  const code = await runVitest(files);
  if (code !== 0) {
    process.exitCode = code;
    break;
  }
}

function runVitest(files) {
  return new Promise((resolveExit) => {
    const child = spawn(
      process.execPath,
      [
        vitest,
        "run",
        ...files,
        "--pool=forks",
        "--maxWorkers=1",
        "--no-file-parallelism",
      ],
      {
        cwd: repositoryRoot,
        env: process.env,
        stdio: "inherit",
      },
    );
    const forward = (signal) => child.kill(signal);
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.once(signal, forward);
    }
    child.once("error", (error) => {
      console.error(`unable to start ${targetName} external test: ${error.message}`);
      resolveExit(1);
    });
    child.once("exit", (code, signal) => {
      for (const forwarded of ["SIGINT", "SIGTERM"]) {
        process.removeListener(forwarded, forward);
      }
      if (signal !== null) {
        console.error(`external test ${targetName} terminated by ${signal}`);
        resolveExit(1);
        return;
      }
      resolveExit(code ?? 1);
    });
  });
}

function fail(message) {
  console.error(message);
  process.exit(2);
}
