import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * The installed command, executed the way an operator executes it.
 *
 * Every other test in this directory reaches the CLI's functions directly, and
 * not one of them could have caught the bug this file exists for: the entry
 * point guarded itself with `import.meta.url === pathToFileURL(process.argv[1])`,
 * which npm's `bin` symlink makes false for every real invocation. `runCli` was
 * correct, its unit tests were green, and `contextctl source list` printed
 * nothing and exited 0.
 *
 * So the subject here is not a function but a process, reached through
 * `node_modules/.bin/contextctl` specifically — the symlink, never the file it
 * points at. Resolving the path first would restore exactly the blind spot.
 */

const execFileAsync = promisify(execFile);

/** The symlink npm installs. Four levels up from `apps/<app>/test/cli/`. */
const INSTALLED_COMMAND = fileURLToPath(
  new URL("../../../../node_modules/.bin/contextctl", import.meta.url),
);

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/**
 * Fails loudly rather than skipping when the command is not installed.
 *
 * A skip would make a fresh clone green and hand back the silence this file was
 * written to end. CI runs `npm ci`, `npm run build`, then `npm test` in that
 * order, so the only way to arrive here without the command is to have skipped
 * a step — which is worth being told about.
 */
beforeAll(async () => {
  await expect(
    access(INSTALLED_COMMAND),
    `${INSTALLED_COMMAND} is missing — run \`npm ci && npm run build\` first`,
  ).resolves.toBeUndefined();
});

/**
 * Runs the command against a throwaway home.
 *
 * `CONTEXTCTL_HOME` is redirected because these invocations write a real
 * `sources.json`, and a test that reached into the developer's own
 * `~/.contextctl` would edit the state they are about to demo with.
 */
async function run(
  args: readonly string[],
  environment: Readonly<Record<string, string>> = {},
): Promise<{ readonly stdout: string; readonly stderr: string; readonly code: number }> {
  const home = await mkdtemp(join(tmpdir(), "contextctl-installed-"));
  directories.push(home);
  try {
    const result = await execFileAsync(INSTALLED_COMMAND, [...args], {
      env: { ...process.env, CONTEXTCTL_HOME: home, ...environment },
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

describe("the installed contextctl command", () => {
  it("prints usage rather than exiting silently", async () => {
    const result = await run(["--help"]);

    // The assertion the old guard would have failed: not "no error", but
    // "something was actually written". An entry point that never dispatched
    // exited 0 with empty streams, which every status-code check calls success.
    expect(result.code).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
    expect(result.stdout).toContain("contextctl source add");
  });

  it("answers a command that needs no runtime", async () => {
    const result = await run(["source", "list"]);

    // `source list` is the cheapest end-to-end proof: it reaches argument
    // parsing, the sources file and the renderer, and needs neither the 390MB
    // embedding artifact nor a vector backend, so it can run in every
    // environment this suite runs in.
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("등록된 Source가 없습니다");
  });

  it("dispatches Card inspection without requiring embedding assets", async () => {
    const result = await run(["cards", "show", "card_missing"]);

    // `cards show` arrived after the lazy command split. Exercising the npm bin
    // keeps its dynamic import in the dispatch table and proves that Registry
    // inspection still fails for the Card itself, not for an unrelated model.
    expect(result.code).toBe(8);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Card card_missing 를 찾을 수 없습니다");
    expect(result.stderr).not.toContain("install-assets");
  });

  it("exports demo documents through the installed command", async () => {
    const parent = await mkdtemp(join(tmpdir(), "contextctl-installed-demo-"));
    directories.push(parent);
    const destination = join(parent, "demo");

    const result = await run(["demo", "init", destination]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("데모 문서 5개를 준비했다");
    await expect(readFile(join(destination, "leave.md"), "utf8")).resolves.toContain(
      "반차는 오전 반차와 오후 반차로 나뉘며 연차 0.5일을 차감합니다.",
    );
  });

  it("persists a registered Source across two invocations", async () => {
    const home = await mkdtemp(join(tmpdir(), "contextctl-installed-"));
    directories.push(home);
    const document = fileURLToPath(
      new URL("../../demo/docs/payment.md", import.meta.url),
    );

    const added = await execFileAsync(INSTALLED_COMMAND, ["source", "add", document], {
      env: { ...process.env, CONTEXTCTL_HOME: home },
    });
    const listed = await execFileAsync(INSTALLED_COMMAND, ["source", "list"], {
      env: { ...process.env, CONTEXTCTL_HOME: home },
    });

    // Two processes, one file. The point of the CLI existing at all is that the
    // second invocation sees what the first wrote, and a silent entry point
    // reported success for both while writing nothing.
    expect(added.stdout).toContain("source.payment");
    expect(listed.stdout).toContain("source.payment");
    expect(listed.stdout).toContain(document);
  });

  it("reports a usage error on stderr with a non-zero status", async () => {
    const result = await run(["definitely-not-a-command"]);

    // The mirror of the first case. Silence is wrong on failure too: a wrapper
    // that swallowed dispatch would exit 0 here, and a script checking the
    // status would treat a typo as a completed command.
    expect(result.code).toBe(2);
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});
