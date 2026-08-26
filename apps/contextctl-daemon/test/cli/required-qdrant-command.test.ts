import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

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

beforeAll(async () => {
  await expect(access(INSTALLED_COMMAND)).resolves.toBeUndefined();
});

async function freshHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "contextctl-qdrant-required-"));
  directories.push(home);
  return home;
}

function environmentWithoutQdrant(home: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    CONTEXTCTL_HOME: home,
  };
  delete environment.CONTEXTCTL_QDRANT_URL;
  delete environment.CONTEXTCTL_QDRANT_API_KEY;
  return environment;
}

async function run(
  home: string,
  args: readonly string[],
): Promise<{ readonly stdout: string; readonly stderr: string; readonly code: number }> {
  try {
    const result = await execFileAsync(INSTALLED_COMMAND, [...args], {
      cwd: home,
      env: environmentWithoutQdrant(home),
      timeout: 5_000,
    });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error: unknown) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      code: failure.code ?? 1,
    };
  }
}

async function expectNoRuntimeState(home: string): Promise<void> {
  await expect(access(join(home, "registry.db"))).rejects.toThrow();
  await expect(access(join(home, "ingestion.db"))).rejects.toThrow();
}

describe("commands that require a durable vector index", () => {
  it.each([
    ["ingest", ["ingest"]],
    ["query", ["query", "휴가 규정"]],
    ["serve", ["serve"]],
    ["backup create", ["backup", "create", "backup"]],
    [
      "backup restore",
      ["backup", "restore", "backup", "--target-home", "restored"],
    ],
  ] as const)("refuses %s before creating durable state", async (_name, args) => {
    const home = await freshHome();

    const result = await run(home, args);

    expect(result.code).toBe(8);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("CONTEXTCTL_QDRANT_URL이 필요합니다");
    expect(result.stderr).toContain("qdrant_endpoint_required");
    await expectNoRuntimeState(home);
  });

  it("keeps Card inspection available without Qdrant or model assets", async () => {
    const home = await freshHome();

    const result = await run(home, ["cards", "list"]);

    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain("CONTEXTCTL_QDRANT_URL이 필요합니다");
    await expect(access(join(home, "registry.db"))).resolves.toBeUndefined();
    await expect(access(join(home, "ingestion.db"))).rejects.toThrow();
  });
});
