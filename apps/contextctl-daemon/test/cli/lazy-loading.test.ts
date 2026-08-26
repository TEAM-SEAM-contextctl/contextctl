import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const installedCommand = fileURLToPath(
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

describe("lightweight CLI commands", () => {
  it.each([
    ["version", ["--version"]],
    ["help", ["--help"]],
    ["paths", ["paths"]],
    ["source list", ["source", "list"]],
  ] as const)("does not load the assembled runtime for %s", async (_name, args) => {
    const directory = await mkdtemp(join(tmpdir(), "contextctl-module-trace-"));
    directories.push(directory);
    const trace = join(directory, "resolved-modules.log");
    const hook = join(directory, "trace-hook.mjs");
    await writeFile(
      hook,
      [
        'import { appendFileSync } from "node:fs";',
        'import { registerHooks } from "node:module";',
        "registerHooks({",
        "  resolve(specifier, context, nextResolve) {",
        "    const result = nextResolve(specifier, context);",
        "    appendFileSync(process.env.CONTEXTCTL_TEST_MODULE_TRACE, `${result.url}\\n`);",
        "    return result;",
        "  },",
        "});",
      ].join("\n"),
      "utf8",
    );

    await execFileAsync(installedCommand, [...args], {
      env: {
        ...process.env,
        CONTEXTCTL_HOME: join(directory, "home"),
        CONTEXTCTL_TEST_MODULE_TRACE: trace,
        NODE_OPTIONS: [
          process.env["NODE_OPTIONS"],
          `--import=${pathToFileURL(hook).href}`,
        ]
          .filter(Boolean)
          .join(" "),
      },
    });
    const loaded = await readFile(trace, "utf8");

    expect(loaded).not.toContain("/ingestion-indexing/dist/index.js");
    expect(loaded).not.toContain("/contextctl-daemon/dist/main.js");
    expect(loaded).not.toContain("/contextctl-daemon/dist/cli/commands.js");
    expect(loaded).not.toContain("/contextctl-daemon/dist/cli/runtime.js");
  });

  it("reports paths without resolving any Ingestion module", async () => {
    const directory = await mkdtemp(join(tmpdir(), "contextctl-module-trace-"));
    directories.push(directory);
    const trace = join(directory, "resolved-modules.log");
    const hook = join(directory, "trace-hook.mjs");
    await writeFile(
      hook,
      'import { appendFileSync } from "node:fs";\nimport { registerHooks } from "node:module";\nregisterHooks({ resolve(s, c, n) { const r = n(s, c); appendFileSync(process.env.CONTEXTCTL_TEST_MODULE_TRACE, `${r.url}\\n`); return r; } });\n',
      "utf8",
    );

    await execFileAsync(installedCommand, ["paths"], {
      env: {
        ...process.env,
        CONTEXTCTL_HOME: join(directory, "home"),
        CONTEXTCTL_TEST_MODULE_TRACE: trace,
        NODE_OPTIONS: `--import=${pathToFileURL(hook).href}`,
      },
    });

    const loaded = await readFile(trace, "utf8");
    expect(loaded).toContain("/contextctl-daemon/dist/cli/paths-report.js");
    expect(loaded).not.toContain("/ingestion-indexing/");
  });
});
