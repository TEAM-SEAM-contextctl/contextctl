import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, isAbsolute, resolve } from "node:path";

import {
  isSafeRelativePath,
  LOCAL_EMBEDDING_ASSET_MANIFEST_FILE,
  serializeLocalEmbeddingAssetManifest,
  verifyLocalEmbeddingAssets,
  type LocalEmbeddingAssetFile,
  type LocalEmbeddingAssetManifest,
} from "./transformers-js-local-embedding-adapter.js";
import type { DocumentRetrievalEmbeddingProfile } from "../domain/embedding-profile.js";
import { EmbeddingProviderFault } from "../ports/embedding.js";

/**
 * Supplies the declared bytes of one asset. Implementations decide where the
 * bytes come from; the installer never widens the manifest it was given.
 */
export interface LocalEmbeddingAssetSource {
  read(path: string, signal?: AbortSignal): Promise<Uint8Array>;
}

export interface InstallLocalEmbeddingAssetsInput {
  readonly profile: DocumentRetrievalEmbeddingProfile;
  readonly manifest: LocalEmbeddingAssetManifest;
  /** Absolute directory the runtime will read from. */
  readonly targetDirectory: string;
  readonly source: LocalEmbeddingAssetSource;
  readonly signal?: AbortSignal;
}

export interface InstallLocalEmbeddingAssetsResult {
  readonly status: "already_installed" | "installed";
  readonly directory: string;
  readonly manifest: LocalEmbeddingAssetManifest;
  readonly installedBytes: number;
}

/**
 * Places a fixed asset revision into a managed directory.
 *
 * Every byte is checked against the manifest before it is written, the whole
 * set is re-verified in a staging directory, and only then does the staging
 * directory take the target's place. A failure anywhere removes the staging
 * directory, so a rejected install never leaves a partial one behind and the
 * previously installed revision keeps serving.
 */
export async function installLocalEmbeddingAssets(
  input: InstallLocalEmbeddingAssetsInput,
): Promise<InstallLocalEmbeddingAssetsResult> {
  const target = assertInstallTarget(input.targetDirectory);
  // Rejects a manifest that does not describe this profile's exact revision.
  const manifestText = assertManifestDescribesProfile(
    input.manifest,
    input.profile,
  );

  const existing = await verifiedManifest(target, input.profile);
  if (existing !== undefined) {
    return {
      status: "already_installed",
      directory: target,
      manifest: existing,
      installedBytes: totalBytes(existing.files),
    };
  }

  const staging = `${join(dirname(target), `.${basename(target)}`)}.install-${randomBytes(8).toString("hex")}`;
  const replaced = `${staging}.replaced`;
  try {
    await mkdir(staging, { recursive: true });
    for (const file of input.manifest.files) {
      await writeVerifiedAsset(staging, file, input.source, input.signal);
    }
    await writeFile(
      join(staging, LOCAL_EMBEDDING_ASSET_MANIFEST_FILE),
      manifestText,
      { encoding: "utf8" },
    );
    const manifest = await verifyLocalEmbeddingAssets(staging, input.profile);

    // The manifest file is written last, so a target without one never
    // verifies and is safe to replace.
    let hadPrevious = false;
    try {
      await rename(target, replaced);
      hadPrevious = true;
    } catch (error) {
      if (!isMissingEntry(error)) throw error;
      await mkdir(dirname(target), { recursive: true });
    }
    await rename(staging, target);
    if (hadPrevious) {
      await rm(replaced, { recursive: true, force: true });
    }
    return {
      status: "installed",
      directory: target,
      manifest,
      installedBytes: totalBytes(manifest.files),
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    await rm(replaced, { recursive: true, force: true });
    throw error instanceof EmbeddingProviderFault ? error : artifactUnavailable();
  }
}

/** Reads assets that an operator staged ahead of time for an offline install. */
export class DirectoryLocalEmbeddingAssetSource
  implements LocalEmbeddingAssetSource
{
  readonly #root: string;

  constructor(root: string) {
    this.#root = assertInstallTarget(root);
  }

  async read(path: string): Promise<Uint8Array> {
    if (!isSafeRelativePath(path)) throw artifactUnavailable();
    try {
      return await readFile(resolve(this.#root, path));
    } catch {
      throw artifactUnavailable();
    }
  }
}

async function writeVerifiedAsset(
  staging: string,
  file: LocalEmbeddingAssetFile,
  source: LocalEmbeddingAssetSource,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (!isSafeRelativePath(file.path)) throw artifactUnavailable();
  const bytes = await source.read(file.path, signal);
  if (
    bytes.byteLength !== file.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== file.sha256
  ) {
    throw artifactUnavailable();
  }
  const destination = resolve(staging, file.path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes, { flag: "wx" });
}

async function verifiedManifest(
  directory: string,
  profile: DocumentRetrievalEmbeddingProfile,
): Promise<LocalEmbeddingAssetManifest | undefined> {
  try {
    return await verifyLocalEmbeddingAssets(directory, profile);
  } catch {
    return undefined;
  }
}

/**
 * Cheap guard so an obviously wrong revision fails before any bytes move.
 * The manifest digest itself stays the verifier's job — recomputing it here
 * would duplicate the canonical form and could drift from it.
 */
function assertManifestDescribesProfile(
  manifest: LocalEmbeddingAssetManifest,
  profile: DocumentRetrievalEmbeddingProfile,
): string {
  const execution = profile.execution;
  if (execution?.kind !== "local") throw artifactUnavailable();
  const runtimeArtifact = manifest.files.find(
    (file) => file.path === execution.artifactPath,
  );
  if (
    manifest.repository !== execution.artifactRepository ||
    manifest.revision !== execution.artifactRevision ||
    runtimeArtifact?.sha256 !== execution.artifactSha256
  ) {
    throw artifactUnavailable();
  }
  // Also rejects malformed paths and unsorted or duplicated entries.
  return serializeLocalEmbeddingAssetManifest(manifest);
}

function assertInstallTarget(directory: string): string {
  if (!isAbsolute(directory) || directory.trim() === "") {
    throw artifactUnavailable();
  }
  return resolve(directory);
}

function totalBytes(files: readonly LocalEmbeddingAssetFile[]): number {
  return files.reduce((sum, file) => sum + file.bytes, 0);
}

function isMissingEntry(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function artifactUnavailable(): EmbeddingProviderFault {
  return new EmbeddingProviderFault("embedding_artifact_unavailable", false);
}
