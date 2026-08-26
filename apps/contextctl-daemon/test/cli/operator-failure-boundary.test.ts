import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const installedCommand = fileURLToPath(
  new URL("../../../../node_modules/.bin/contextctl", import.meta.url),
);

const directories: string[] = [];

beforeAll(async () => {
  await expect(access(installedCommand)).resolves.toBeUndefined();
});

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("CLI operational failure boundary", () => {
  it("turns an asset source failure into one diagnostic instead of a stack trace", async () => {
    const root = await mkdtemp(join(tmpdir(), "contextctl-cli-failure-"));
    directories.push(root);

    let failure: {
      readonly code?: number;
      readonly stdout?: string;
      readonly stderr?: string;
    };
    try {
      await execFileAsync(
        installedCommand,
        [
          "install-assets",
          "--yes",
          "--target",
          join(root, "assets"),
          "--source-directory",
          join(root, "missing-source"),
        ],
        { cwd: root, env: { ...process.env, CONTEXTCTL_HOME: root } },
      );
      throw new Error("install-assets unexpectedly succeeded");
    } catch (error: unknown) {
      failure = error as typeof failure;
    }

    expect(failure.code).toBe(8);
    expect(failure.stdout ?? "").toBe("");
    expect(failure.stderr ?? "").toContain("contextctl install-assets");
    expect(failure.stderr ?? "").not.toContain("\n    at ");
  });
});
