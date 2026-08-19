import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { DocumentRetrievalEmbeddingProfile } from "../domain/embedding-profile.js";
import { canonicalJson } from "../domain/revision-identity.js";
import { EmbeddingProviderFault } from "../ports/embedding.js";
import {
  isSafeRelativePath,
  LOCAL_EMBEDDING_ASSET_MANIFEST_FILE,
  serializeLocalEmbeddingAssetManifest,
  verifyLocalEmbeddingAssets,
  type LocalEmbeddingAssetFile,
  type LocalEmbeddingAssetManifest,
} from "./transformers-js-local-embedding-adapter.js";

export const LOCAL_EMBEDDING_ACTIVE_POINTER_FILE = "active.json";
const ACTIVE_POINTER_SCHEMA_VERSION = 1;
const MAX_ACTIVE_POINTER_BYTES = 8 * 1024;
const SHA256_HEX = /^[a-f0-9]{64}$/;

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
  /** Absolute managed root containing immutable revisions and active.json. */
  readonly targetDirectory: string;
  readonly source: LocalEmbeddingAssetSource;
  readonly signal?: AbortSignal;
}

export interface InstallLocalEmbeddingAssetsResult {
  readonly status: "already_installed" | "installed";
  /** Exact immutable revision directory suitable for the runtime adapter. */
  readonly directory: string;
  readonly manifest: LocalEmbeddingAssetManifest;
  readonly installedBytes: number;
}

interface ActiveAssetPointer {
  readonly schemaVersion: 1;
  readonly manifestSha256: string;
  readonly revisionDirectory: string;
}

/**
 * Installs one verified immutable revision, then atomically moves only a small
 * active pointer. A failed or interrupted install never moves or deletes the
 * previously active revision.
 */
export async function installLocalEmbeddingAssets(
  input: InstallLocalEmbeddingAssetsInput,
): Promise<InstallLocalEmbeddingAssetsResult> {
  const root = assertInstallTarget(input.targetDirectory);
  const manifestText = assertManifestDescribesProfile(
    input.manifest,
    input.profile,
  );
  const active = await resolveActiveLocalEmbeddingAssets(root, input.profile);
  if (active !== undefined) {
    return {
      status: "already_installed",
      directory: active.directory,
      manifest: active.manifest,
      installedBytes: totalBytes(active.manifest.files),
    };
  }

  const manifestSha256 = requiredManifestSha256(input.profile);
  const revisionsRoot = join(root, "revisions");
  const revisionDirectory = join(revisionsRoot, manifestSha256);
  const staging = join(
    root,
    `.staging-${manifestSha256}-${randomBytes(8).toString("hex")}`,
  );
  const pointerTemporary = join(
    root,
    `.active-${randomBytes(8).toString("hex")}.tmp`,
  );
  let installedBytes = 0;
  try {
    input.signal?.throwIfAborted();
    await mkdir(root, { recursive: true });
    await mkdir(revisionsRoot, { recursive: true });

    let manifest = await verifiedManifest(revisionDirectory, input.profile);
    if (manifest === undefined) {
      if (await entryExists(revisionDirectory)) {
        throw artifactUnavailable();
      }
      await mkdir(staging, { recursive: false });
      for (const file of input.manifest.files) {
        await writeVerifiedAsset(staging, file, input.source, input.signal);
        installedBytes += file.bytes;
      }
      await writeDurableFile(
        join(staging, LOCAL_EMBEDDING_ASSET_MANIFEST_FILE),
        Buffer.from(manifestText, "utf8"),
      );
      await syncDirectoryTree(staging, input.manifest.files);
      manifest = await verifyLocalEmbeddingAssets(staging, input.profile);
      try {
        await rename(staging, revisionDirectory);
      } catch (error) {
        const raced = await verifiedManifest(revisionDirectory, input.profile);
        if (raced === undefined) throw error;
        manifest = raced;
      }
      await syncDirectory(revisionsRoot);
    }

    input.signal?.throwIfAborted();
    const pointer = serializeActivePointer({
      schemaVersion: ACTIVE_POINTER_SCHEMA_VERSION,
      manifestSha256,
      revisionDirectory: `revisions/${manifestSha256}`,
    });
    await writeDurableFile(pointerTemporary, Buffer.from(pointer, "utf8"));
    await rename(pointerTemporary, join(root, LOCAL_EMBEDDING_ACTIVE_POINTER_FILE));
    await syncDirectory(root);
    return {
      status: "installed",
      directory: revisionDirectory,
      manifest,
      installedBytes:
        installedBytes === 0 ? totalBytes(manifest.files) : installedBytes,
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    await rm(pointerTemporary, { force: true });
    throw error instanceof EmbeddingProviderFault ? error : artifactUnavailable();
  }
}

/** Resolves only the exact verified active revision for the supplied profile. */
export async function resolveActiveLocalEmbeddingAssets(
  targetDirectory: string,
  profile: DocumentRetrievalEmbeddingProfile,
): Promise<
  | {
      readonly directory: string;
      readonly manifest: LocalEmbeddingAssetManifest;
    }
  | undefined
> {
  const root = assertInstallTarget(targetDirectory);
  try {
    const bytes = await readFile(
      join(root, LOCAL_EMBEDDING_ACTIVE_POINTER_FILE),
    );
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_ACTIVE_POINTER_BYTES) {
      return undefined;
    }
    const pointer = parseActivePointer(JSON.parse(bytes.toString("utf8")));
    if (pointer.manifestSha256 !== requiredManifestSha256(profile)) {
      return undefined;
    }
    const directory = resolve(root, pointer.revisionDirectory);
    if (!isPathInside(root, directory)) return undefined;
    const manifest = await verifyLocalEmbeddingAssets(directory, profile);
    return { directory, manifest };
  } catch {
    return undefined;
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
  await writeDurableFile(destination, bytes);
}

async function writeDurableFile(
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectoryTree(
  root: string,
  files: readonly LocalEmbeddingAssetFile[],
): Promise<void> {
  const directories = new Set([root]);
  for (const file of files) {
    let current = dirname(resolve(root, file.path));
    while (isPathInside(root, current)) {
      directories.add(current);
      if (current === root) break;
      current = dirname(current);
    }
  }
  for (const directory of [...directories].sort().reverse()) {
    await syncDirectory(directory);
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    await handle.close();
  }
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "EINVAL" ||
      error.code === "ENOTSUP" ||
      error.code === "EPERM")
  );
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

async function entryExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissingEntry(error)) return false;
    throw error;
  }
}

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
  return serializeLocalEmbeddingAssetManifest(manifest);
}

function requiredManifestSha256(
  profile: DocumentRetrievalEmbeddingProfile,
): string {
  const execution = profile.execution;
  if (
    execution.kind !== "local" ||
    !SHA256_HEX.test(execution.assetManifestSha256)
  ) {
    throw artifactUnavailable();
  }
  return execution.assetManifestSha256;
}

function parseActivePointer(input: unknown): ActiveAssetPointer {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    canonicalJson(Object.keys(input).sort()) !==
      canonicalJson(
        ["manifestSha256", "revisionDirectory", "schemaVersion"].sort(),
      )
  ) {
    throw artifactUnavailable();
  }
  const candidate = input as Record<string, unknown>;
  if (
    candidate.schemaVersion !== ACTIVE_POINTER_SCHEMA_VERSION ||
    typeof candidate.manifestSha256 !== "string" ||
    !SHA256_HEX.test(candidate.manifestSha256) ||
    typeof candidate.revisionDirectory !== "string" ||
    candidate.revisionDirectory !==
      `revisions/${candidate.manifestSha256}` ||
    !isSafeRelativePath(candidate.revisionDirectory)
  ) {
    throw artifactUnavailable();
  }
  return {
    schemaVersion: 1,
    manifestSha256: candidate.manifestSha256,
    revisionDirectory: candidate.revisionDirectory,
  };
}

function serializeActivePointer(pointer: ActiveAssetPointer): string {
  return `${canonicalJson(pointer)}\n`;
}

function assertInstallTarget(directory: string): string {
  if (!isAbsolute(directory) || directory.trim() === "") {
    throw artifactUnavailable();
  }
  return resolve(directory);
}

function isPathInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
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
