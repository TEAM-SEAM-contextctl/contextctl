import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const targets = Object.freeze({
  qdrant: Object.freeze({
    requiredEnvironment: Object.freeze(["CONTEXTCTL_QDRANT_URL"]),
    testFile:
      "packages/ingestion-indexing/test/qdrant-vector-index.integration.test.ts",
  }),
  granite: Object.freeze({
    requiredEnvironment: Object.freeze([
      "CONTEXTCTL_GRANITE_ASSET_DIRECTORY",
    ]),
    testFile:
      "packages/ingestion-indexing/test/local-embedding-adapter.integration.test.ts",
  }),
  "document-retrieval": Object.freeze({
    requiredEnvironment: Object.freeze([
      "CONTEXTCTL_GRANITE_ASSET_DIRECTORY",
      "CONTEXTCTL_EVAL_RESULT_PATH",
    ]),
    testFile:
      "packages/ingestion-indexing/test/document-retrieval-eval.test.ts",
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
const child = spawn(
  process.execPath,
  [
    vitest,
    "run",
    target.testFile,
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

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal));
}

child.once("error", (error) => {
  console.error(`unable to start ${targetName} external test: ${error.message}`);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (signal !== null) {
    console.error(`external test ${targetName} terminated by ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});

function fail(message) {
  console.error(message);
  process.exit(2);
}
