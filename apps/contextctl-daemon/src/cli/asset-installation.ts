/**
 * Installing the pinned local embedding assets, as a command rather than a
 * repository script.
 *
 * The manifest is not restated here. `DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST`
 * remains the single record of which files, how many bytes and which digests,
 * and `installLocalEmbeddingAssets` remains the only thing that verifies and
 * places them. What lives here is everything that was previously trapped inside
 * `scripts/install-embedding-assets.mjs` and therefore reachable only by someone
 * who had cloned the repository: where the bytes are fetched from, and the two
 * pieces of interaction a 396 MiB download needs — telling the operator what is
 * about to be downloaded before it starts, and telling them it is still moving
 * while it runs.
 *
 * Nothing in this module writes to a stream or reads a TTY. Progress goes to an
 * injected callback and consent comes from an injected predicate, because the
 * decisions behind those two — stderr versus stdout, `--yes` versus a prompt,
 * a pipe versus a terminal — belong to the command layer, and because a module
 * that owns them cannot be tested without owning a process.
 */
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

import {
  DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
  DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST,
  DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST_SHA256,
  DirectoryLocalEmbeddingAssetSource,
  installLocalEmbeddingAssets,
  type LocalEmbeddingAssetManifest,
  type LocalEmbeddingAssetSource,
} from "@contextctl/ingestion-indexing";

import { resolveActiveAssetDirectory } from "./asset-directory.js";
import { resolveContextctlPaths } from "./paths.js";

const HUGGING_FACE_ORIGIN = "https://huggingface.co";
/** The origin as an operator reads it, not as a URL. */
const HUGGING_FACE_ORIGIN_LABEL = "huggingface.co";
/** A 396 MiB body over a home connection: generous, but not unbounded. */
const REQUEST_TIMEOUT_MS = 30 * 60 * 1000;
const DOWNLOAD_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2_000;
/**
 * Files below this get a start line and a done line and nothing between them.
 * Four of the five manifest entries finish faster than a progress line would
 * take to read; the fifth is 372 MiB and is the reason this module reports at
 * all.
 */
const PROGRESS_REPORTING_THRESHOLD_BYTES = 8 * 1024 * 1024;
/** Byte progress every tenth of a large file: ten lines, not two hundred. */
const PROGRESS_REPORTING_FRACTION = 10;

/** What an operator is told before anything is downloaded. */
export interface AssetInstallationPlan {
  readonly repository: string;
  readonly revision: string;
  readonly license: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly targetDirectory: string;
  /** `huggingface.co`, or the absolute path of a staged source directory. */
  readonly origin: string;
}

export interface AssetInstallationOutcome {
  readonly status: "already_installed" | "installed" | "declined";
  readonly directory?: string;
  readonly installedBytes?: number;
  readonly elapsedMs?: number;
}

/**
 * States the facts of an install without performing any part of it.
 *
 * Every number comes from the manifest, so the consent text and the bytes that
 * are actually fetched cannot disagree.
 */
export function planAssetInstallation(input: {
  readonly targetDirectory: string;
  readonly sourceDirectory?: string;
}): AssetInstallationPlan {
  const manifest = DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST;
  return {
    repository: manifest.repository,
    revision: manifest.revision,
    license: manifest.license,
    fileCount: manifest.files.length,
    totalBytes: totalBytes(manifest),
    targetDirectory: input.targetDirectory,
    origin:
      input.sourceDirectory === undefined
        ? HUGGING_FACE_ORIGIN_LABEL
        : resolve(input.sourceDirectory),
  };
}

/**
 * The consent text.
 *
 * It names the size, the origin and the licence because those are the three
 * things an operator cannot discover after the fact: a download already spent
 * is spent, a mirror is invisible once the files are on disk, and a licence
 * accepted silently was never accepted.
 */
export function describeAssetInstallationPlan(
  plan: AssetInstallationPlan,
): string {
  return [
    `${plan.fileCount}개 파일 ${formatBytes(plan.totalBytes)}(약 ${formatDecimalMegabytes(plan.totalBytes)})를 내려받습니다.`,
    `  저장소   ${plan.repository}`,
    `  리비전   ${plan.revision}`,
    `  라이선스 ${plan.license}`,
    `  출처     ${plan.origin}`,
    `  설치 위치 ${plan.targetDirectory}`,
    "모든 파일은 고정된 매니페스트의 sha256과 바이트 수로 검증된 뒤에 배치됩니다.",
  ].join("\n");
}

/**
 * Resolves where the assets go: an explicit override, else the same directory
 * the rest of the CLI already reads.
 *
 * The default is not restated here — `resolveContextctlPaths` owns it — so the
 * installer and the daemon cannot end up pointed at different directories.
 */
export function resolveAssetInstallationTarget(input: {
  readonly environment: Readonly<Partial<Record<string, string>>>;
  readonly override?: string;
  readonly workingDirectory?: string;
}): string {
  const workingDirectory = input.workingDirectory ?? process.cwd();
  const override = input.override?.trim();
  if (override === undefined || override === "") {
    return resolveContextctlPaths(input.environment, workingDirectory)
      .embeddingAssetDirectory;
  }
  // `~/` is expanded here and nowhere else: this value is typed at a shell
  // prompt as a command argument, where an unexpanded tilde is a quoting
  // accident rather than a request for a directory literally named `~`.
  const expanded = override.startsWith("~/")
    ? resolve(homedir(), override.slice(2))
    : override;
  return isAbsolute(expanded)
    ? resolve(expanded)
    : resolve(workingDirectory, expanded);
}

/**
 * Installs the assets, asking first.
 *
 * The order is deliberate. The cheap "is it already there" check runs *before*
 * consent, so an operator who has already installed is not asked to approve a
 * download that will not happen. `installLocalEmbeddingAssets` would report
 * `already_installed` on its own, but only after re-hashing 396 MiB — an answer
 * that arrives several seconds after the question it should have prevented.
 */
export async function runAssetInstallation(input: {
  readonly targetDirectory: string;
  readonly sourceDirectory?: string;
  /** Where progress goes. The caller decides it is stderr. */
  readonly progress: (message: string) => void;
  /**
   * Asks for consent. The caller decides what `--yes` and a non-TTY mean.
   * Absent means consent was already given.
   */
  readonly confirm?: () => Promise<boolean>;
  /** Injected for tests. The global `fetch` otherwise. */
  readonly fetch?: typeof globalThis.fetch;
  /** Injected for tests. Real sleeping otherwise. */
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly signal?: AbortSignal;
  /** Injected for tests. The wall clock otherwise. */
  readonly now?: () => number;
}): Promise<AssetInstallationOutcome> {
  const manifest = DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST;
  const now = input.now ?? Date.now;
  const startedAt = now();

  const installed = await findInstalledRevisionDirectory(input.targetDirectory);
  if (installed !== undefined) {
    input.progress(`이미 설치되어 있습니다: ${installed}`);
    return {
      status: "already_installed",
      directory: installed,
      installedBytes: totalBytes(manifest),
      elapsedMs: now() - startedAt,
    };
  }

  if (input.confirm !== undefined && !(await input.confirm())) {
    return { status: "declined" };
  }

  const source = reportingSource(
    manifest,
    input.progress,
    input.sourceDirectory === undefined
      ? new HuggingFaceLocalEmbeddingAssetSource({
          manifest,
          progress: input.progress,
          ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
          ...(input.delay === undefined ? {} : { delay: input.delay }),
        })
      : new DirectoryLocalEmbeddingAssetSource(resolve(input.sourceDirectory)),
  );

  const result = await installLocalEmbeddingAssets({
    profile: DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
    manifest,
    targetDirectory: input.targetDirectory,
    source,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });

  return {
    status: result.status,
    directory: result.directory,
    installedBytes: result.installedBytes,
    elapsedMs: now() - startedAt,
  };
}

/**
 * Fetches a manifest's files from the repository revision it pins.
 *
 * The response is written into a buffer sized from the manifest, so a body that
 * runs long or short is rejected here rather than after 372 MiB have been
 * accumulated twice over.
 */
export class HuggingFaceLocalEmbeddingAssetSource
  implements LocalEmbeddingAssetSource
{
  readonly #manifest: LocalEmbeddingAssetManifest;
  readonly #progress: (message: string) => void;
  readonly #fetch: typeof globalThis.fetch;
  readonly #delay: (milliseconds: number) => Promise<void>;

  constructor(options: {
    readonly manifest: LocalEmbeddingAssetManifest;
    readonly progress: (message: string) => void;
    readonly fetch?: typeof globalThis.fetch;
    readonly delay?: (milliseconds: number) => Promise<void>;
  }) {
    this.#manifest = options.manifest;
    this.#progress = options.progress;
    // Both are injected rather than reached for globally so a test can exercise
    // the retry ladder without a network and without waiting out its delays.
    // The retry schedule is production behaviour and must stay under test; a
    // test that took six seconds to prove it would eventually be deleted.
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#delay = options.delay ?? sleep;
  }

  async read(path: string, signal?: AbortSignal): Promise<Uint8Array> {
    const file = this.#manifest.files.find((entry) => entry.path === path);
    if (file === undefined) {
      throw new Error(`asset is not in the manifest: ${path}`);
    }
    const url = `${HUGGING_FACE_ORIGIN}/${this.#manifest.repository}/resolve/${this.#manifest.revision}/${path}`;

    let lastError: unknown;
    for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
      signal?.throwIfAborted();
      try {
        return await this.#readOnce(url, file, attempt, signal);
      } catch (error) {
        // An abort is the operator's decision, not a transport failure: retrying
        // it would ignore the thing that was just asked for.
        if (signal?.aborted === true) throw error;
        lastError = error;
        this.#progress(
          `  시도 ${attempt}/${DOWNLOAD_ATTEMPTS} 실패: ${describe(error)}`,
        );
        if (attempt < DOWNLOAD_ATTEMPTS) {
          await this.#delay(RETRY_DELAY_MS * attempt);
        }
      }
    }
    throw lastError;
  }

  async #readOnce(
    url: string,
    file: { readonly path: string; readonly bytes: number },
    attempt: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const composed =
      signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

    const response = await this.#fetch(url, {
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
    const step = Math.floor(file.bytes / PROGRESS_REPORTING_FRACTION);
    const reportProgress =
      file.bytes >= PROGRESS_REPORTING_THRESHOLD_BYTES && step > 0;
    for await (const chunk of response.body) {
      if (written + chunk.byteLength > file.bytes) {
        throw new Error(
          `body is longer than the manifest's ${file.bytes} bytes`,
        );
      }
      bytes.set(chunk, written);
      written += chunk.byteLength;
      if (reportProgress && written - reported >= step) {
        reported = written;
        this.#progress(
          `    ${formatBytes(written)} / ${formatBytes(file.bytes)} (${Math.floor((written / file.bytes) * 100)}%)`,
        );
      }
    }
    if (written !== file.bytes) {
      throw new Error(
        `body was ${written} bytes, the manifest says ${file.bytes}`,
      );
    }
    if (attempt > 1) {
      this.#progress(`  ${file.path} 재시도 성공 (${attempt}번째 시도)`);
    }
    return bytes;
  }
}

/**
 * Announces each file as the installer asks for it.
 *
 * This wraps whichever source is in use rather than living inside one, so a
 * staged-directory install reports the same shape of progress as a download —
 * an operator watching the command should not have to know which one they got.
 */
function reportingSource(
  manifest: LocalEmbeddingAssetManifest,
  progress: (message: string) => void,
  inner: LocalEmbeddingAssetSource,
): LocalEmbeddingAssetSource {
  return {
    async read(path: string, signal?: AbortSignal): Promise<Uint8Array> {
      const index = manifest.files.findIndex((entry) => entry.path === path);
      const position = index < 0 ? "?" : `${index + 1}/${manifest.files.length}`;
      const file = index < 0 ? undefined : manifest.files[index];
      progress(
        `[${position}] ${path}${file === undefined ? "" : ` (${formatBytes(file.bytes)})`} 가져오는 중`,
      );
      const bytes = await inner.read(path, signal);
      progress(`[${position}] ${path} 완료`);
      return bytes;
    },
  };
}

/**
 * The installed revision, or `undefined` when nothing usable is installed.
 *
 * Delegated rather than implemented. `resolveActiveLocalEmbeddingAssets` is the
 * authoritative check and re-reads every byte to answer, which is the right
 * trade at daemon boot and the wrong one here: this runs before a yes/no
 * question, and a question that takes ten seconds to appear reads as a hang.
 * The cheap pointer read lives in `asset-directory.ts`, which is also what the
 * composition and the diagnosis use — three readers of one file, disagreeing
 * about which directory it names, is the defect that module was extracted to
 * end.
 */
async function findInstalledRevisionDirectory(
  targetDirectory: string,
): Promise<string | undefined> {
  const resolution = await resolveActiveAssetDirectory(
    targetDirectory,
    DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST_SHA256,
  );
  return resolution.status === "resolved" ? resolution.directory : undefined;
}


function totalBytes(manifest: LocalEmbeddingAssetManifest): number {
  return manifest.files.reduce((sum, file) => sum + file.bytes, 0);
}

/** Binary units, because that is what a disk and a download report. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit] ?? "GiB"}`;
}

function formatDecimalMegabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

/** A cause carries the transport's reason; a bare message usually does not. */
function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.cause instanceof Error
      ? `${error.message} (${error.cause.message})`
      : error.message;
  }
  return String(error);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((settle) => setTimeout(settle, milliseconds));
}
