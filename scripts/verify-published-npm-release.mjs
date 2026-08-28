import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createCommandRunners,
  loadReleasePlan,
  prepareConsumerDirectory,
  verifyPublishedRelease,
} from "./lib/npm-release.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const options = parseArguments(process.argv.slice(2));
const plan = await loadReleasePlan(repositoryRoot);
const runners = createCommandRunners(repositoryRoot);

await verifyPublishedRelease({
  plan,
  registry: options.registry,
  target: options.target,
  requireProvenance: options.requireProvenance,
  runNpm: runners.runNpm,
  runCommand: runners.runCommand,
  prepareConsumerDirectory,
});
process.stdout.write(
  `verified ${plan.packages.length} published packages and clean @contextctl/daemon@${plan.version} installs\n`,
);

function parseArguments(arguments_) {
  const options = { target: undefined, registry: undefined, requireProvenance: false };
  for (let index = 0; index < arguments_.length; index += 1) {
    const value = arguments_[index];
    if (value === "--require-provenance") options.requireProvenance = true;
    else if (value === "--target") options.target = requireValue(arguments_, ++index, value);
    else if (value === "--registry") options.registry = requireValue(arguments_, ++index, value);
    else usage();
  }
  if (options.target === undefined || options.registry === undefined) usage();
  if (options.target === "public" && !options.requireProvenance) {
    throw new Error("public release verification requires --require-provenance");
  }
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
    "usage: node scripts/verify-published-npm-release.mjs --target <isolated|public> --registry <url> [--require-provenance]",
  );
}
