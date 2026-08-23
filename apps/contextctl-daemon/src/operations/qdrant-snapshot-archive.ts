import { createWriteStream, openAsBlob } from "node:fs";
import { chmod, rename, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { PublishedQdrantBackupTarget } from "@contextctl/ingestion-indexing";

import type {
  StateBackupQdrantArtifact,
  VectorSnapshotArchive,
  VectorSnapshotRestoreLease,
} from "./state-backup.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_METADATA_RESPONSE_BYTES = 64 * 1024;
const COLLECTION_PATTERN = /^contextctl_[a-f0-9]{32}$/;

export type QdrantSnapshotArchiveErrorCode =
  | "collection_already_exists"
  | "qdrant_snapshot_cleanup_failed"
  | "qdrant_snapshot_create_failed"
  | "qdrant_snapshot_download_failed"
  | "qdrant_snapshot_restore_failed"
  | "qdrant_snapshot_response_invalid";

export class QdrantSnapshotArchiveError extends Error {
  constructor(
    readonly code: QdrantSnapshotArchiveErrorCode,
    options?: ErrorOptions,
  ) {
    super(`Qdrant snapshot archive failed: ${code}`, options);
    this.name = "QdrantSnapshotArchiveError";
  }
}

export interface QdrantSnapshotArchiveOptions {
  readonly url: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

/**
 * Downloads collection snapshots into the backup and restores them only into
 * collection names that do not exist yet.
 *
 * The API key stays in request headers and is never returned in an artifact or
 * error. Every server-side snapshot made during backup is deleted after its
 * bytes have been verified locally.
 */
export class QdrantSnapshotArchive implements VectorSnapshotArchive {
  readonly #endpoint: URL;
  readonly #apiKey: string | undefined;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: QdrantSnapshotArchiveOptions) {
    this.#endpoint = assertSafeEndpoint(options.url);
    if (
      options.timeoutMs !== undefined &&
      (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)
    ) {
      throw new TypeError("Qdrant snapshot timeout must be a positive integer");
    }
    this.#apiKey = options.apiKey;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async create(input: {
    readonly targets: readonly PublishedQdrantBackupTarget[];
    readonly directory: string;
  }): Promise<readonly StateBackupQdrantArtifact[]> {
    const artifacts: StateBackupQdrantArtifact[] = [];
    for (const target of input.targets) {
      assertCollectionName(target.collectionName);
      const snapshot = await this.#createSnapshot(target.collectionName);
      let operationFailure: unknown;
      try {
        const path = join(
          input.directory,
          `${target.collectionName}.snapshot`,
        );
        await this.#downloadSnapshot(
          target.collectionName,
          snapshot.name,
          path,
        );
        const details = await stat(path);
        artifacts.push({
          collectionName: target.collectionName,
          path: `qdrant/${target.collectionName}.snapshot`,
          sizeBytes: details.size,
          sha256: await sha256File(path),
          ...(snapshot.checksum === undefined
            ? {}
            : { qdrantChecksum: snapshot.checksum }),
        });
      } catch (error) {
        operationFailure = error;
      }

      try {
        await this.#deleteSnapshot(target.collectionName, snapshot.name);
      } catch (cleanupError) {
        if (operationFailure !== undefined) {
          throw new QdrantSnapshotArchiveError(
            "qdrant_snapshot_cleanup_failed",
            { cause: new AggregateError([operationFailure, cleanupError]) },
          );
        }
        throw cleanupError;
      }
      if (operationFailure !== undefined) throw operationFailure;
    }
    return artifacts;
  }

  async restore(input: {
    readonly artifacts: readonly StateBackupQdrantArtifact[];
    readonly directory: string;
  }): Promise<VectorSnapshotRestoreLease> {
    for (const artifact of input.artifacts) {
      assertCollectionName(artifact.collectionName);
      if (await this.#collectionExists(artifact.collectionName)) {
        throw new QdrantSnapshotArchiveError("collection_already_exists");
      }
    }

    const created: string[] = [];
    try {
      for (const artifact of input.artifacts) {
        const path = join(input.directory, basename(artifact.path));
        try {
          await this.#uploadSnapshot(artifact, path);
          created.push(artifact.collectionName);
        } catch (error) {
          // A timed-out upload may have completed on Qdrant. The preflight
          // proved the name was absent, and restore requires an exclusive
          // target, so a collection that appeared belongs to this attempt and
          // must join the rollback set. If even this probe fails, cleanup is
          // ambiguous and the combined failure is reported rather than hidden.
          try {
            if (await this.#collectionExists(artifact.collectionName)) {
              created.push(artifact.collectionName);
            }
          } catch (probeError) {
            throw new QdrantSnapshotArchiveError(
              "qdrant_snapshot_cleanup_failed",
              { cause: new AggregateError([error, probeError]) },
            );
          }
          throw error;
        }
        if (!(await this.#collectionExists(artifact.collectionName))) {
          throw new QdrantSnapshotArchiveError(
            "qdrant_snapshot_response_invalid",
          );
        }
      }
    } catch (error) {
      const rollbackErrors = await this.#deleteCollections(created);
      if (rollbackErrors.length > 0) {
        throw new QdrantSnapshotArchiveError(
          "qdrant_snapshot_cleanup_failed",
          { cause: new AggregateError([error, ...rollbackErrors]) },
        );
      }
      if (error instanceof QdrantSnapshotArchiveError) throw error;
      throw new QdrantSnapshotArchiveError("qdrant_snapshot_restore_failed", {
        cause: error,
      });
    }

    let active = true;
    return {
      rollback: async (): Promise<void> => {
        if (!active) return;
        const errors = await this.#deleteCollections(created);
        if (errors.length > 0) {
          throw new QdrantSnapshotArchiveError(
            "qdrant_snapshot_cleanup_failed",
            { cause: new AggregateError(errors) },
          );
        }
        active = false;
      },
    };
  }

  async #createSnapshot(
    collectionName: string,
  ): Promise<{ readonly name: string; readonly checksum?: string }> {
    let response: Response;
    try {
      response = await this.#request(
        "POST",
        `/collections/${encodeURIComponent(collectionName)}/snapshots?wait=true`,
      );
    } catch (error) {
      throw new QdrantSnapshotArchiveError("qdrant_snapshot_create_failed", {
        cause: error,
      });
    }
    const result = await readQdrantResult(response);
    if (
      !isRecord(result) ||
      typeof result.name !== "string" ||
      result.name.trim() === "" ||
      result.name.length > 512 ||
      (result.checksum !== undefined && typeof result.checksum !== "string")
    ) {
      throw new QdrantSnapshotArchiveError(
        "qdrant_snapshot_response_invalid",
      );
    }
    return {
      name: result.name,
      ...(result.checksum === undefined ? {} : { checksum: result.checksum }),
    };
  }

  async #downloadSnapshot(
    collectionName: string,
    snapshotName: string,
    destination: string,
  ): Promise<void> {
    const partial = `${destination}.partial`;
    await rm(partial, { force: true });
    try {
      const response = await this.#request(
        "GET",
        `/collections/${encodeURIComponent(collectionName)}/snapshots/${encodeURIComponent(snapshotName)}`,
      );
      if (response.body === null) {
        throw new QdrantSnapshotArchiveError(
          "qdrant_snapshot_response_invalid",
        );
      }
      await pipeline(
        Readable.fromWeb(response.body),
        createWriteStream(partial, { flags: "wx", mode: 0o600, flush: true }),
      );
      await chmod(partial, 0o600);
      await rename(partial, destination);
    } catch (error) {
      await rm(partial, { force: true });
      if (error instanceof QdrantSnapshotArchiveError) throw error;
      throw new QdrantSnapshotArchiveError(
        "qdrant_snapshot_download_failed",
        { cause: error },
      );
    }
  }

  async #deleteSnapshot(
    collectionName: string,
    snapshotName: string,
  ): Promise<void> {
    try {
      const response = await this.#request(
        "DELETE",
        `/collections/${encodeURIComponent(collectionName)}/snapshots/${encodeURIComponent(snapshotName)}?wait=true`,
      );
      const result = await readQdrantResult(response);
      if (result !== true) {
        throw new QdrantSnapshotArchiveError(
          "qdrant_snapshot_response_invalid",
        );
      }
    } catch (error) {
      if (error instanceof QdrantSnapshotArchiveError) throw error;
      throw new QdrantSnapshotArchiveError(
        "qdrant_snapshot_cleanup_failed",
        { cause: error },
      );
    }
  }

  async #uploadSnapshot(
    artifact: StateBackupQdrantArtifact,
    path: string,
  ): Promise<void> {
    try {
      const form = new FormData();
      form.append("snapshot", await openAsBlob(path), basename(path));
      const query = new URLSearchParams({
        wait: "true",
        priority: "snapshot",
        ...(artifact.qdrantChecksum === undefined
          ? {}
          : { checksum: artifact.qdrantChecksum }),
      });
      const response = await this.#request(
        "POST",
        `/collections/${encodeURIComponent(artifact.collectionName)}/snapshots/upload?${query.toString()}`,
        form,
      );
      if ((await readQdrantResult(response)) !== true) {
        throw new QdrantSnapshotArchiveError(
          "qdrant_snapshot_response_invalid",
        );
      }
    } catch (error) {
      if (error instanceof QdrantSnapshotArchiveError) throw error;
      throw new QdrantSnapshotArchiveError("qdrant_snapshot_restore_failed", {
        cause: error,
      });
    }
  }

  async #collectionExists(collectionName: string): Promise<boolean> {
    const response = await this.#request(
      "GET",
      `/collections/${encodeURIComponent(collectionName)}/exists`,
    );
    const result = await readQdrantResult(response);
    if (!isRecord(result) || typeof result.exists !== "boolean") {
      throw new QdrantSnapshotArchiveError(
        "qdrant_snapshot_response_invalid",
      );
    }
    return result.exists;
  }

  async #deleteCollections(
    collections: readonly string[],
  ): Promise<readonly unknown[]> {
    const errors: unknown[] = [];
    for (const collectionName of [...collections].reverse()) {
      try {
        const response = await this.#request(
          "DELETE",
          `/collections/${encodeURIComponent(collectionName)}`,
        );
        if ((await readQdrantResult(response)) !== true) {
          throw new QdrantSnapshotArchiveError(
            "qdrant_snapshot_response_invalid",
          );
        }
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  async #request(
    method: "DELETE" | "GET" | "POST",
    path: string,
    body?: RequestInit["body"],
  ): Promise<Response> {
    // `CONTEXTCTL_QDRANT_URL` may include a reverse-proxy prefix. Resolving an
    // absolute path would silently discard it (`/qdrant` -> `/collections`),
    // so snapshot calls deliberately resolve relative to the configured base.
    const url = new URL(path.replace(/^\//, ""), this.#endpoint);
    const signal = AbortSignal.timeout(this.#timeoutMs);
    const response = await this.#fetch(url, {
      method,
      ...(this.#apiKey === undefined
        ? {}
        : { headers: { "api-key": this.#apiKey } }),
      ...(body === undefined ? {} : { body }),
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Qdrant snapshot request failed with status ${String(response.status)}`);
    }
    return response;
  }
}

async function readQdrantResult(response: Response): Promise<unknown> {
  let body: unknown;
  try {
    body = JSON.parse(
      Buffer.concat(await readLimitedResponse(response)).toString("utf8"),
    ) as unknown;
  } catch (error) {
    throw new QdrantSnapshotArchiveError("qdrant_snapshot_response_invalid", {
      cause: error,
    });
  }
  if (!isRecord(body) || body.status !== "ok" || !("result" in body)) {
    throw new QdrantSnapshotArchiveError("qdrant_snapshot_response_invalid");
  }
  return body.result;
}

async function readLimitedResponse(response: Response): Promise<Buffer[]> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (/^[0-9]+$/.test(declared) === false ||
      Number(declared) > MAX_METADATA_RESPONSE_BYTES)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Qdrant metadata response is over the byte limit");
  }
  if (response.body === null) {
    throw new Error("Qdrant metadata response has no body");
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return chunks;
      bytes += next.value.byteLength;
      if (bytes > MAX_METADATA_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Qdrant metadata response is over the byte limit");
      }
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    reader.releaseLock();
  }
}

function assertSafeEndpoint(value: string): URL {
  const endpoint = new URL(value);
  const local =
    endpoint.hostname === "127.0.0.1" || endpoint.hostname === "localhost";
  if (
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    (endpoint.protocol !== "https:" &&
      !(local && endpoint.protocol === "http:"))
  ) {
    throw new TypeError(
      "Qdrant endpoint must use HTTPS or local loopback HTTP without userinfo",
    );
  }
  if (!endpoint.pathname.endsWith("/")) endpoint.pathname += "/";
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint;
}

function assertCollectionName(value: string): void {
  if (!COLLECTION_PATTERN.test(value)) {
    throw new QdrantSnapshotArchiveError(
      "qdrant_snapshot_response_invalid",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function sha256File(path: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  const { createReadStream } = await import("node:fs");
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("end", resolve);
    stream.once("error", reject);
  });
  return hash.digest("hex");
}
