/**
 * Installs the pinned local embedding assets the daemon needs to boot with a
 * production embedding profile.
 *
 * The revision, the file list, the byte counts and the sha256 digests all come
 * from `DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST` — this script never restates
 * them, so it cannot drift from the manifest the runtime verifies against.
 * Every byte is checked by `installLocalEmbeddingAssets` before it is placed,
 * and the placement is atomic: a rejected install leaves the previously
 * installed revision serving.
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
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

import {
  DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
  DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST,
  DirectoryLocalEmbeddingAssetSource,
  installLocalEmbeddingAssets,
} from "@contextctl/ingestion-indexing";

/** Where the assets go when nothing says otherwise. */
const DEFAULT_TARGET_DIRECTORY = resolve(
  homedir(),
  ".contextctl",
  "embedding-assets",
);

const HUGGING_FACE_ORIGIN = "https://huggingface.co";
/** A 372MB body over a home connection: generous, but not unbounded. */
const REQUEST_TIMEOUT_MS = 30 * 60 * 1000;
const DOWNLOAD_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2_000;

/**
 * Fetches a manifest's files from the repository revision it pins.
 *
 * The response is written into a buffer sized from the manifest, so a body
 * that runs long or short is rejected here rather than after 372MB have been
 * accumulated twice over.
 */
class HuggingFaceLocalEmbeddingAssetSource {
  #manifest;
  #log;

  constructor(manifest, log) {
    this.#manifest = manifest;
    this.#log = log;
  }

  async read(path, signal) {
    const file = this.#manifest.files.find((entry) => entry.path === path);
    if (file === undefined) {
      throw new Error(`asset is not in the manifest: ${path}`);
    }
    const url = `${HUGGING_FACE_ORIGIN}/${this.#manifest.repository}/resolve/${this.#manifest.revision}/${path}`;

    let lastError;
    for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
      signal?.throwIfAborted();
      try {
        return await this.#readOnce(url, file, attempt, signal);
      } catch (error) {
        if (signal?.aborted === true) throw error;
        lastError = error;
        this.#log(
          `  attempt ${attempt}/${DOWNLOAD_ATTEMPTS} failed: ${describe(error)}`,
        );
        if (attempt < DOWNLOAD_ATTEMPTS) {
          await delay(RETRY_DELAY_MS * attempt);
        }
      }
    }
    throw lastError;
  }

  async #readOnce(url, file, attempt, signal) {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const composed =
      signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

    this.#log(
      `  GET ${url}${attempt > 1 ? ` (attempt ${attempt})` : ""}`,
    );
    const response = await fetch(url, {
      signal: composed,
      redirect: "follow",
      headers: { accept: "application/octet-stream" },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    if (response.body === null) {
      throw new Error("response had no body");
    }

    // An early size check, and only that. content-length describes the *encoded*
    // body while fetch hands back the decoded one, so the header is comparable
    // only when nothing re-encoded the response — the small JSON files come back
    // brotli-compressed with no content-length at all. The real gate is the
    // exact-sized buffer below plus the installer's sha256.
    const declaredLength = response.headers.get("content-length");
    const encoding = response.headers.get("content-encoding");
    if (
      declaredLength !== null &&
      (encoding === null || encoding === "identity")
    ) {
      const declared = Number(declaredLength);
      if (!Number.isSafeInteger(declared) || declared !== file.bytes) {
        throw new Error(
          `content-length ${declaredLength} does not match the manifest's ${file.bytes}`,
        );
      }
    }

    // Exact-sized: the manifest already says how many bytes this file has.
    const bytes = new Uint8Array(file.bytes);
    let written = 0;
    let reported = 0;
    for await (const chunk of response.body) {
      if (written + chunk.byteLength > file.bytes) {
        throw new Error(
          `body is longer than the manifest's ${file.bytes} bytes`,
        );
      }
      bytes.set(chunk, written);
      written += chunk.byteLength;
      if (file.bytes >= 8 * 1024 * 1024 && written - reported >= 32 * 1024 * 1024) {
        reported = written;
        this.#log(
          `    ${formatBytes(written)} / ${formatBytes(file.bytes)} (${Math.floor((written / file.bytes) * 100)}%)`,
        );
      }
    }
    if (written !== file.bytes) {
      throw new Error(
        `body was ${written} bytes, the manifest says ${file.bytes}`,
      );
    }
    return bytes;
  }
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const manifest = DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST;
  const profile = DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE;
  const targetDirectory = resolveTargetDirectory(options.target);
  const totalBytes = manifest.files.reduce((sum, file) => sum + file.bytes, 0);

  log(`repository      ${manifest.repository}`);
  log(`revision        ${manifest.revision}`);
  log(`license         ${manifest.license}`);
  log(`profile         ${profile.id} (v${profile.version})`);
  log(`target          ${targetDirectory}`);
  log(
    `source          ${options.sourceDirectory === undefined ? "huggingface.co" : resolveDirectory(options.sourceDirectory)}`,
  );
  log(`files           ${manifest.files.length} (${formatBytes(totalBytes)})`);
  log("");

  const source =
    options.sourceDirectory === undefined
      ? new HuggingFaceLocalEmbeddingAssetSource(manifest, log)
      : new DirectoryLocalEmbeddingAssetSource(
          resolveDirectory(options.sourceDirectory),
        );

  const startedAt = Date.now();
  const result = await installLocalEmbeddingAssets({
    profile,
    manifest,
    targetDirectory,
    source,
  });
  const elapsedMs = Date.now() - startedAt;

  log("");
  log(`status          ${result.status}`);
  log(`directory       ${result.directory}`);
  log(
    `installed bytes ${result.installedBytes} (${formatBytes(result.installedBytes)})`,
  );
  log(`elapsed         ${(elapsedMs / 1000).toFixed(1)}s`);
  log("");
  log("Every file's sha256 and byte count were verified against the manifest.");
  log("Point the daemon at it with:");
  log(`  export CONTEXTCTL_EMBEDDING_ASSET_DIRECTORY=${result.directory}`);
  return 0;
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

/** --target beats the daemon's own variable, which beats the default. */
function resolveTargetDirectory(target) {
  const configured =
    target ?? process.env.CONTEXTCTL_EMBEDDING_ASSET_DIRECTORY;
  if (configured === undefined || configured.trim() === "") {
    return DEFAULT_TARGET_DIRECTORY;
  }
  return resolveDirectory(configured);
}

function resolveDirectory(directory) {
  const expanded = directory.startsWith("~/")
    ? resolve(homedir(), directory.slice(2))
    : directory;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(process.cwd(), expanded);
}

function usage() {
  return [
    "Usage: node apps/contextctl-daemon/scripts/install-embedding-assets.mjs [options]",
    "",
    "  --target <dir>            Install directory.",
    `                            Default: $CONTEXTCTL_EMBEDDING_ASSET_DIRECTORY, else ${DEFAULT_TARGET_DIRECTORY}`,
    "  --source-directory <dir>  Read bytes from a staged directory instead of downloading.",
    "  --help                    Print this text.",
  ].join("\n");
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function describe(error) {
  if (error instanceof Error) {
    return error.cause instanceof Error
      ? `${error.message} (${error.cause.message})`
      : error.message;
  }
  return String(error);
}

function delay(milliseconds) {
  return new Promise((settle) => setTimeout(settle, milliseconds));
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
