import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertPublicReleaseRef,
  dryRunCandidate,
  hasTrustedPublishingEnvironment,
  loadReleasePlan,
  prepareConsumerDirectory,
  promoteLatest,
  publishCandidate,
  PUBLIC_NPM_REGISTRY,
  validateRegistryTarget,
  verifyPublishedRelease,
} from "../scripts/lib/npm-release.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("npm release plan", () => {
  it("derives a stable dependency order and keeps the daemon last", async () => {
    const plan = await loadReleasePlan(repositoryRoot);

    expect(plan.version).toBe("1.1.0");
    expect(plan.packages.map((entry) => entry.name)).toEqual([
      "@contextctl/contracts",
      "@contextctl/selection-delivery",
      "@contextctl/registry-lifecycle",
      "@contextctl/ingestion-indexing",
      "@contextctl/daemon",
    ]);
    expect(plan.packages.at(-1)?.product).toBe(true);
    expect(plan.packages.at(-1)?.dependencies).toEqual([
      "@contextctl/selection-delivery",
      "@contextctl/registry-lifecycle",
      "@contextctl/ingestion-indexing",
    ]);
  });

  it("restricts isolated publishing to loopback and public publishing to npmjs", () => {
    expect(validateRegistryTarget("http://127.0.0.1:4873", "isolated")).toBe(
      "http://127.0.0.1:4873/",
    );
    expect(validateRegistryTarget(PUBLIC_NPM_REGISTRY, "public")).toBe(
      PUBLIC_NPM_REGISTRY,
    );
    expect(() =>
      validateRegistryTarget("https://registry.example.com", "public"),
    ).toThrow("public publishing is restricted");
    expect(() =>
      validateRegistryTarget("https://registry.example.com", "isolated"),
    ).toThrow("requires a loopback Registry");
    expect(() =>
      validateRegistryTarget("http://user:secret@127.0.0.1:4873", "isolated"),
    ).toThrow("must not contain credentials");
  });

  it("recognises GitHub OIDC without treating unrelated CI variables as authentication", () => {
    expect(
      hasTrustedPublishingEnvironment({
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.example",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "opaque-token",
      }),
    ).toBe(true);
    expect(hasTrustedPublishingEnvironment({ GITHUB_ACTIONS: "true" })).toBe(false);
  });

  it("fails closed when a new public workspace is missing from the release DAG", async () => {
    const plan = await loadReleasePlan(repositoryRoot);
    const fixture = await mkdtemp(join(tmpdir(), "contextctl-release-plan-test-"));
    temporaryDirectories.push(fixture);
    await writeFile(
      join(fixture, "package.json"),
      await readFile(join(repositoryRoot, "package.json"), "utf8"),
    );
    for (const entry of plan.packages) {
      await mkdir(join(fixture, entry.directory), { recursive: true });
      await writeFile(
        join(fixture, entry.directory, "package.json"),
        await readFile(join(repositoryRoot, entry.directory, "package.json"), "utf8"),
      );
    }
    await mkdir(join(fixture, "packages", "new-public-package"));
    await writeFile(
      join(fixture, "packages", "new-public-package", "package.json"),
      JSON.stringify({
        name: "@contextctl/new-public-package",
        version: plan.version,
        publishConfig: { access: "public" },
      }),
    );

    await expect(loadReleasePlan(fixture)).rejects.toThrow(
      "release workspace coverage mismatch",
    );
  });
});

describe("candidate publishing", () => {
  it("dry-runs every package in DAG order", async () => {
    const plan = await loadReleasePlan(repositoryRoot);
    const calls = [];

    await dryRunCandidate(plan, {
      runNpm: async (arguments_) => {
        calls.push(arguments_);
        return success("{}");
      },
    });

    expect(calls).toHaveLength(5);
    expect(calls.map((arguments_) => arguments_[1])).toEqual(
      plan.packages.map((entry) => entry.absoluteDirectory),
    );
    expect(calls.every((arguments_) => arguments_.includes("--dry-run"))).toBe(
      true,
    );
  });

  it("publishes candidate packages in order and observes each exact version", async () => {
    const plan = await loadReleasePlan(repositoryRoot);
    const published = new Set();
    const publishOrder = [];
    const byDirectory = new Map(
      plan.packages.map((entry) => [entry.absoluteDirectory, entry.name]),
    );

    const result = await publishCandidate(plan, {
      target: "isolated",
      registry: "http://127.0.0.1:4873",
      confirm: true,
      provenance: false,
      runGit: async () => success(),
      wait: async () => undefined,
      runNpm: async (arguments_) => {
        if (arguments_[0] === "whoami") return success("release-test\n");
        if (arguments_[0] === "view") {
          const spec = arguments_[1];
          const name = spec.slice(0, spec.lastIndexOf("@"));
          if (spec.endsWith("@latest")) return failure("npm error code E404");
          return published.has(name)
            ? success(JSON.stringify(plan.version))
            : failure("npm error code E404");
        }
        if (arguments_[0] === "publish") {
          const name = byDirectory.get(arguments_[1]);
          publishOrder.push(name);
          published.add(name);
          return success();
        }
        throw new Error(`unexpected npm call: ${arguments_.join(" ")}`);
      },
    });

    expect(publishOrder).toEqual(plan.packages.map((entry) => entry.name));
    expect(publishOrder.at(-1)).toBe("@contextctl/daemon");
    expect(result).toEqual(
      plan.packages.map((entry) => `${entry.name}@${entry.version}`),
    );
  });

  it("waits through delayed public Registry visibility after npm accepts a package", async () => {
    const plan = await loadReleasePlan(repositoryRoot);
    const published = new Set();
    const exactChecks = new Map();
    const waits = vi.fn(async () => undefined);
    const report = vi.fn();
    const byDirectory = new Map(
      plan.packages.map((entry) => [entry.absoluteDirectory, entry.name]),
    );

    await publishCandidate(plan, {
      target: "isolated",
      registry: "http://127.0.0.1:4873",
      confirm: true,
      provenance: false,
      runGit: async () => success(),
      wait: waits,
      report,
      runNpm: async (arguments_) => {
        if (arguments_[0] === "whoami") return success("release-test\n");
        if (arguments_[0] === "publish") {
          published.add(byDirectory.get(arguments_[1]));
          return success();
        }
        if (arguments_[0] !== "view") {
          throw new Error(`unexpected npm call: ${arguments_.join(" ")}`);
        }
        expect(arguments_).toContain("--prefer-online");
        const spec = arguments_[1];
        const split = spec.lastIndexOf("@");
        const name = spec.slice(0, split);
        const selector = spec.slice(split + 1);
        if (!published.has(name) || selector === "latest") {
          return failure("npm error code E404");
        }
        if (name === "@contextctl/contracts" && selector === plan.version) {
          const checks = (exactChecks.get(name) ?? 0) + 1;
          exactChecks.set(name, checks);
          if (checks <= 7) return failure("npm error code E404");
        }
        return success(JSON.stringify(plan.version));
      },
    });

    expect(waits).toHaveBeenCalledTimes(7);
    expect(waits).toHaveBeenCalledWith(10_000);
    expect(report).toHaveBeenCalledWith(
      "npm accepted @contextctl/contracts@1.1.0; waiting for public Registry visibility",
    );
  });

  it("checks every package before writing and refuses immutable version reuse", async () => {
    const plan = await loadReleasePlan(repositoryRoot);
    const calls = [];

    await expect(
      publishCandidate(plan, {
        target: "isolated",
        registry: "http://localhost:4873",
        confirm: true,
        provenance: false,
        runGit: async () => success(),
        wait: async () => undefined,
        runNpm: async (arguments_) => {
          calls.push(arguments_);
          if (arguments_[0] === "whoami") return success("release-test\n");
          if (arguments_[0] !== "view") {
            throw new Error("publish must not start during preflight");
          }
          return arguments_[1] === "@contextctl/contracts@1.1.0"
            ? success(JSON.stringify("1.1.0"))
            : failure("npm error code E404");
        },
      }),
    ).rejects.toThrow("refusing to reuse an immutable release version");

    expect(calls.filter((arguments_) => arguments_[0] === "view")).toHaveLength(5);
    expect(calls.some((arguments_) => arguments_[0] === "publish")).toBe(false);
  });

  it("reports partial publication as requiring a new patch version", async () => {
    const plan = await loadReleasePlan(repositoryRoot);
    const published = new Set();
    const byDirectory = new Map(
      plan.packages.map((entry) => [entry.absoluteDirectory, entry.name]),
    );

    await expect(
      publishCandidate(plan, {
        target: "isolated",
        registry: "http://localhost:4873",
        confirm: true,
        provenance: false,
        runGit: async () => success(),
        wait: async () => undefined,
        runNpm: async (arguments_) => {
          if (arguments_[0] === "whoami") return success("release-test\n");
          if (arguments_[0] === "view") {
            const name = arguments_[1].slice(0, arguments_[1].lastIndexOf("@"));
            return published.has(name)
              ? success(JSON.stringify(plan.version))
              : failure("npm error code E404");
          }
          const name = byDirectory.get(arguments_[1]);
          if (name === "@contextctl/selection-delivery") {
            return failure("simulated Registry failure");
          }
          published.add(name);
          return success();
        },
      }),
    ).rejects.toThrow("Do not reuse 1.1.0; prepare a new patch version");
  });

  it("uses GitHub OIDC for public provenance publishing without a token-only whoami", async () => {
    const plan = await loadReleasePlan(repositoryRoot);
    const published = new Set();
    const calls = [];
    const byDirectory = new Map(
      plan.packages.map((entry) => [entry.absoluteDirectory, entry.name]),
    );

    await publishCandidate(plan, {
      target: "public",
      registry: PUBLIC_NPM_REGISTRY,
      confirm: true,
      provenance: true,
      environment: {
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.example",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "opaque-token",
      },
      runGit: publicReleaseGit(plan),
      wait: async () => undefined,
      runNpm: async (arguments_) => {
        calls.push(arguments_);
        if (arguments_[0] === "whoami") throw new Error("whoami must not run");
        if (arguments_[0] === "view") {
          const spec = arguments_[1];
          const name = spec.slice(0, spec.lastIndexOf("@"));
          if (spec.endsWith("@latest")) return failure("npm error code E404");
          return published.has(name)
            ? success(JSON.stringify(plan.version))
            : failure("npm error code E404");
        }
        const name = byDirectory.get(arguments_[1]);
        published.add(name);
        return success();
      },
    });

    expect(calls.filter((arguments_) => arguments_[0] === "publish")).toHaveLength(5);
    expect(
      calls
        .filter((arguments_) => arguments_[0] === "publish")
        .every((arguments_) => arguments_.includes("--provenance")),
    ).toBe(true);
  });

  it("removes latest when npm creates it automatically for a first publication", async () => {
    const plan = await loadReleasePlan(repositoryRoot);
    const published = new Set();
    const candidate = new Map();
    const latest = new Map();
    const removedLatest = [];
    const byDirectory = new Map(
      plan.packages.map((entry) => [entry.absoluteDirectory, entry.name]),
    );

    await publishCandidate(plan, {
      target: "public",
      registry: PUBLIC_NPM_REGISTRY,
      confirm: true,
      provenance: true,
      environment: {
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.example",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "opaque-token",
      },
      runGit: publicReleaseGit(plan),
      wait: async () => undefined,
      runNpm: async (arguments_) => {
        if (arguments_[0] === "view") {
          const spec = arguments_[1];
          const split = spec.lastIndexOf("@");
          const name = spec.slice(0, split);
          const selector = spec.slice(split + 1);
          if (selector === "latest") {
            return latest.has(name)
              ? success(JSON.stringify(latest.get(name)))
              : success("");
          }
          if (selector === "candidate") {
            return candidate.has(name)
              ? success(JSON.stringify(candidate.get(name)))
              : failure("npm error code E404");
          }
          return published.has(name)
            ? success(JSON.stringify(plan.version))
            : failure("npm error code E404");
        }
        if (arguments_[0] === "publish") {
          const name = byDirectory.get(arguments_[1]);
          published.add(name);
          candidate.set(name, plan.version);
          latest.set(name, plan.version);
          return success();
        }
        if (arguments_[0] === "dist-tag" && arguments_[1] === "rm") {
          const name = arguments_[2];
          removedLatest.push(name);
          latest.delete(name);
          return success();
        }
        throw new Error(`unexpected npm call: ${arguments_.join(" ")}`);
      },
    });

    expect(removedLatest).toEqual(plan.packages.map((entry) => entry.name));
    expect(latest.size).toBe(0);
  });

  it("stops when a Registry changes latest during candidate publication", async () => {
    const plan = await loadReleasePlan(repositoryRoot);
    let firstPackagePublished = false;

    await expect(
      publishCandidate(plan, {
        target: "public",
        registry: PUBLIC_NPM_REGISTRY,
        confirm: true,
        provenance: true,
        environment: {
          ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.example",
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "opaque-token",
        },
        runGit: publicReleaseGit(plan),
        wait: async () => undefined,
        runNpm: async (arguments_) => {
          if (arguments_[0] === "view") {
            if (!firstPackagePublished) return failure("npm error code E404");
            return success(
              JSON.stringify(
                arguments_[1].endsWith("@latest") ? "9.9.9" : plan.version,
              ),
            );
          }
          if (arguments_[0] === "publish") {
            firstPackagePublished = true;
            return success();
          }
          throw new Error(`unexpected npm call: ${arguments_.join(" ")}`);
        },
      }),
    ).rejects.toThrow("@latest changed during candidate publication");
  });
});

describe("public promotion", () => {
  it("verifies first, resumes idempotently, and promotes the daemon last", async () => {
    const plan = await loadReleasePlan(repositoryRoot);
    const latest = new Map([["@contextctl/contracts", plan.version]]);
    const distTagOrder = [];
    const verify = vi.fn(async () => undefined);

    await promoteLatest(plan, {
      registry: PUBLIC_NPM_REGISTRY,
      confirm: true,
      runGit: publicReleaseGit(plan),
      verify,
      runNpm: async (arguments_) => {
        if (arguments_[0] === "whoami") return success("release-operator\n");
        if (arguments_[0] === "view") {
          const spec = arguments_[1];
          const split = spec.lastIndexOf("@");
          const name = spec.slice(0, split);
          const tag = spec.slice(split + 1);
          if (tag === "candidate") return success(JSON.stringify(plan.version));
          if (tag === "latest") {
            return latest.has(name)
              ? success(JSON.stringify(latest.get(name)))
              : failure("npm error code E404");
          }
        }
        if (arguments_[0] === "dist-tag") {
          const spec = arguments_[2];
          const name = spec.slice(0, spec.lastIndexOf("@"));
          distTagOrder.push(name);
          latest.set(name, plan.version);
          return success();
        }
        throw new Error(`unexpected npm call: ${arguments_.join(" ")}`);
      },
    });

    expect(verify).toHaveBeenCalledTimes(1);
    expect(distTagOrder).toEqual(
      plan.packages.slice(1).map((entry) => entry.name),
    );
    expect(distTagOrder.at(-1)).toBe("@contextctl/daemon");
  });

  it("rejects dirty or untagged public release refs before mutation", async () => {
    const plan = await loadReleasePlan(repositoryRoot);

    await expect(
      assertPublicReleaseRef(plan, async (arguments_) =>
        arguments_[0] === "status" ? success(" M package.json\n") : success(),
      ),
    ).rejects.toThrow("requires a clean worktree");
  });
});

describe("published release verification", () => {
  it("checks metadata, global and local installs, audit, CLI, demo, and native load", async () => {
    const plan = await loadReleasePlan(repositoryRoot);
    const npmCalls = [];
    const commandCalls = [];

    await verifyPublishedRelease({
      plan,
      target: "isolated",
      registry: "http://127.0.0.1:4873",
      requireProvenance: false,
      prepareConsumerDirectory: async (consumer, temporaryRoot) => {
        await prepareConsumerDirectory(consumer, temporaryRoot);
        for (const entry of plan.packages) {
          const packageDirectory = join(
            consumer,
            "node_modules",
            ...entry.name.split("/"),
          );
          await mkdir(packageDirectory, { recursive: true });
          await writeFile(join(packageDirectory, "README.md"), "# Contextctl\n");
        }
      },
      runNpm: async (arguments_) => {
        npmCalls.push(arguments_);
        if (arguments_[0] === "view") {
          const version = arguments_[1].slice(arguments_[1].lastIndexOf("@") + 1);
          return success(
            JSON.stringify({
              version,
              license: "MIT",
              readme: "# Contextctl",
              dist: { tarball: "http://127.0.0.1:4873/package.tgz" },
            }),
          );
        }
        return success();
      },
      runCommand: async (command, arguments_) => {
        commandCalls.push([command, arguments_]);
        return arguments_[0] === "--version"
          ? success(`contextctl ${plan.version}\n`)
          : success();
      },
    });

    expect(npmCalls.filter((arguments_) => arguments_[0] === "view")).toHaveLength(5);
    expect(
      npmCalls.some(
        (arguments_) => arguments_[0] === "install" && arguments_.includes("--global"),
      ),
    ).toBe(true);
    expect(npmCalls.some((arguments_) => arguments_[0] === "audit")).toBe(true);
    expect(commandCalls.some(([, arguments_]) => arguments_[0] === "help")).toBe(true);
    expect(
      commandCalls.some(([, arguments_]) => arguments_.join(" ") === "demo init demo"),
    ).toBe(true);
    expect(commandCalls.some(([command]) => command === process.execPath)).toBe(true);
  });

  it("requires provenance metadata for public release verification", async () => {
    const plan = await loadReleasePlan(repositoryRoot);

    await expect(
      verifyPublishedRelease({
        plan,
        target: "public",
        registry: PUBLIC_NPM_REGISTRY,
        requireProvenance: true,
        prepareConsumerDirectory,
        runNpm: async () =>
          success(
            JSON.stringify({
              version: plan.version,
              license: "MIT",
              readme: "# Contextctl",
              dist: { tarball: "https://registry.npmjs.org/package.tgz" },
            }),
          ),
        runCommand: async () => success(),
      }),
    ).rejects.toThrow("did not publish provenance");
  });
});

function publicReleaseGit(plan) {
  return async (arguments_) => {
    const command = arguments_.join(" ");
    if (command === "fetch --quiet origin main --tags") return success();
    if (command.startsWith("status ")) return success();
    if (command === "branch --show-current") return success("main\n");
    if (command === "rev-parse HEAD" || command === "rev-parse origin/main") {
      return success("abc123\n");
    }
    if (command === "tag --points-at HEAD") return success(`${plan.releaseTag}\n`);
    throw new Error(`unexpected git call: ${command}`);
  };
}

function success(stdout = "") {
  return { exitCode: 0, stdout, stderr: "" };
}

function failure(stderr) {
  return { exitCode: 1, stdout: "", stderr };
}
