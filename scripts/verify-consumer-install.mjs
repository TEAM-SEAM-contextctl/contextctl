import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const resultPath = process.env.CONTEXTCTL_CONSUMER_AUDIT_RESULT_PATH;
const workspaces = Object.freeze([
  "@contextctl/contracts",
  "@contextctl/ingestion-indexing",
  "@contextctl/registry-lifecycle",
  "@contextctl/selection-delivery",
  "@contextctl/daemon",
]);
const scenarios = Object.freeze([
  {
    name: "ingestion-library",
    packages: ["@contextctl/contracts", "@contextctl/ingestion-indexing"],
  },
  {
    name: "daemon-product",
    packages: workspaces,
  },
  {
    name: "integrated-release",
    packages: workspaces,
  },
]);

if (process.argv.length !== 2) {
  throw new Error("usage: node scripts/verify-consumer-install.mjs");
}

const temporaryRoot = await realpath(
  await mkdtemp(join(tmpdir(), "contextctl-consumer-audit-")),
);
const npmEnvironment = {
  ...process.env,
  npm_config_cache: join(temporaryRoot, "npm-cache"),
};
const result = {
  schemaVersion: 1,
  node: process.version,
  npm: await npmVersion(),
  scenarios: [],
};

try {
  const packageDirectory = join(temporaryRoot, "packages");
  await mkdir(packageDirectory, { recursive: true });
  const packed = await packWorkspaces(packageDirectory);
  for (const scenario of scenarios) {
    const scenarioResult = await verifyScenario(scenario, packed, temporaryRoot);
    result.scenarios.push(scenarioResult);
  }
  await persistResult(result);
  process.stdout.write(
    `verified ${scenarios.length} clean consumer dependency trees with no high or critical vulnerabilities\n`,
  );
} catch (error) {
  result.failure = error instanceof Error ? error.message : String(error);
  await persistResult(result);
  throw error;
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function npmVersion() {
  const { stdout } = await runNpm(["--version"]);
  return stdout.trim();
}

async function packWorkspaces(destination) {
  const { stdout } = await runNpm([
    "pack",
    "--json",
    "--pack-destination",
    destination,
    ...workspaces.flatMap((workspace) => ["--workspace", workspace]),
  ]);
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("npm pack did not return JSON metadata");
  }
  const entries = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === "object"
      ? Object.values(parsed)
      : undefined;
  if (entries === undefined || entries.length !== workspaces.length) {
    throw new Error(
      `expected ${workspaces.length} packed workspaces, received ${entries?.length ?? "an invalid result"}`,
    );
  }
  const packed = new Map();
  for (const entry of entries) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      typeof entry.name !== "string" ||
      typeof entry.filename !== "string"
    ) {
      throw new Error("npm pack returned invalid workspace metadata");
    }
    packed.set(entry.name, join(destination, entry.filename));
  }
  return packed;
}

async function verifyScenario(scenario, packed, root) {
  const directory = join(root, scenario.name);
  await mkdir(directory, { recursive: true });
  const tarballs = scenario.packages.map((name) => {
    const tarball = packed.get(name);
    if (tarball === undefined) {
      throw new Error(`${scenario.name}: missing tarball for ${name}`);
    }
    return tarball;
  });
  await runNpm([
    "install",
    "--omit",
    "dev",
    "--no-audit",
    "--no-fund",
    "--prefix",
    directory,
    ...tarballs,
  ]);

  const listed = await runNpm([
    "ls",
    "--all",
    "--json",
    "--prefix",
    directory,
  ]);
  const tree = parseJson(listed.stdout, `${scenario.name}: npm ls`);
  const versions = collectVersions(tree);
  assertSafeRuntimeTree(scenario.name, versions);

  const audit = await runNpmWithFailure([
    "audit",
    "--omit",
    "dev",
    "--audit-level",
    "high",
    "--json",
    "--prefix",
    directory,
  ]);
  const report = parseJson(audit.stdout, `${scenario.name}: npm audit`);
  if (report.error !== undefined) {
    throw new Error(
      `${scenario.name}: npm audit registry request failed: ${auditMessage(report.error)}`,
    );
  }
  const counts = report.metadata?.vulnerabilities;
  if (
    counts === undefined ||
    typeof counts.high !== "number" ||
    typeof counts.critical !== "number"
  ) {
    throw new Error(`${scenario.name}: npm audit omitted vulnerability counts`);
  }
  if (audit.exitCode !== 0 || counts.high !== 0 || counts.critical !== 0) {
    throw new Error(
      `${scenario.name}: consumer audit found high=${counts.high}, critical=${counts.critical}`,
    );
  }
  return {
    name: scenario.name,
    installedPackages: Number(report.metadata?.dependencies?.total ?? 0),
    vulnerabilities: {
      high: counts.high,
      critical: counts.critical,
    },
    runtime: {
      tokenizer: sortedVersions(versions, "@huggingface/tokenizers"),
      onnxruntimeNode: sortedVersions(versions, "onnxruntime-node"),
      admZip: sortedVersions(versions, "adm-zip"),
    },
    dependencyTree: normalizeDependencyTree(tree),
  };
}

function normalizeDependencyTree(node) {
  const normalized = {};
  if (typeof node.name === "string") normalized.name = node.name;
  if (typeof node.version === "string") normalized.version = node.version;
  const dependencies = node.dependencies;
  if (dependencies !== null && typeof dependencies === "object") {
    normalized.dependencies = Object.fromEntries(
      Object.entries(dependencies)
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .map(([name, dependency]) => [
          name,
          normalizeDependencyTree(
            dependency !== null && typeof dependency === "object"
              ? dependency
              : {},
          ),
        ]),
    );
  }
  return normalized;
}

function assertSafeRuntimeTree(scenario, versions) {
  for (const forbidden of ["@huggingface/transformers", "sharp"]) {
    if (versions.has(forbidden)) {
      throw new Error(`${scenario}: unused runtime package remained installed: ${forbidden}`);
    }
  }
  assertOnlyVersion(scenario, versions, "@huggingface/tokenizers", "0.1.3");
  assertOnlyVersion(scenario, versions, "onnxruntime-node", "1.29.0");
  const archiveVersions = sortedVersions(versions, "adm-zip");
  if (
    archiveVersions.length === 0 ||
    archiveVersions.some((version) => compareVersions(version, "0.6.0") < 0)
  ) {
    throw new Error(
      `${scenario}: adm-zip must resolve to 0.6.0 or newer, received ${archiveVersions.join(", ") || "none"}`,
    );
  }
}

function assertOnlyVersion(scenario, versions, name, expected) {
  const actual = sortedVersions(versions, name);
  if (actual.length !== 1 || actual[0] !== expected) {
    throw new Error(
      `${scenario}: ${name} must resolve only to ${expected}, received ${actual.join(", ") || "none"}`,
    );
  }
}

function collectVersions(root) {
  const result = new Map();
  const visit = (node, fallbackName) => {
    if (node === null || typeof node !== "object") return;
    const name = typeof node.name === "string" ? node.name : fallbackName;
    if (typeof name === "string" && typeof node.version === "string") {
      const found = result.get(name) ?? new Set();
      found.add(node.version);
      result.set(name, found);
    }
    if (node.dependencies !== null && typeof node.dependencies === "object") {
      for (const [dependencyName, dependency] of Object.entries(
        node.dependencies,
      )) {
        visit(dependency, dependencyName);
      }
    }
  };
  visit(root);
  return result;
}

function sortedVersions(versions, name) {
  return [...(versions.get(name) ?? [])].sort((left, right) =>
    left.localeCompare(right, "en"),
  );
}

function compareVersions(left, right) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(value);
  if (match === null) throw new Error(`cannot compare package version: ${value}`);
  return match.slice(1).map(Number);
}

function parseJson(value, context) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${context} did not return JSON`);
  }
}

function auditMessage(error) {
  if (typeof error === "string") return error;
  if (error !== null && typeof error === "object") {
    return String(error.summary ?? error.message ?? "unknown audit error");
  }
  return "unknown audit error";
}

async function persistResult(value) {
  if (resultPath === undefined) return;
  const destination = resolve(resultPath);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function runNpm(arguments_) {
  return await execFileAsync(npmCommand, arguments_, {
    cwd: repositoryRoot,
    env: npmEnvironment,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

async function runNpmWithFailure(arguments_) {
  try {
    const result = await runNpm(arguments_);
    return { ...result, exitCode: 0 };
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      typeof error.stdout === "string"
    ) {
      return {
        stdout: error.stdout,
        stderr: typeof error.stderr === "string" ? error.stderr : "",
        exitCode: typeof error.code === "number" ? error.code : 1,
      };
    }
    throw error;
  }
}
