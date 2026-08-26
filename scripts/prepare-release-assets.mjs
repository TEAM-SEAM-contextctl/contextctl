import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const workspaces = Object.freeze([
  { name: "@contextctl/contracts", asset: "contextctl-contracts.tgz" },
  {
    name: "@contextctl/selection-delivery",
    asset: "contextctl-selection-delivery.tgz",
  },
  {
    name: "@contextctl/registry-lifecycle",
    asset: "contextctl-registry-lifecycle.tgz",
  },
  {
    name: "@contextctl/ingestion-indexing",
    asset: "contextctl-ingestion-indexing.tgz",
  },
  { name: "@contextctl/daemon", asset: "contextctl-daemon.tgz" },
]);

const outputDirectory = parseOutputDirectory(process.argv.slice(2));
const version = await readIntegratedVersion();
const stagingDirectory = await mkdtemp(join(tmpdir(), "contextctl-release-assets-"));

try {
  await requireEmptyOutputDirectory(outputDirectory);
  const { stdout } = await execFileAsync(
    npmCommand,
    [
      "pack",
      "--json",
      "--pack-destination",
      stagingDirectory,
      "--cache",
      join(stagingDirectory, "npm-cache"),
      ...workspaces.flatMap((workspace) => ["--workspace", workspace.name]),
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const packed = parsePackResult(stdout);
  const checksumLines = [];

  for (const workspace of workspaces) {
    const metadata = packed.get(workspace.name);
    if (
      metadata === undefined ||
      metadata === null ||
      typeof metadata !== "object" ||
      typeof metadata.filename !== "string" ||
      metadata.version !== version
    ) {
      throw new Error(`${workspace.name} did not produce version ${version}`);
    }
    const source = join(stagingDirectory, metadata.filename);
    const destination = join(outputDirectory, workspace.asset);
    await copyFile(source, destination);
    checksumLines.push(`${await sha256(destination)}  ${workspace.asset}`);
  }

  checksumLines.sort((left, right) => left.localeCompare(right, "en"));
  await writeFile(
    join(outputDirectory, "SHA256SUMS"),
    `${checksumLines.join("\n")}\n`,
    "utf8",
  );
  process.stdout.write(
    `prepared ${workspaces.length} contextctl ${version} release assets in ${outputDirectory}\n`,
  );
} finally {
  await rm(stagingDirectory, { recursive: true, force: true });
}

function parseOutputDirectory(arguments_) {
  if (
    arguments_.length !== 2 ||
    arguments_[0] !== "--output" ||
    arguments_[1]?.trim() === ""
  ) {
    throw new Error(
      "usage: node scripts/prepare-release-assets.mjs --output <empty-directory>",
    );
  }
  return resolve(process.cwd(), arguments_[1]);
}

async function requireEmptyOutputDirectory(directory) {
  await mkdir(directory, { recursive: true });
  const entries = await readdir(directory);
  if (entries.length !== 0) {
    throw new Error(`release output directory is not empty: ${directory}`);
  }
}

async function readIntegratedVersion() {
  const manifest = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  );
  if (typeof manifest.version !== "string" || manifest.version.trim() === "") {
    throw new Error("root package.json does not declare a release version");
  }
  return manifest.version;
}

function parsePackResult(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("npm pack did not return JSON metadata");
  }
  const entries = Array.isArray(parsed)
    ? parsed.map((entry) => [entry.name, entry])
    : parsed !== null && typeof parsed === "object"
      ? Object.entries(parsed)
      : undefined;
  if (entries === undefined || entries.length !== workspaces.length) {
    throw new Error(
      `expected ${workspaces.length} packed workspaces, received ${entries?.length ?? "an invalid result"}`,
    );
  }
  return new Map(entries);
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
