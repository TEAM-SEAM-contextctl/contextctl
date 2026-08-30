import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org/";
export const CANDIDATE_TAG = "candidate";
export const LATEST_TAG = "latest";

const REGISTRY_OBSERVATION_ATTEMPTS = 60;
const REGISTRY_OBSERVATION_INTERVAL_MS = 10_000;

export const RELEASE_WORKSPACES = Object.freeze([
  Object.freeze({ directory: "packages/contracts" }),
  Object.freeze({ directory: "packages/selection-delivery" }),
  Object.freeze({ directory: "packages/registry-lifecycle" }),
  Object.freeze({ directory: "packages/ingestion-indexing" }),
  Object.freeze({ directory: "apps/contextctl-daemon", product: true }),
]);

export async function loadReleasePlan(repositoryRoot) {
  const rootManifest = await readManifest(resolve(repositoryRoot, "package.json"));
  if (rootManifest.private !== true) {
    throw new Error("the repository root must remain private");
  }
  await assertReleaseWorkspaceCoverage(repositoryRoot, rootManifest);
  const version = requireVersion(rootManifest, "root package.json");
  const packages = [];

  for (const definition of RELEASE_WORKSPACES) {
    const manifestPath = resolve(repositoryRoot, definition.directory, "package.json");
    const manifest = await readManifest(manifestPath);
    const name = requireString(manifest.name, `${definition.directory}/package.json name`);
    if (!name.startsWith("@contextctl/")) {
      throw new Error(`${definition.directory} must publish in the @contextctl scope`);
    }
    if (manifest.private === true || manifest.publishConfig?.access !== "public") {
      throw new Error(`${name} must be a public release workspace`);
    }
    const packageVersion = requireVersion(manifest, `${definition.directory}/package.json`);
    if (packageVersion !== version) {
      throw new Error(
        `${name} version ${packageVersion} does not match integrated version ${version}`,
      );
    }
    packages.push({
      name,
      version: packageVersion,
      directory: definition.directory,
      absoluteDirectory: dirname(manifestPath),
      product: definition.product === true,
      manifest,
      dependencies: [],
    });
  }

  const byName = new Map(packages.map((entry) => [entry.name, entry]));
  if (byName.size !== packages.length) {
    throw new Error("release workspace names must be unique");
  }

  for (const entry of packages) {
    const dependencies = collectInternalDependencies(entry.manifest, byName);
    for (const dependencyName of dependencies) {
      const declared = findDeclaredVersion(entry.manifest, dependencyName);
      if (declared !== version) {
        throw new Error(
          `${entry.name} must depend on ${dependencyName} at exact version ${version}, received ${declared}`,
        );
      }
    }
    entry.dependencies = dependencies;
  }

  const ordered = topologicalOrder(packages);
  const product = ordered.find((entry) => entry.product);
  if (product === undefined || product.name !== "@contextctl/daemon") {
    throw new Error("release plan must contain @contextctl/daemon as the product package");
  }
  if (ordered.at(-1)?.name !== product.name) {
    throw new Error("@contextctl/daemon must be published last");
  }

  return Object.freeze({
    schemaVersion: 1,
    version,
    releaseTag: `v${version}`,
    packages: Object.freeze(
      ordered.map((entry, index) =>
        Object.freeze({
          order: index + 1,
          name: entry.name,
          version: entry.version,
          directory: entry.directory,
          absoluteDirectory: entry.absoluteDirectory,
          product: entry.product,
          dependencies: Object.freeze([...entry.dependencies]),
        }),
      ),
    ),
  });
}

export function publicPlan(plan) {
  return {
    schemaVersion: plan.schemaVersion,
    version: plan.version,
    releaseTag: plan.releaseTag,
    candidateTag: CANDIDATE_TAG,
    latestPromotion: plan.packages.map((entry) => entry.name),
    packages: plan.packages.map((entry) => ({
      order: entry.order,
      name: entry.name,
      version: entry.version,
      directory: entry.directory,
      product: entry.product,
      dependencies: [...entry.dependencies],
    })),
  };
}

export function formatReleasePlan(plan) {
  const lines = [
    `contextctl npm release ${plan.version}`,
    `release tag: ${plan.releaseTag}`,
    "publish and latest-promotion order:",
  ];
  for (const entry of plan.packages) {
    const suffix = entry.product ? " (product; always last)" : "";
    lines.push(`  ${entry.order}. ${entry.name}@${entry.version}${suffix}`);
  }
  return `${lines.join("\n")}\n`;
}

export function validateRegistryTarget(registryValue, target) {
  const registry = normalizeRegistry(registryValue);
  const url = new URL(registry);
  const loopback =
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "::1";

  if (target === "public") {
    if (registry !== PUBLIC_NPM_REGISTRY) {
      throw new Error(
        `public publishing is restricted to ${PUBLIC_NPM_REGISTRY}; received ${registry}`,
      );
    }
    return registry;
  }
  if (target === "isolated") {
    if (!loopback) {
      throw new Error(
        `isolated publishing requires a loopback Registry; received ${registry}`,
      );
    }
    return registry;
  }
  throw new Error(`unknown release target: ${target}`);
}

export async function assertPublicReleaseRef(plan, runGit) {
  await requireSuccessful(
    await runGit(["fetch", "--quiet", "origin", "main", "--tags"]),
    "git fetch origin main --tags",
  );
  const status = await requireSuccessful(
    await runGit(["status", "--porcelain=v1", "--untracked-files=all"]),
    "git status",
  );
  if (status.stdout.trim() !== "") {
    throw new Error("public publishing requires a clean worktree");
  }

  const branch = await requireSuccessful(
    await runGit(["branch", "--show-current"]),
    "git branch",
  );
  if (branch.stdout.trim() !== "main") {
    throw new Error(
      `public publishing requires the main branch, received ${branch.stdout.trim() || "detached HEAD"}`,
    );
  }

  const [head, originMain, tags] = await Promise.all([
    requireSuccessful(await runGit(["rev-parse", "HEAD"]), "git rev-parse HEAD"),
    requireSuccessful(
      await runGit(["rev-parse", "origin/main"]),
      "git rev-parse origin/main",
    ),
    requireSuccessful(
      await runGit(["tag", "--points-at", "HEAD"]),
      "git tag --points-at HEAD",
    ),
  ]);
  if (head.stdout.trim() !== originMain.stdout.trim()) {
    throw new Error("public publishing requires HEAD to equal origin/main");
  }
  const tagSet = new Set(tags.stdout.split(/\r?\n/u).filter(Boolean));
  if (!tagSet.has(plan.releaseTag)) {
    throw new Error(
      `public publishing requires ${plan.releaseTag} to point at HEAD`,
    );
  }
}

export async function dryRunCandidate(plan, options) {
  const commands = [];
  for (const entry of plan.packages) {
    const arguments_ = [
      "publish",
      entry.absoluteDirectory,
      "--dry-run",
      "--json",
      "--access",
      "public",
      "--tag",
      CANDIDATE_TAG,
      "--registry",
      PUBLIC_NPM_REGISTRY,
    ];
    commands.push({ command: "npm", arguments: arguments_ });
    await requireSuccessful(
      await options.runNpm(arguments_),
      `npm publish --dry-run ${entry.name}`,
    );
  }
  return commands;
}

export async function publishCandidate(plan, options) {
  if (options.confirm !== true) {
    throw new Error("candidate publishing requires explicit --yes confirmation");
  }
  const registry = validateRegistryTarget(options.registry, options.target);
  if (options.target === "public") {
    if (options.provenance !== true) {
      throw new Error("public candidate publishing requires --provenance");
    }
    await assertPublicReleaseRef(plan, options.runGit);
  }
  if (
    options.target !== "public" ||
    !hasTrustedPublishingEnvironment(options.environment ?? process.env)
  ) {
    await requireSuccessful(
      await options.runNpm(["whoami", "--registry", registry]),
      "npm whoami",
    );
  }

  const existing = [];
  const latestBeforePublish = new Map();
  for (const entry of plan.packages) {
    if (
      (await readPublishedVersion(
        options.runNpm,
        entry.name,
        entry.version,
        registry,
      )) !== undefined
    ) {
      existing.push(`${entry.name}@${entry.version}`);
    }
    if (options.target === "public") {
      latestBeforePublish.set(
        entry.name,
        await readTaggedVersion(
          options.runNpm,
          entry.name,
          LATEST_TAG,
          registry,
        ),
      );
    }
  }
  if (existing.length > 0) {
    throw new Error(
      `refusing to reuse an immutable release version; already published: ${existing.join(", ")}`,
    );
  }

  const published = [];
  for (const entry of plan.packages) {
    const arguments_ = [
      "publish",
      entry.absoluteDirectory,
      "--access",
      "public",
      "--tag",
      CANDIDATE_TAG,
      "--registry",
      registry,
      ...(options.provenance === true ? ["--provenance"] : []),
    ];
    const result = await options.runNpm(arguments_);
    if (result.exitCode !== 0) {
      const partial = published.length === 0 ? "none" : published.join(", ");
      throw new Error(
        `candidate publish failed for ${entry.name}; already published in this attempt: ${partial}. Do not reuse ${plan.version}; prepare a new patch version. ${commandFailure(result)}`,
      );
    }
    options.report?.(
      `npm accepted ${entry.name}@${entry.version}; waiting for public Registry visibility`,
    );
    await waitForPublishedCandidate({
      runNpm: options.runNpm,
      name: entry.name,
      version: entry.version,
      tag: CANDIDATE_TAG,
      registry,
      wait: options.wait,
    });
    if (options.target === "public") {
      const latestBefore = latestBeforePublish.get(entry.name);
      const latest = await readTaggedVersion(
        options.runNpm,
        entry.name,
        LATEST_TAG,
        registry,
      );
      if (latestBefore === undefined && latest === entry.version) {
        await requireSuccessful(
          await options.runNpm([
            "dist-tag",
            "rm",
            entry.name,
            LATEST_TAG,
            "--registry",
            registry,
          ]),
          `remove npm-created ${entry.name}@${LATEST_TAG}`,
        );
        await waitForMissingTag({
          runNpm: options.runNpm,
          name: entry.name,
          tag: LATEST_TAG,
          registry,
          wait: options.wait,
        });
        options.report?.(
          `removed npm-created ${entry.name}@${LATEST_TAG}; candidate remains ${entry.version}`,
        );
      } else if (latest !== latestBefore) {
        throw new Error(
          `${entry.name}@latest changed during candidate publication; expected ${latestBefore ?? "no tag"}, received ${latest ?? "no tag"}. Stop promotion and investigate the Registry state.`,
        );
      }
    }
    published.push(`${entry.name}@${entry.version}`);
  }
  return published;
}

export function hasTrustedPublishingEnvironment(environment) {
  return (
    typeof environment.ACTIONS_ID_TOKEN_REQUEST_URL === "string" &&
    environment.ACTIONS_ID_TOKEN_REQUEST_URL !== "" &&
    typeof environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN === "string" &&
    environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN !== ""
  );
}

export async function promoteLatest(plan, options) {
  if (options.confirm !== true) {
    throw new Error("latest promotion requires explicit --yes confirmation");
  }
  const registry = validateRegistryTarget(options.registry, "public");
  await assertPublicReleaseRef(plan, options.runGit);
  await requireSuccessful(
    await options.runNpm(["whoami", "--registry", registry]),
    "npm whoami",
  );

  await options.verify({
    plan,
    registry,
    target: "public",
    requireProvenance: true,
  });

  for (const entry of plan.packages) {
    const candidate = await readTaggedVersion(
      options.runNpm,
      entry.name,
      CANDIDATE_TAG,
      registry,
    );
    if (candidate !== entry.version) {
      throw new Error(
        `${entry.name}@${CANDIDATE_TAG} must resolve to ${entry.version}, received ${candidate ?? "nothing"}`,
      );
    }
  }

  const promoted = [];
  for (const entry of plan.packages) {
    const current = await readTaggedVersion(
      options.runNpm,
      entry.name,
      LATEST_TAG,
      registry,
    );
    if (current === entry.version) {
      promoted.push(`${entry.name}@${entry.version} (already latest)`);
      continue;
    }
    await requireSuccessful(
      await options.runNpm([
        "dist-tag",
        "add",
        `${entry.name}@${entry.version}`,
        LATEST_TAG,
        "--registry",
        registry,
      ]),
      `npm dist-tag add ${entry.name}@${entry.version} latest`,
    );
    const observed = await readTaggedVersion(
      options.runNpm,
      entry.name,
      LATEST_TAG,
      registry,
    );
    if (observed !== entry.version) {
      throw new Error(
        `${entry.name}@latest did not resolve to ${entry.version} after promotion`,
      );
    }
    promoted.push(`${entry.name}@${entry.version}`);
  }
  return promoted;
}

export async function verifyPublishedRelease(options) {
  const registry = validateRegistryTarget(options.registry, options.target);
  const auditRegistry = normalizeRegistry(
    options.auditRegistry ?? PUBLIC_NPM_REGISTRY,
  );
  if (auditRegistry !== PUBLIC_NPM_REGISTRY) {
    throw new Error(
      `release security audit is restricted to ${PUBLIC_NPM_REGISTRY}; received ${auditRegistry}`,
    );
  }
  for (const entry of options.plan.packages) {
    const metadata = await readPublishedMetadata(
      options.runNpm,
      entry.name,
      entry.version,
      registry,
    );
    assertPublishedMetadata(entry, metadata, {
      requireProvenance: options.requireProvenance === true,
    });
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), "contextctl-npm-release-"));
  const environment = {
    ...process.env,
    npm_config_cache: join(temporaryRoot, "npm-cache"),
  };
  try {
    const product = options.plan.packages.at(-1);
    if (product?.product !== true) {
      throw new Error("release plan does not end with the product package");
    }
    const spec = `${product.name}@${product.version}`;
    const globalPrefix = join(temporaryRoot, "global");
    await requireSuccessful(
      await options.runNpm(
        [
          "install",
          "--global",
          "--prefix",
          globalPrefix,
          "--registry",
          registry,
          "--no-audit",
          "--no-fund",
          spec,
        ],
        { environment },
      ),
      "global daemon install",
    );
    const executable =
      process.platform === "win32"
        ? join(globalPrefix, "contextctl.cmd")
        : join(globalPrefix, "bin", "contextctl");
    const version = await requireSuccessful(
      await options.runCommand(executable, ["--version"], {
        cwd: temporaryRoot,
        environment,
      }),
      "installed contextctl --version",
    );
    if (version.stdout.trim() !== `contextctl ${product.version}`) {
      throw new Error(
        `installed contextctl reported ${JSON.stringify(version.stdout.trim())}, expected contextctl ${product.version}`,
      );
    }
    await requireSuccessful(
      await options.runCommand(executable, ["help"], {
        cwd: temporaryRoot,
        environment,
      }),
      "installed contextctl help",
    );
    await requireSuccessful(
      await options.runCommand(executable, ["demo", "init", "demo"], {
        cwd: temporaryRoot,
        environment,
      }),
      "installed contextctl demo init",
    );

    const consumer = join(temporaryRoot, "consumer");
    await writeFile(
      join(temporaryRoot, "consumer-package.json"),
      `${JSON.stringify({ name: "contextctl-release-verifier", version: "0.0.0", private: true })}\n`,
      "utf8",
    );
    await options.prepareConsumerDirectory(consumer, temporaryRoot);
    await requireSuccessful(
      await options.runNpm(
        [
          "install",
          "--prefix",
          consumer,
          "--registry",
          registry,
          "--no-audit",
          "--no-fund",
          spec,
        ],
        { environment },
      ),
      "local daemon install",
    );
    for (const entry of options.plan.packages) {
      const readme = await readFile(
        join(consumer, "node_modules", ...entry.name.split("/"), "README.md"),
        "utf8",
      );
      if (readme.trim() === "") {
        throw new Error(`${entry.name}@${entry.version} installed an empty README`);
      }
    }
    await requireSuccessful(
      await options.runNpm(
        ["ls", "--all", "--omit", "dev", "--prefix", consumer],
        { environment },
      ),
      "local daemon dependency tree",
    );
    await requireSuccessful(
      await options.runNpm(
        [
          "audit",
          "--omit",
          "dev",
          "--audit-level",
          "high",
          "--prefix",
          consumer,
          "--registry",
          auditRegistry,
        ],
        { environment },
      ),
      "local daemon dependency audit",
    );
    const nativeProbe = join(consumer, "verify-native.mjs");
    await writeFile(
      nativeProbe,
      'const runtime = await import("onnxruntime-node");\nif (typeof runtime.InferenceSession?.create !== "function") throw new Error("onnxruntime-node did not load");\n',
      "utf8",
    );
    await requireSuccessful(
      await options.runCommand(process.execPath, [nativeProbe], {
        cwd: consumer,
        environment,
      }),
      "onnxruntime-node native load",
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export function createCommandRunners(repositoryRoot) {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  return {
    runNpm: async (arguments_, options = {}) =>
      await runExecutable(npmCommand, arguments_, {
        cwd: repositoryRoot,
        environment: options.environment,
      }),
    runGit: async (arguments_) =>
      await runExecutable("git", arguments_, { cwd: repositoryRoot }),
    runCommand: async (command, arguments_, options = {}) =>
      await runExecutable(command, arguments_, options),
  };
}

export async function prepareConsumerDirectory(consumer, temporaryRoot) {
  const source = join(temporaryRoot, "consumer-package.json");
  const destination = join(consumer, "package.json");
  await mkdir(consumer, { recursive: true });
  await copyFile(source, destination);
}

async function readManifest(path) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(
      `cannot read package manifest ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`package manifest is not an object: ${path}`);
  }
  return parsed;
}

async function assertReleaseWorkspaceCoverage(repositoryRoot, rootManifest) {
  if (!Array.isArray(rootManifest.workspaces) || rootManifest.workspaces.length === 0) {
    throw new Error("root package.json must declare release workspaces");
  }
  const discovered = new Set();
  for (const pattern of rootManifest.workspaces) {
    if (typeof pattern !== "string" || !pattern.endsWith("/*")) {
      throw new Error(`unsupported workspace pattern in release plan: ${String(pattern)}`);
    }
    const parent = pattern.slice(0, -2);
    const entries = await readdir(resolve(repositoryRoot, parent), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = `${parent}/${entry.name}`;
      const manifest = await readManifest(
        resolve(repositoryRoot, directory, "package.json"),
      );
      if (manifest.private !== true) discovered.add(directory);
    }
  }

  const configured = new Set(RELEASE_WORKSPACES.map((entry) => entry.directory));
  const missing = [...discovered].filter((directory) => !configured.has(directory));
  const stale = [...configured].filter((directory) => !discovered.has(directory));
  if (missing.length > 0 || stale.length > 0) {
    throw new Error(
      `release workspace coverage mismatch; missing=${missing.join(", ") || "none"}; stale=${stale.join(", ") || "none"}`,
    );
  }
}

function requireVersion(manifest, context) {
  return requireString(manifest.version, `${context} version`);
}

function requireString(value, context) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${context} must be a non-empty string`);
  }
  return value;
}

function collectInternalDependencies(manifest, byName) {
  const result = [];
  for (const name of byName.keys()) {
    if (findDeclaredVersion(manifest, name) !== undefined) result.push(name);
  }
  return result;
}

function findDeclaredVersion(manifest, name) {
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    const collection = manifest[field];
    if (collection !== null && typeof collection === "object" && name in collection) {
      return collection[name];
    }
  }
  return undefined;
}

function topologicalOrder(packages) {
  const originalIndex = new Map(packages.map((entry, index) => [entry.name, index]));
  const remaining = new Map(packages.map((entry) => [entry.name, entry]));
  const completed = new Set();
  const result = [];

  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter((entry) => entry.dependencies.every((name) => completed.has(name)))
      .sort(
        (left, right) =>
          (originalIndex.get(left.name) ?? 0) - (originalIndex.get(right.name) ?? 0),
      );
    if (ready.length === 0) {
      throw new Error(
        `release workspace dependency cycle: ${[...remaining.keys()].join(", ")}`,
      );
    }
    for (const entry of ready) {
      result.push(entry);
      completed.add(entry.name);
      remaining.delete(entry.name);
    }
  }
  return result;
}

function normalizeRegistry(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`invalid npm Registry URL: ${value}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`npm Registry must use HTTP(S): ${value}`);
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      "npm Registry URL must not contain credentials, query parameters, or fragments",
    );
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}

async function readPublishedVersion(runNpm, name, version, registry) {
  const result = await runNpm([
    "view",
    `${name}@${version}`,
    "version",
    "--json",
    "--registry",
    registry,
    "--prefer-online",
  ]);
  if (result.exitCode !== 0) {
    if (isNotFound(result)) return undefined;
    throw new Error(`cannot query ${name}@${version}: ${commandFailure(result)}`);
  }
  const parsed = parseJson(result.stdout, `npm view ${name}@${version}`);
  if (parsed === version) return version;
  if (Array.isArray(parsed) && parsed.includes(version)) return version;
  return undefined;
}

async function readTaggedVersion(runNpm, name, tag, registry) {
  const result = await runNpm([
    "view",
    `${name}@${tag}`,
    "version",
    "--json",
    "--registry",
    registry,
    "--prefer-online",
  ]);
  if (result.exitCode !== 0) {
    if (isNotFound(result)) return undefined;
    throw new Error(`cannot query ${name}@${tag}: ${commandFailure(result)}`);
  }
  if (result.stdout.trim() === "") return undefined;
  const parsed = parseJson(result.stdout, `npm view ${name}@${tag}`);
  return typeof parsed === "string" ? parsed : undefined;
}

async function readPublishedMetadata(runNpm, name, version, registry) {
  const result = await runNpm([
    "view",
    `${name}@${version}`,
    "--json",
    "--registry",
    registry,
    "--prefer-online",
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`cannot read ${name}@${version}: ${commandFailure(result)}`);
  }
  return parseJson(result.stdout, `npm view ${name}@${version}`);
}

function assertPublishedMetadata(entry, metadata, options) {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error(`${entry.name}@${entry.version} returned invalid metadata`);
  }
  if (metadata.version !== entry.version) {
    throw new Error(`${entry.name} published version does not match ${entry.version}`);
  }
  if (metadata.license !== "MIT") {
    throw new Error(`${entry.name}@${entry.version} must publish the MIT license`);
  }
  if (typeof metadata.dist?.tarball !== "string" || metadata.dist.tarball === "") {
    throw new Error(`${entry.name}@${entry.version} did not publish a tarball URL`);
  }
  if (
    options.requireProvenance &&
    (metadata.dist?.attestations === undefined || metadata.dist?.attestations === null)
  ) {
    throw new Error(`${entry.name}@${entry.version} did not publish provenance`);
  }
}

async function waitForPublishedCandidate(options) {
  const wait = options.wait ?? (async (milliseconds) => {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
  });
  let observedVersion;
  let observedTag;
  for (let attempt = 1; attempt <= REGISTRY_OBSERVATION_ATTEMPTS; attempt += 1) {
    observedVersion = await readPublishedVersion(
      options.runNpm,
      options.name,
      options.version,
      options.registry,
    );
    if (observedVersion === options.version) {
      observedTag = await readTaggedVersion(
        options.runNpm,
        options.name,
        options.tag,
        options.registry,
      );
      if (observedTag === options.version) return;
    }
    if (attempt < REGISTRY_OBSERVATION_ATTEMPTS) {
      await wait(REGISTRY_OBSERVATION_INTERVAL_MS);
    }
  }
  if (observedVersion !== options.version) {
    throw new Error(
      `${options.name}@${options.version} was accepted by npm but was not observable after ${REGISTRY_OBSERVATION_ATTEMPTS} Registry checks. Do not reuse ${options.version}; prepare a new patch version`,
    );
  }
  throw new Error(
    `${options.name}@${options.tag} did not resolve to ${options.version} after ${REGISTRY_OBSERVATION_ATTEMPTS} Registry checks; received ${observedTag ?? "nothing"}`,
  );
}

async function waitForMissingTag(options) {
  const wait = options.wait ?? (async (milliseconds) => {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
  });
  let observed;
  for (let attempt = 1; attempt <= REGISTRY_OBSERVATION_ATTEMPTS; attempt += 1) {
    observed = await readTaggedVersion(
      options.runNpm,
      options.name,
      options.tag,
      options.registry,
    );
    if (observed === undefined) return;
    if (attempt < REGISTRY_OBSERVATION_ATTEMPTS) {
      await wait(REGISTRY_OBSERVATION_INTERVAL_MS);
    }
  }
  throw new Error(
    `${options.name}@${options.tag} still resolves to ${observed} after removal`,
  );
}

async function runExecutable(command, arguments_, options = {}) {
  try {
    const result = await execFileAsync(command, arguments_, {
      cwd: options.cwd,
      env: options.environment ?? process.env,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (error !== null && typeof error === "object") {
      return {
        exitCode: typeof error.code === "number" ? error.code : 1,
        stdout: typeof error.stdout === "string" ? error.stdout : "",
        stderr: typeof error.stderr === "string" ? error.stderr : String(error),
      };
    }
    return { exitCode: 1, stdout: "", stderr: String(error) };
  }
}

async function requireSuccessful(result, context) {
  if (result.exitCode !== 0) {
    throw new Error(`${context} failed: ${commandFailure(result)}`);
  }
  return result;
}

function isNotFound(result) {
  return /(?:E404|\b404\b|not found)/iu.test(`${result.stdout}\n${result.stderr}`);
}

function commandFailure(result) {
  const details = [result.stderr.trim(), result.stdout.trim()]
    .filter(Boolean)
    .map((value) => value.slice(-2_000))
    .join("\n");
  return details === "" ? `exit ${result.exitCode}` : details.slice(-3_000);
}

function parseJson(value, context) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${context} did not return JSON`);
  }
}
