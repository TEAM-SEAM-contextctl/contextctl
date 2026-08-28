import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { EXIT_CODES } from "../../src/cli/exit-codes.js";

/**
 * `contextctl status` on a machine that has nothing installed yet.
 *
 * The judgement has its own tests; this one is about the wiring, and the fresh
 * machine is the case wiring gets wrong. `contextctl reachability` shipped with
 * a branch outside the error guard and crashed here with a raw SQLite `unable to
 * open database file` — a first run has no home directory, no database, no assets
 * and no Cards, and every one of those is a legitimate state that has to arrive
 * as a sentence rather than a stack trace.
 *
 * Run as a process rather than by importing `runCli`, and that is not
 * ceremony: `cli/main.ts` is a `bin` target that dispatches on import, so
 * importing it here would run the CLI against vitest's own argv and set the
 * runner's exit code.
 */

const execFileAsync = promisify(execFile);

/** The symlink npm installs. Four levels up from `apps/<app>/test/cli/`. */
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
  await expect(
    access(INSTALLED_COMMAND),
    `${INSTALLED_COMMAND} is missing — run \`npm ci && npm run build\` first`,
  ).resolves.toBeUndefined();
});

async function freshHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "contextctl-status-"));
  directories.push(home);
  return home;
}

async function runStatusIn(
  home: string,
  args: readonly string[] = ["status"],
  environment: Readonly<Record<string, string>> = {},
): Promise<{ readonly stdout: string; readonly stderr: string; readonly code: number }> {
  try {
    const result = await execFileAsync(INSTALLED_COMMAND, [...args], {
      env: { ...process.env, ...environment, CONTEXTCTL_HOME: home },
      cwd: home,
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

describe("contextctl status on a fresh machine", () => {
  it("reports every lane instead of failing on the first missing thing", async () => {
    const result = await runStatusIn(await freshHome());

    for (const lane of ["resolve", "registry", "selection_assets", "ingestion"]) {
      expect(result.stdout).toContain(lane);
    }
  });

  it("exits with the lane code, not with a stack trace", async () => {
    const result = await runStatusIn(await freshHome());

    // No assets are installed, so two lanes cannot work. What matters is that it
    // arrives as the documented code: the reachability command's first run used
    // to arrive as an uncaught exception and exit 1.
    expect(result.code).toBe(EXIT_CODES.laneNotReady);
    expect(result.stderr).toContain("selection_assets");
    expect(result.stdout).toContain("not_ready");
  });

  it("keeps the report on stdout where a pipe preserves it", async () => {
    const result = await runStatusIn(await freshHome());

    // The failing lane's reason is in the report, so sending the whole thing to
    // stderr would leave a CI step holding the verdict and none of the cause.
    expect(result.stdout).toContain("contextctl install-assets");
  });

  it("reports the missing durable index as an Ingestion blocker", async () => {
    const result = await runStatusIn(await freshHome());
    const ingestionLine = result.stdout
      .split("\n")
      .find((line) => line.startsWith("ingestion"));

    expect(ingestionLine).toContain("not_ready");
    expect(ingestionLine).toContain("CONTEXTCTL_QDRANT_URL");
  });

  it("does not report a configured but unreachable Qdrant service as ready", async () => {
    const result = await runStatusIn(await freshHome(), ["status"], {
      // Port 1 is never a product endpoint. The transport-specific classifier
      // is covered with an injected fetch in vector-backend.test.ts; this
      // process test only proves the CLI no longer equates a valid URL with a
      // reachable service.
      CONTEXTCTL_QDRANT_URL: "http://127.0.0.1:1",
    });
    const lines = result.stdout.split("\n");

    for (const lane of ["resolve", "ingestion"]) {
      const line = lines.find((candidate) => candidate.startsWith(lane));
      expect(line).toContain("not_ready");
      expect(line).toContain("Qdrant에 연결할 수 없습니다");
    }
    expect(result.code).toBe(EXIT_CODES.laneNotReady);
  });

  it("reports Registry as ready on an empty database", async () => {
    const result = await runStatusIn(await freshHome());
    const registryLine = result.stdout
      .split("\n")
      .find((line) => line.startsWith("registry"));

    // Nothing published is not a delay. A first run that reported Registry
    // degraded would send an operator looking for a backlog that does not exist.
    expect(registryLine).toContain("ready");
    expect(registryLine).not.toContain("degraded");
  });

  it("does not create Ingestion's database just to look at it", async () => {
    const home = await freshHome();

    await runStatusIn(home);

    // The Ingestion store is opened lazily and only for Sources that have a
    // consumer cursor, of which a fresh machine has none. `cards approve` used to
    // create an `ingestion.db` it never read, and an operator then has to wonder
    // what wrote it.
    await expect(access(join(home, "ingestion.db"))).rejects.toThrow();
  });

  it("prints the same verdicts as JSON when asked", async () => {
    const result = await runStatusIn(await freshHome(), ["status", "--json"]);
    const parsed: unknown = JSON.parse(result.stdout);

    // The monitor-facing shape. A machine reading this must not have to parse
    // Korean sentences to find out which lane is down.
    expect(parsed).toMatchObject({
      serviceable: false,
      lanes: expect.arrayContaining([
        expect.objectContaining({ lane: "selection_assets", status: "not_ready" }),
      ]),
    });
  });

  it("exposes a stable Qdrant reason in JSON without requiring prose parsing", async () => {
    const result = await runStatusIn(await freshHome(), ["status", "--json"], {
      CONTEXTCTL_QDRANT_URL: "http://127.0.0.1:1",
    });
    const parsed = JSON.parse(result.stdout) as {
      readonly lanes: readonly {
        readonly lane: string;
        readonly reason?: unknown;
      }[];
    };

    expect(parsed.lanes.find((lane) => lane.lane === "ingestion")?.reason).toEqual({
      kind: "qdrant",
      code: expect.stringMatching(
        /^(connection_refused|timeout|unauthorized|invalid_response|unknown)$/u,
      ),
      endpoint: "http://127.0.0.1:1/",
    });
  });
});
