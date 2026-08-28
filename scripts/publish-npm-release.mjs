import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createCommandRunners,
  dryRunCandidate,
  loadReleasePlan,
  prepareConsumerDirectory,
  promoteLatest,
  publishCandidate,
  PUBLIC_NPM_REGISTRY,
  verifyPublishedRelease,
} from "./lib/npm-release.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const parsed = parseArguments(process.argv.slice(2));
const plan = await loadReleasePlan(repositoryRoot);
const runners = createCommandRunners(repositoryRoot);

if (parsed.action === "dry-run") {
  await dryRunCandidate(plan, runners);
  process.stdout.write(
    `validated candidate dry-run for ${plan.packages.length} packages at ${plan.version}\n`,
  );
} else if (parsed.action === "candidate") {
  const published = await publishCandidate(plan, {
    ...runners,
    registry: parsed.registry,
    target: parsed.target,
    confirm: parsed.yes,
    provenance: parsed.provenance,
  });
  process.stdout.write(
    `published ${published.length} packages with candidate tag; verify the exact version before promotion\n`,
  );
} else {
  const promoted = await promoteLatest(plan, {
    ...runners,
    registry: parsed.registry,
    confirm: parsed.yes,
    verify: async (input) =>
      await verifyPublishedRelease({
        ...input,
        runNpm: runners.runNpm,
        runCommand: runners.runCommand,
        prepareConsumerDirectory,
      }),
  });
  process.stdout.write(
    `promoted ${promoted.length} packages to latest; @contextctl/daemon was last\n`,
  );
}

function parseArguments(arguments_) {
  const [action, ...rest] = arguments_;
  if (action === "dry-run") {
    if (rest.length !== 0) usage();
    return { action };
  }
  if (action !== "candidate" && action !== "promote") usage();

  const options = {
    action,
    target: action === "promote" ? "public" : undefined,
    registry: action === "promote" ? PUBLIC_NPM_REGISTRY : undefined,
    yes: false,
    provenance: false,
  };
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === "--yes") options.yes = true;
    else if (value === "--provenance") options.provenance = true;
    else if (value === "--target") options.target = requireValue(rest, ++index, value);
    else if (value === "--registry") options.registry = requireValue(rest, ++index, value);
    else usage();
  }
  if (options.target === undefined || options.registry === undefined) usage();
  if (action === "promote" && options.provenance) usage();
  return options;
}

function requireValue(arguments_, index, option) {
  const value = arguments_[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function usage() {
  throw new Error(
    "usage: node scripts/publish-npm-release.mjs dry-run | candidate --target <isolated|public> --registry <url> --yes [--provenance] | promote --yes",
  );
}
