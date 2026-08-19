import { constants as fileConstants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { access, open, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { extname, resolve } from "node:path";

import { canonicalizeDocumentText, sha256Digest } from "../domain/document-capture.js";
import type { MarkdownSourceSnapshot } from "../ports/document-capture.js";
import {
  SourceAdapterFault,
  type ProbedObservationCapability,
  type SourceAdapter,
  type SourceAdapterContext,
  type SourceObservationAttempt,
  type ValidatedSourceConfiguration,
} from "../ports/source-adapter.js";

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_STABLE_READ_ATTEMPTS = 3;
const SUPPORTED_EXTENSIONS = new Set([".md", ".markdown"]);
const CONFIGURATION_KEYS = new Set(["basePath", "maxBytes", "path"]);

export interface MarkdownFileSourceAdapterOptions {
  readonly now?: () => Date;
  readonly defaultMaxBytes?: number;
  readonly stableReadAttempts?: number;
}

interface MarkdownFileConfiguration {
  readonly path: string;
  readonly maxBytes: number;
}

export class MarkdownFileSourceAdapter implements SourceAdapter {
  readonly sourceType = "markdown";
  readonly #now: () => Date;
  readonly #defaultMaxBytes: number;
  readonly #stableReadAttempts: number;

  constructor(options: MarkdownFileSourceAdapterOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#defaultMaxBytes = options.defaultMaxBytes ?? DEFAULT_MAX_BYTES;
    this.#stableReadAttempts =
      options.stableReadAttempts ?? DEFAULT_STABLE_READ_ATTEMPTS;
    if (
      !Number.isSafeInteger(this.#defaultMaxBytes) ||
      this.#defaultMaxBytes <= 0
    ) {
      throw new RangeError("defaultMaxBytes must be a positive integer");
    }
    if (
      !Number.isSafeInteger(this.#stableReadAttempts) ||
      this.#stableReadAttempts <= 0
    ) {
      throw new RangeError("stableReadAttempts must be a positive integer");
    }
  }

  validateConfiguration(input: unknown): ValidatedSourceConfiguration {
    if (!isRecord(input) || Object.keys(input).some((key) => !CONFIGURATION_KEYS.has(key))) {
      throw new SourceAdapterFault("invalid_configuration");
    }
    const path = input.path;
    const basePath = input.basePath;
    const maxBytes =
      input.maxBytes === undefined ? this.#defaultMaxBytes : input.maxBytes;
    if (
      typeof path !== "string" ||
      path.trim().length === 0 ||
      (basePath !== undefined &&
        (typeof basePath !== "string" || basePath.trim().length === 0)) ||
      typeof maxBytes !== "number" ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes <= 0
    ) {
      throw new SourceAdapterFault("invalid_configuration");
    }

    const canonicalPath = resolve(
      typeof basePath === "string" ? basePath : process.cwd(),
      path,
    ).normalize("NFC");
    if (!SUPPORTED_EXTENSIONS.has(extname(canonicalPath).toLowerCase())) {
      throw new SourceAdapterFault("invalid_format");
    }
    return {
      targetKey: `file:${sha256Digest(canonicalPath)}`,
      value: { path: canonicalPath, maxBytes } satisfies MarkdownFileConfiguration,
    };
  }

  async validateConnection(context: SourceAdapterContext): Promise<void> {
    await inspectReadableFile(configurationOf(context), context.signal);
  }

  async probeCapabilities(
    context: SourceAdapterContext,
  ): Promise<readonly ProbedObservationCapability[]> {
    await inspectReadableFile(configurationOf(context), context.signal);
    return [{ name: "document_capture", status: "available" }];
  }

  async observe(
    context: SourceAdapterContext,
    previousToken?: string,
  ): Promise<SourceObservationAttempt> {
    const snapshot = await this.#readSnapshot(context);
    if (snapshot.contentDigest === previousToken) {
      return { status: "unchanged" };
    }
    return {
      status: "changed",
      payload: snapshot,
      capturedAt: snapshot.capturedAt,
      contentDigest: snapshot.contentDigest,
      changeSignal: { status: "changed", token: snapshot.contentDigest },
    };
  }

  async #readSnapshot(
    context: SourceAdapterContext,
  ): Promise<MarkdownSourceSnapshot> {
    const configuration = configurationOf(context);
    for (let attempt = 0; attempt < this.#stableReadAttempts; attempt += 1) {
      assertNotAborted(context.signal);
      let handle;
      try {
        handle = await open(configuration.path, "r");
        const before = await handle.stat({ bigint: true });
        assertReadableSnapshotMetadata(before, configuration.maxBytes);
        const bytes = await this.readSnapshotBytes(handle, context.signal);
        const after = await handle.stat({ bigint: true });
        assertReadableSnapshotMetadata(after, configuration.maxBytes);
        if (!sameSnapshotMetadata(before, after)) {
          continue;
        }
        let decoded: string;
        try {
          decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          throw new SourceAdapterFault("invalid_format");
        }
        const content = canonicalizeDocumentText(decoded);
        return {
          kind: "markdown",
          targetKey: context.source.targetKey,
          capturedAt: this.#now().toISOString(),
          content,
          contentDigest: sha256Digest(content),
        };
      } catch (error) {
        throw mapFileError(error);
      } finally {
        await handle?.close();
      }
    }
    throw new SourceAdapterFault("source_unstable");
  }

  /** Single full-read seam used to verify stable-capture behavior. */
  protected async readSnapshotBytes(
    handle: FileHandle,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    return handle.readFile({ signal });
  }
}

function assertReadableSnapshotMetadata(
  metadata: BigIntStats,
  maxBytes: number,
): void {
  if (!metadata.isFile() || metadata.size > BigInt(maxBytes)) {
    throw new SourceAdapterFault("invalid_format");
  }
}

function sameSnapshotMetadata(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

export function isMarkdownSourceSnapshot(
  value: unknown,
): value is MarkdownSourceSnapshot {
  return (
    isRecord(value) &&
    value.kind === "markdown" &&
    typeof value.targetKey === "string" &&
    typeof value.capturedAt === "string" &&
    typeof value.content === "string" &&
    typeof value.contentDigest === "string"
  );
}

async function inspectReadableFile(
  configuration: MarkdownFileConfiguration,
  signal: AbortSignal,
): Promise<void> {
  assertNotAborted(signal);
  try {
    const metadata = await stat(configuration.path);
    if (!metadata.isFile()) {
      throw new SourceAdapterFault("invalid_format");
    }
    if (metadata.size > configuration.maxBytes) {
      throw new SourceAdapterFault("invalid_format");
    }
    await access(configuration.path, fileConstants.R_OK);
    assertNotAborted(signal);
  } catch (error) {
    throw mapFileError(error);
  }
}

function configurationOf(context: SourceAdapterContext): MarkdownFileConfiguration {
  if (
    !isRecord(context.configuration) ||
    typeof context.configuration.path !== "string" ||
    context.configuration.path.trim() === "" ||
    !Number.isSafeInteger(context.configuration.maxBytes) ||
    (context.configuration.maxBytes as number) <= 0
  ) {
    throw new SourceAdapterFault("invalid_configuration");
  }
  return {
    path: context.configuration.path,
    maxBytes: context.configuration.maxBytes as number,
  };
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException("Operation aborted", "AbortError");
  }
}

function mapFileError(error: unknown): SourceAdapterFault | unknown {
  if (error instanceof SourceAdapterFault) {
    return error;
  }
  if (isRecord(error)) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      return new SourceAdapterFault("target_not_found");
    }
    if (error.code === "EACCES" || error.code === "EPERM") {
      return new SourceAdapterFault("permission_denied");
    }
  }
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
