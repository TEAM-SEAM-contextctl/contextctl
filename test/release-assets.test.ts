import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const preparer = resolve(repositoryRoot, "scripts", "prepare-release-assets.mjs");
const expectedAssets = [
  "contextctl-contracts.tgz",
  "contextctl-daemon.tgz",
  "contextctl-ingestion-indexing.tgz",
  "contextctl-registry-lifecycle.tgz",
  "contextctl-selection-delivery.tgz",
] as const;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("release asset preparation", () => {
  it("produces the fixed installer asset names and matching SHA-256 values", () => {
    const output = temporaryDirectory();

    const result = run(["--output", output]);

    expect(result.status).toBe(0);
    expect(readdirSync(output).sort()).toEqual([
      "SHA256SUMS",
      ...expectedAssets,
    ].sort());
    const checksumLines = readFileSync(join(output, "SHA256SUMS"), "utf8")
      .trim()
      .split("\n");
    expect(checksumLines).toHaveLength(expectedAssets.length);
    for (const asset of expectedAssets) {
      expect(checksumLines).toContain(
        `${sha256(join(output, asset))}  ${asset}`,
      );
    }
  });

  it("refuses a non-empty output directory so releases cannot be mixed", () => {
    const output = temporaryDirectory();
    writeFileSync(join(output, "old-release.tgz"), "old");

    const result = run(["--output", output]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("release output directory is not empty");
  });
});

function run(arguments_: readonly string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [preparer, ...arguments_], {
    cwd: repositoryRoot,
    env: process.env,
    encoding: "utf8",
  });
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "contextctl-release-output-"));
  temporaryDirectories.push(directory);
  return directory;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
