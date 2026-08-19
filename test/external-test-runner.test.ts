import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const runner = resolve(repositoryRoot, "scripts", "run-external-test.mjs");

describe("external test runner", () => {
  it("rejects an unknown target before starting Vitest", () => {
    const result = run(["unknown"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage: node scripts/run-external-test.mjs");
  });

  it("does not accept inherited object properties as targets", () => {
    const result = run(["toString"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage: node scripts/run-external-test.mjs");
  });

  it("fails closed when a required external dependency is not configured", () => {
    const environment = { ...process.env };
    delete environment["CONTEXTCTL_QDRANT_URL"];

    const result = run(["qdrant"], environment);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "requires CONTEXTCTL_QDRANT_URL; refusing to report a skipped test as success",
    );
  });

  it("requires a machine-readable result path for the release evaluation", () => {
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      CONTEXTCTL_GRANITE_ASSET_DIRECTORY: "/tmp/granite-assets",
    };
    delete environment["CONTEXTCTL_EVAL_RESULT_PATH"];

    const result = run(["document-retrieval"], environment);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "requires CONTEXTCTL_EVAL_RESULT_PATH; refusing to report a skipped test as success",
    );
  });
});

function run(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): { readonly status: number | null; readonly stderr: string } {
  const result = spawnSync(process.execPath, [runner, ...arguments_], {
    cwd: repositoryRoot,
    env: environment,
    encoding: "utf8",
  });
  return { status: result.status, stderr: result.stderr };
}
