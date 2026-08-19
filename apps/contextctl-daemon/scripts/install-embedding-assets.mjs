/**
 * Installs the pinned local embedding assets from a repository checkout.
 *
 * This is a launcher and nothing else. Every rule the install obeys — the
 * origin, the retry ladder, the exact-sized buffer, the consent text, the
 * progress reporting — lives in `src/cli/asset-installation.ts`, because the
 * same install is reachable as `contextctl install-assets` for anyone who
 * installed from npm rather than cloning. Two copies of a download that verifies
 * 396 MiB against pinned digests would drift, and the copy that drifted would be
 * the one nobody ran in CI.
 *
 * ★ It imports from `dist`, so it works only after `npm run build` at the
 * repository root. That is the same trade `bin/contextctl.mjs` makes, for the
 * same reason: a compiled launcher would be absent exactly when it is needed.
 *
 * Usage:
 *   node apps/contextctl-daemon/scripts/install-embedding-assets.mjs [options]
 *
 * Options:
 *   --target <dir>            Install directory. Default order:
 *                             --target > $CONTEXTCTL_EMBEDDING_ASSET_DIRECTORY
 *                             > ~/.contextctl/embedding-assets
 *   --source-directory <dir>  Read the bytes from a directory an operator
 *                             staged ahead of time instead of downloading.
 *   --help                    Print this text.
 *
 * Exit codes: 0 installed or already installed, 1 anything else.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MODULE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../dist/cli/asset-installation.js",
);

async function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const {
    describeAssetInstallationPlan,
    planAssetInstallation,
    resolveAssetInstallationTarget,
    runAssetInstallation,
  } = await loadModule();

  const targetDirectory = resolveAssetInstallationTarget({
    environment: process.env,
    ...(options.target === undefined ? {} : { override: options.target }),
  });
  const planInput = {
    targetDirectory,
    ...(options.sourceDirectory === undefined
      ? {}
      : { sourceDirectory: resolve(options.sourceDirectory) }),
  };

  log(describeAssetInstallationPlan(planAssetInstallation(planInput)));
  log("");

  // No prompt: a script run from a checkout is already an explicit request for
  // this exact install, and there is no terminal to assume. The prompt belongs
  // to `contextctl install-assets`, which is the entry point a user who did not
  // clone the repository actually reaches.
  const outcome = await runAssetInstallation({ ...planInput, progress: log });

  log("");
  log(`status          ${outcome.status}`);
  if (outcome.directory !== undefined) {
    log(`directory       ${outcome.directory}`);
    log(`installed bytes ${outcome.installedBytes}`);
    log(`elapsed         ${((outcome.elapsedMs ?? 0) / 1000).toFixed(1)}s`);
    log("");
    log("Every file's sha256 and byte count were verified against the manifest.");
    log("Point the daemon at it with:");
    log(`  export CONTEXTCTL_EMBEDDING_ASSET_DIRECTORY=${targetDirectory}`);
  }
  return 0;
}

/** The build step is the one failure this launcher can name better than the loader. */
async function loadModule() {
  try {
    return await import(pathToFileURL(MODULE_PATH).href);
  } catch (error) {
    if (
      error?.code === "ERR_MODULE_NOT_FOUND" &&
      error.message.includes("dist")
    ) {
      throw new Error(
        "contextctl is not built yet. Run `npm run build` in the repository root, then run this script again.",
      );
    }
    throw error;
  }
}

function parseArguments(argv) {
  const options = {
    help: false,
    target: undefined,
    sourceDirectory: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--target":
        options.target = requireValue(argv, (index += 1), "--target");
        break;
      case "--source-directory":
        options.sourceDirectory = requireValue(
          argv,
          (index += 1),
          "--source-directory",
        );
        break;
      default:
        throw new Error(`unknown argument: ${argument}\n\n${usage()}`);
    }
  }
  return options;
}

function requireValue(argv, index, name) {
  const value = argv[index];
  if (value === undefined || value.startsWith("-")) {
    throw new Error(`${name} needs a directory\n\n${usage()}`);
  }
  return value;
}

function usage() {
  return [
    "Usage: node apps/contextctl-daemon/scripts/install-embedding-assets.mjs [options]",
    "",
    "  Requires `npm run build` to have been run at the repository root.",
    "",
    "  --target <dir>            Install directory.",
    "                            Default: $CONTEXTCTL_EMBEDDING_ASSET_DIRECTORY,",
    "                            else ~/.contextctl/embedding-assets",
    "  --source-directory <dir>  Read bytes from a staged directory instead of downloading.",
    "  --help                    Print this text.",
  ].join("\n");
}

function describe(error) {
  if (error instanceof Error) {
    return error.cause instanceof Error
      ? `${error.message} (${error.cause.message})`
      : error.message;
  }
  return String(error);
}

/** Diagnostics go to stderr so stdout stays free for machine-readable output. */
function log(line) {
  process.stderr.write(`${line}\n`);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  log("");
  log(`install failed: ${describe(error)}`);
  if (error !== null && typeof error === "object" && "code" in error) {
    log(`fault code: ${String(error.code)}`);
    log(
      "embedding_artifact_unavailable is what the installer raises for any rejected byte — a sha256 or size that did not match the pinned manifest, or a download that never completed. The lines above say which. Nothing was installed and any previous install is untouched.",
    );
  }
  process.exitCode = 1;
}
