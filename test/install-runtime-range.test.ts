import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installer = join(repositoryRoot, "install.sh");
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function executable(
  directory: string,
  name: string,
  body: string,
): Promise<void> {
  const path = join(directory, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`, "utf8");
  await chmod(path, 0o755);
}

async function runWithNode(version: string): Promise<{
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const bin = await mkdtemp(join(tmpdir(), "contextctl-install-range-"));
  directories.push(bin);
  await executable(bin, "node", `printf '%s\\n' '${version}'`);
  await executable(bin, "npm", "exit 0");
  // A supported version proceeds as far as the download. Stop it there without
  // touching the network; an unsupported version must fail before this command.
  await executable(bin, "curl", "exit 1");

  return await new Promise((settle, reject) => {
    // Pin a syntactically valid release so this test isolates the Node range
    // decision from the separate latest-release resolution contract.
    const child = spawn("/bin/bash", [installer, "--version", "v1.2.3"], {
      cwd: repositoryRoot,
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => settle({ exitCode, stdout, stderr }));
  });
}

describe("release installer Node range", () => {
  it.each(["v23.99.0", "v24.17.9", "v25.0.0", "v26.3.1"])(
    "refuses unverified runtime %s before download",
    async (version) => {
      const result = await runWithNode(version);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("지원 범위는 24.18.0 이상 25 미만");
      expect(result.stdout).not.toContain("패키지를 내려받습니다");
    },
  );

  it.each(["v24.18.0", "v24.18.7", "v24.99.0"])(
    "accepts supported runtime %s before package download",
    async (version) => {
      const result = await runWithNode(version);

      // The injected curl deliberately stops the installer after the version
      // decision. Reaching it is the assertion; no release bytes are fetched.
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toContain(`Node.js ${version} 을 씁니다.`);
      expect(result.stdout).toContain("패키지와 SHA-256 목록을 내려받습니다");
      expect(result.stderr).not.toContain("지원 범위는");
    },
  );
});
