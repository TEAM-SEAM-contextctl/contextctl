import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/**
 * The operator's declared Sources, kept on disk between CLI invocations.
 *
 * `createDaemonRuntime` takes `sourceConfigurations` as a constructor argument,
 * which is the right shape for an embedded runtime: the program holding the
 * runtime already knows what it registered. A CLI has no such program. Each
 * command is its own process, so `contextctl source add` would register a path
 * into an object that dies with the process and `contextctl ingest`, a second
 * later, would open a runtime that has never heard of it. Neither command
 * fails — the second one simply has nothing to ingest, which is the worst kind
 * of failure to debug.
 *
 * So the registration is written down. This module owns that file and nothing
 * else: it does not build a runtime, does not touch the environment, and does
 * not decide where the file lives (`resolveContextctlPaths` does). It is
 * deliberately the only configuration file the CLI has — every other setting is
 * deployment wiring read from the environment, because those are things an
 * operator sets once in a shell, while *this* is a thing an operator edits, and
 * a file they edit deserves to be readable and diffable.
 */

export const SOURCES_FILE_VERSION = 1;

/** One registered Source, as it is stored. */
export interface RegisteredSource {
  /**
   * Always absolute.
   *
   * Relative paths are resolved at registration time rather than at use time,
   * because the two happen in different working directories. An operator who
   * types `contextctl source add ./docs/payments.md` from a project directory
   * means that file; resolving the stored `./docs/payments.md` later, from
   * wherever `contextctl ingest` happens to be run, would silently mean a
   * different file or no file at all.
   */
  readonly path: string;
  /**
   * What a human calls this Source.
   *
   * Separate from the reference because the reference is an identifier — it is
   * matched, sorted and typed — while this is only ever read. Ingestion carries
   * it through to the published Source, so it is what shows up beside a Card.
   */
  readonly displayName: string;
}

export interface SourcesDocument {
  readonly version: typeof SOURCES_FILE_VERSION;
  readonly sources: Readonly<Record<string, RegisteredSource>>;
}

export type SourcesFileErrorCode =
  /** The file exists but could not be read. Absence is not an error. */
  | "unreadable"
  /** Not JSON, or JSON that is not a `{version, sources}` object. */
  | "malformed"
  /** Well formed, but written by a version of the CLI this one cannot read. */
  | "unsupported_version"
  /** A reference or a field inside one entry violates its rule. */
  | "invalid_entry"
  | "duplicate_reference"
  | "unknown_reference";

/**
 * A failure that already knows which `SourcesFileErrorCode` it is.
 *
 * The code is carried on the exception rather than recovered by matching on the
 * message, because the caller that has to act on this is a command line: it
 * maps a code to an exit status and to a sentence telling the operator what to
 * do about it, and a message-matching ladder would break the moment a sentence
 * is reworded.
 */
export class SourcesFileError extends Error {
  readonly code: SourcesFileErrorCode;

  constructor(
    code: SourcesFileErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SourcesFileError";
    this.code = code;
  }
}

/**
 * What a reference may look like.
 *
 * Restrictive on purpose. A reference is used as a JSON object key, as a
 * command line argument and as Ingestion's `configReference`, so anything that
 * needs quoting in one of those places is a paper cut waiting to happen.
 * Lowercase-only removes the class of bug where `Source.Payments` and
 * `source.payments` are two entries on a case-sensitive filesystem and one on a
 * case-insensitive one.
 */
const REFERENCE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** The prefix `defaultReferenceFor` puts on a derived reference. */
const DERIVED_REFERENCE_PREFIX = "source.";

const EMPTY_DOCUMENT: SourcesDocument = {
  version: SOURCES_FILE_VERSION,
  sources: {},
};

/**
 * Reads the file, treating absence as emptiness.
 *
 * A missing file is the state of every fresh install, and the alternative —
 * writing an empty file at startup — would mean the CLI creates its home
 * directory as a side effect of commands that only read. Corruption is *not*
 * treated as emptiness: silently starting over would delete registrations an
 * operator can see with their own eyes in the file, so it raises instead.
 */
export async function readSourcesFile(
  filePath: string,
): Promise<SourcesDocument> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (cause) {
    if (errorCodeOf(cause) === "ENOENT") {
      return EMPTY_DOCUMENT;
    }
    throw new SourcesFileError(
      "unreadable",
      `소스 파일을 읽지 못했습니다: ${filePath}`,
      { cause },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new SourcesFileError(
      "malformed",
      `소스 파일이 올바른 JSON이 아닙니다: ${filePath}`,
      { cause },
    );
  }

  return parseSourcesDocument(parsed, filePath);
}

/**
 * Writes the file atomically, creating its directory.
 *
 * Write-then-rename rather than write-in-place because the file is the only
 * record of what an operator registered: a process killed halfway through a
 * plain write leaves a truncated file, which `readSourcesFile` will correctly
 * refuse to parse, and every registration is gone. `rename` within one
 * directory is atomic on POSIX, so a reader sees either the old file or the new
 * one. The temporary lives beside the target for the same reason — renaming
 * across filesystems is not atomic and, from a temp directory, often not even
 * possible.
 */
export async function writeSourcesFile(
  filePath: string,
  document: SourcesDocument,
): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });

  const temporaryPath = join(directory, `.${basename(filePath)}.${randomUUID()}`);
  await writeFile(temporaryPath, serialize(document), "utf8");
  await rename(temporaryPath, filePath);
}

/**
 * Returns a new document with one more Source in it.
 *
 * Pure, and returns rather than mutates, so that a command can validate the
 * whole intended result before anything reaches disk — a rejected registration
 * must leave the file exactly as it was.
 *
 * The path's existence is deliberately not checked. Registering is a statement
 * of intent, and a path may legitimately not exist yet; more importantly, a
 * check here would be a check at the wrong time, since the file can vanish
 * between registration and ingestion anyway. Ingestion is where a missing file
 * is a real failure, so ingestion is where it is reported.
 */
export function addSource(
  document: SourcesDocument,
  input: {
    readonly reference: string;
    readonly path: string;
    readonly displayName?: string;
    readonly workingDirectory?: string;
  },
): SourcesDocument {
  assertReference(input.reference);

  if (input.path.trim() === "") {
    throw new SourcesFileError(
      "invalid_entry",
      "소스 경로는 비어 있을 수 없습니다.",
    );
  }
  if (document.sources[input.reference] !== undefined) {
    throw new SourcesFileError(
      "duplicate_reference",
      `이미 등록된 소스 참조입니다: ${input.reference}`,
    );
  }
  if (input.displayName !== undefined && input.displayName.trim() === "") {
    throw new SourcesFileError(
      "invalid_entry",
      "표시 이름은 비어 있을 수 없습니다.",
    );
  }

  const workingDirectory = input.workingDirectory ?? process.cwd();
  const absolutePath = resolve(workingDirectory, input.path);

  return {
    version: SOURCES_FILE_VERSION,
    sources: {
      ...document.sources,
      [input.reference]: {
        path: absolutePath,
        displayName: input.displayName ?? basename(absolutePath),
      },
    },
  };
}

/**
 * Returns a new document with one Source gone.
 *
 * Removing something absent raises rather than succeeding quietly: an operator
 * who mistypes a reference has almost certainly failed to remove the thing they
 * meant to remove, and a silent success would tell them the opposite.
 */
export function removeSource(
  document: SourcesDocument,
  reference: string,
): SourcesDocument {
  if (document.sources[reference] === undefined) {
    throw new SourcesFileError(
      "unknown_reference",
      `등록되지 않은 소스 참조입니다: ${reference}`,
    );
  }

  const remaining: Record<string, RegisteredSource> = {};
  for (const [candidate, entry] of Object.entries(document.sources)) {
    if (candidate !== reference) {
      remaining[candidate] = entry;
    }
  }

  return { version: SOURCES_FILE_VERSION, sources: remaining };
}

/**
 * Projects the document onto `createDaemonRuntime`'s `sourceConfigurations`.
 *
 * `displayName` is dropped rather than passed through, because the runtime does
 * not take it there: Ingestion receives the display name on the `publish` call
 * that registers the Source, not from this map. Keeping the two shapes distinct
 * — one for humans reading the file, one for the runtime — is why this function
 * exists instead of the file storing the runtime's shape directly.
 */
export function toSourceConfigurations(
  document: SourcesDocument,
): Readonly<Record<string, { readonly path: string }>> {
  const configurations: Record<string, { readonly path: string }> = {};
  for (const [reference, entry] of Object.entries(document.sources)) {
    configurations[reference] = { path: entry.path };
  }
  return configurations;
}

/**
 * Derives a reference from a path, for when the operator did not name one.
 *
 * Requiring `--name` on every registration would be correct and unpleasant; a
 * derived name is right often enough that typing one should be the exception.
 * The `source.` prefix is not decoration — references travel to Ingestion as
 * `configReference` and appear in Card provenance, where a bare `payment` says
 * nothing about what kind of thing it identifies.
 *
 * A path whose file name is nothing but an extension derives nothing, and
 * raises rather than inventing a name, because an invented one would be a name
 * the operator has to discover from the file afterwards.
 */
export function defaultReferenceFor(path: string): string {
  const fileName = basename(path.trim());
  // Everything before the last dot: `basename(p, extname(p))` keeps the whole
  // of `.md`, since `extname` reports no extension for a leading-dot name, and
  // `source..md` is not a name anyone asked for.
  const lastDot = fileName.lastIndexOf(".");
  const stem = lastDot >= 0 ? fileName.slice(0, lastDot) : fileName;
  const slug = stem
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");

  if (slug === "") {
    throw new SourcesFileError(
      "invalid_entry",
      `경로에서 소스 참조를 만들 수 없습니다. --name 으로 직접 지정하세요: ${path}`,
    );
  }

  const reference = `${DERIVED_REFERENCE_PREFIX}${slug}`;
  assertReference(reference);
  return reference;
}

function assertReference(reference: string): void {
  if (!REFERENCE_PATTERN.test(reference)) {
    throw new SourcesFileError(
      "invalid_entry",
      `소스 참조는 소문자·숫자로 시작하고 소문자·숫자·'.'·'_'·'-' 만 쓸 수 있습니다: ${reference}`,
    );
  }
}

/**
 * Serializes deterministically: sorted keys, two spaces, trailing newline.
 *
 * The file is meant to be read and version controlled, and a serializer that
 * emits insertion order would produce a diff on every registration touching
 * every line. Sorting makes two documents with the same content byte-identical
 * regardless of the order the entries were added in.
 */
function serialize(document: SourcesDocument): string {
  const sorted: Record<string, RegisteredSource> = {};
  for (const reference of Object.keys(document.sources).sort()) {
    const entry = document.sources[reference];
    if (entry !== undefined) {
      sorted[reference] = { path: entry.path, displayName: entry.displayName };
    }
  }
  return `${JSON.stringify({ version: SOURCES_FILE_VERSION, sources: sorted }, undefined, 2)}\n`;
}

function parseSourcesDocument(value: unknown, filePath: string): SourcesDocument {
  if (!isPlainObject(value)) {
    throw new SourcesFileError(
      "malformed",
      `소스 파일의 최상위는 객체여야 합니다: ${filePath}`,
    );
  }
  // Version is checked before shape, so an operator running an older CLI
  // against a newer file is told to upgrade rather than shown a confusing
  // complaint about fields that are perfectly valid in the newer format.
  if (value["version"] !== SOURCES_FILE_VERSION) {
    throw new SourcesFileError(
      "unsupported_version",
      `지원하지 않는 소스 파일 버전입니다(기대: ${SOURCES_FILE_VERSION}, 실제: ${String(value["version"])}): ${filePath}`,
    );
  }

  const sources = value["sources"];
  if (!isPlainObject(sources)) {
    throw new SourcesFileError(
      "malformed",
      `소스 파일의 sources 는 객체여야 합니다: ${filePath}`,
    );
  }

  const parsed: Record<string, RegisteredSource> = {};
  for (const [reference, entry] of Object.entries(sources)) {
    assertReference(reference);
    if (!isPlainObject(entry)) {
      throw new SourcesFileError(
        "invalid_entry",
        `소스 항목은 객체여야 합니다: ${reference}`,
      );
    }

    const path = entry["path"];
    const displayName = entry["displayName"];
    if (typeof path !== "string" || typeof displayName !== "string") {
      throw new SourcesFileError(
        "invalid_entry",
        `소스 항목의 path 와 displayName 은 문자열이어야 합니다: ${reference}`,
      );
    }
    // Absoluteness is re-checked on read, not only on write, because the file
    // is hand-editable: an operator pasting a relative path in by hand would
    // otherwise get a Source that resolves against whatever directory the next
    // command happened to run from.
    if (!isAbsolute(path)) {
      throw new SourcesFileError(
        "invalid_entry",
        `소스 항목의 path 는 절대경로여야 합니다: ${reference} (${path})`,
      );
    }

    parsed[reference] = { path, displayName };
  }

  return { version: SOURCES_FILE_VERSION, sources: parsed };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCodeOf(cause: unknown): string | undefined {
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    const code = (cause as { readonly code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}
