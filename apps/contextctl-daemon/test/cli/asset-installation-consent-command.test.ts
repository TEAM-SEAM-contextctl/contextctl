import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST_SHA256,
} from "@contextctl/ingestion-indexing";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT_CODES } from "../../src/cli/exit-codes.js";

const execFileAsync = promisify(execFile);
const INSTALLED_COMMAND = fileURLToPath(
  new URL("../../../../node_modules/.bin/contextctl", import.meta.url),
);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function freshHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "contextctl-asset-consent-"));
  directories.push(home);
  return home;
}

async function runInstall(
  home: string,
  args: readonly string[] = ["install-assets"],
): Promise<{ readonly stdout: string; readonly stderr: string; readonly code: number }> {
  try {
    const result = await execFileAsync(INSTALLED_COMMAND, [...args], {
      cwd: home,
      env: { ...process.env, CONTEXTCTL_HOME: home },
    });
    return { ...result, code: 0 };
  } catch (error: unknown) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      code: failure.code ?? 1,
    };
  }
}

describe("contextctl install-assets consent outside a TTY", () => {
  it.each([
    ["network source", ["install-assets"]],
    [
      "staged source",
      ["install-assets", "--source-directory", "/srv/staged-assets"],
    ],
  ])("refuses a %s without --yes before reading any source", async (_name, args) => {
    const home = await freshHome();

    const result = await runInstall(home, args);

    expect(result.code).toBe(EXIT_CODES.usageError);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("비대화형 환경");
    expect(result.stderr).toContain("contextctl install-assets --yes");
  });

  it("does not require renewed consent for the already installed revision", async () => {
    const home = await freshHome();
    const managedRoot = join(home, "embedding-assets");
    await mkdir(managedRoot, { recursive: true });
    await writeFile(
      join(managedRoot, "active.json"),
      JSON.stringify({
        schemaVersion: 1,
        manifestSha256: DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST_SHA256,
        revisionDirectory: `revisions/${DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST_SHA256}`,
      }),
      "utf8",
    );

    const result = await runInstall(home);

    expect(result.code).toBe(EXIT_CODES.ok);
    expect(result.stdout).toContain("이미 설치돼 있습니다");
    expect(result.stderr).not.toContain("내려받습니다");
    expect(result.stderr).not.toContain("--yes");
  });
});
