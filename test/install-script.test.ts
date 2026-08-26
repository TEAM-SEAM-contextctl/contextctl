import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installer = resolve(repositoryRoot, "install.sh");
const packageNames = [
  "contextctl-contracts",
  "contextctl-selection-delivery",
  "contextctl-registry-lifecycle",
  "contextctl-ingestion-indexing",
  "contextctl-daemon",
] as const;

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("release installer", () => {
  it("installs one explicitly selected release after verifying every package", () => {
    const fixture = createFixture();

    const result = runInstaller(fixture, ["--version", "v1.2.3"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("릴리스 v1.2.3 를 설치합니다.");
    expect(result.stdout.match(/\.tgz  [0-9a-f]{64}/g)).toHaveLength(5);
    const npmArguments = readFileSync(fixture.npmMarker, "utf8");
    expect(npmArguments).toMatch(/^install -g /);
    for (const name of packageNames) {
      expect(npmArguments).toContain(`/${name}.tgz`);
    }
    expect(result.stdout).toContain("contextctl 1.2.3");
  });

  it("resolves the latest tag before downloading a single release set", () => {
    const fixture = createFixture();

    const result = runInstaller(fixture);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("릴리스 v1.2.3 를 설치합니다.");
    expect(readFileSync(fixture.curlMarker, "utf8")).toContain(
      "/releases/latest",
    );
  });

  it("refuses a corrupted package before npm can install anything", () => {
    const fixture = createFixture();
    writeFileSync(
      join(fixture.releaseDirectory, "contextctl-ingestion-indexing.tgz"),
      "tampered after checksums were generated",
    );

    const result = runInstaller(fixture, ["--version", "v1.2.3"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SHA-256 검증에 실패했습니다");
    expect(result.stderr).toContain("npm 설치를 시작하지 않았습니다");
    expect(() => readFileSync(fixture.npmMarker)).toThrow();
  });

  it("requires exactly one valid checksum entry for every package", () => {
    for (const checksumMutation of ["missing", "duplicate", "malformed"] as const) {
      const fixture = createFixture(checksumMutation);

      const result = runInstaller(fixture, ["--version", "v1.2.3"]);

      expect(result.status, checksumMutation).toBe(1);
      expect(result.stderr).toContain("항목이 정확히 하나 있어야 합니다");
      expect(() => readFileSync(fixture.npmMarker)).toThrow();
    }
  });

  it("rejects unsupported Node versions before downloading release assets", () => {
    for (const nodeVersion of ["v24.17.9", "v26.0.0"] as const) {
      const fixture = createFixture("valid", nodeVersion);

      const result = runInstaller(fixture, ["--version", "v1.2.3"]);

      expect(result.status, nodeVersion).toBe(1);
      expect(result.stderr).toContain("24.18.0 이상인 24.x가 필요합니다");
      expect(() => readFileSync(fixture.curlMarker)).toThrow();
    }
  });

  it("rejects malformed release tags before downloading assets", () => {
    const fixture = createFixture();

    const result = runInstaller(fixture, ["--version", "v1.2.3/other"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("vX.Y.Z 형식이어야 합니다");
    expect(() => readFileSync(fixture.curlMarker)).toThrow();
  });

  it("refuses a stale contextctl that shadows the installed release on PATH", () => {
    const fixture = createFixture("valid", "v24.18.0", "1.2.2");

    const result = runInstaller(fixture, ["--version", "v1.2.3"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("PATH의 contextctl 이 요청한 릴리스와 다릅니다");
    expect(result.stderr).toContain("기대: contextctl 1.2.3");
    expect(result.stderr).toContain("실제: contextctl 1.2.2");
    expect(readFileSync(fixture.npmMarker, "utf8")).toMatch(/^install -g /);
  });
});

type ChecksumMutation = "valid" | "missing" | "duplicate" | "malformed";

function createFixture(
  checksumMutation: ChecksumMutation = "valid",
  nodeVersion = "v24.18.0",
  contextctlVersion = "1.2.3",
): {
  readonly root: string;
  readonly releaseDirectory: string;
  readonly binDirectory: string;
  readonly npmMarker: string;
  readonly curlMarker: string;
} {
  const root = mkdtempSync(join(tmpdir(), "contextctl-install-test-"));
  temporaryDirectories.push(root);
  const releaseDirectory = join(root, "release");
  const binDirectory = join(root, "bin");
  const npmMarker = join(root, "npm-called");
  const curlMarker = join(root, "curl-called");
  mkdirSync(releaseDirectory);
  mkdirSync(binDirectory);

  const checksums: string[] = [];
  for (const name of packageNames) {
    const filename = `${name}.tgz`;
    const contents = `fixture for ${filename}\n`;
    writeFileSync(join(releaseDirectory, filename), contents);
    checksums.push(`${sha256(contents)}  ${filename}`);
  }

  if (checksumMutation === "missing") {
    checksums.splice(2, 1);
  } else if (checksumMutation === "duplicate") {
    checksums.push(checksums[2]!);
  } else if (checksumMutation === "malformed") {
    checksums[2] = `not-a-digest  ${packageNames[2]}.tgz`;
  }
  writeFileSync(join(releaseDirectory, "SHA256SUMS"), `${checksums.join("\n")}\n`);

  writeExecutable(
    join(binDirectory, "node"),
    `#!/usr/bin/env bash\nprintf '%s\\n' '${nodeVersion}'\n`,
  );
  writeExecutable(
    join(binDirectory, "npm"),
    `#!/usr/bin/env bash\nif [ "\${1-}" = "prefix" ]; then\n  printf '%s\\n' "\${FAKE_GLOBAL_PREFIX}"\n  exit 0\nfi\nprintf '%s' "$*" > "\${FAKE_NPM_MARKER}"\n`,
  );
  writeExecutable(
    join(binDirectory, "contextctl"),
    `#!/usr/bin/env bash\nprintf '%s\\n' 'contextctl ${contextctlVersion}'\n`,
  );
  writeExecutable(
    join(binDirectory, "curl"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "\${FAKE_CURL_MARKER}"\noutput=''\nurl=''\nwhile [ "$#" -gt 0 ]; do\n  case "$1" in\n    -o) output="$2"; shift 2 ;;\n    -w) shift 2 ;;\n    --retry|--connect-timeout) shift 2 ;;\n    -*) shift ;;\n    *) url="$1"; shift ;;\n  esac\ndone\nif [ "\${output}" = '/dev/null' ]; then\n  printf '%s' 'https://github.com/TEAM-SEAM-contextctl/contextctl/releases/tag/v1.2.3'\n  exit 0\nfi\ncp "\${FAKE_RELEASE_DIRECTORY}/\${url##*/}" "\${output}"\n`,
  );

  return { root, releaseDirectory, binDirectory, npmMarker, curlMarker };
}

function runInstaller(
  fixture: ReturnType<typeof createFixture>,
  arguments_: readonly string[] = [],
): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  const result = spawnSync("/bin/bash", [installer, ...arguments_], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      PATH: `${fixture.binDirectory}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
      CONTEXTCTL_INSTALL_RELEASE_BASE: "https://fixture.invalid/v1.2.3",
      FAKE_RELEASE_DIRECTORY: fixture.releaseDirectory,
      FAKE_GLOBAL_PREFIX: fixture.root,
      FAKE_NPM_MARKER: fixture.npmMarker,
      FAKE_CURL_MARKER: fixture.curlMarker,
    },
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function sha256(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}
