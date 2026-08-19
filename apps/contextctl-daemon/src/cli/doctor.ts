import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
  DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST,
  DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST_SHA256,
  LOCAL_EMBEDDING_ACTIVE_POINTER_FILE,
  openIngestionDatabase,
  verifyLocalEmbeddingAssets,
} from "@contextctl/ingestion-indexing";
import { openRegistryDatabase } from "@contextctl/registry-lifecycle";

import { DEFAULT_SECURITY_DOMAIN, DEFAULT_STATE_NAMESPACE_ID } from "../main.js";
import { maskSecret, resolveCardMeaningBackend } from "./meaning-generator.js";
import { resolveContextctlPaths, readNonEmpty } from "./paths.js";
import { readSourcesFile, SourcesFileError } from "./sources-file.js";
import { resolveVectorBackend } from "./vector-backend.js";

/**
 * What `contextctl doctor` reports, and why it is not the composition root.
 *
 * `createDaemonRuntime` answers exactly one question — "can this process be
 * assembled?" — and answers it by throwing. That is the right shape for a
 * runtime and the wrong shape for a diagnosis: an operator who has just
 * installed the CLI needs to know which of eight prerequisites is missing and
 * what to type next, and a single exception can only name the first one. So
 * this module re-checks the same prerequisites independently, keeps going past
 * a failure, and returns every finding.
 *
 * It is *also* not merely a wrapper because assembly does not actually check
 * the one thing most likely to be wrong. `TransformersJsLocalEmbeddingAdapter`
 * loads its artifacts on first use, so a runtime assembles happily against an
 * empty asset directory and only fails inside `contextctl query` — the first
 * command an operator runs after installing. Verifying the assets here moves
 * that failure to the command whose entire job is to find it.
 *
 * Nothing in this file constructs a runtime, an embedding adapter or a network
 * client that talks to anything. `doctor` must stay fast enough and offline
 * enough that running it is never a decision.
 */

export type DiagnosisStatus = "ok" | "warn" | "fail";

export interface DiagnosisStep {
  /** Short identifier, stable enough to grep for in a bug report. */
  readonly name: string;
  readonly status: DiagnosisStatus;
  /** What was checked and what came back, in the operator's language. */
  readonly detail: string;
  /** The next command to run. Absent when the step is `ok`. */
  readonly remedy?: string;
}

export interface DiagnosisReport {
  readonly steps: readonly DiagnosisStep[];
  /** False if any step failed. A `warn` is a note, not a broken install. */
  readonly healthy: boolean;
}

export interface DiagnosisInput {
  readonly environment: Readonly<Partial<Record<string, string>>>;
  readonly workingDirectory?: string;
  /**
   * Re-hash every installed asset byte instead of trusting the pointer.
   *
   * Off by default because the pinned model is ~390MB: a check an operator
   * avoids running is not a check. See `inspectEmbeddingAssets`.
   */
  readonly deep?: boolean;
}

/** The lowest Node that ships `node:sqlite`, which both stores require. */
const MINIMUM_NODE_MAJOR = 24;

const ASSET_REMEDY =
  "contextctl install-assets 를 실행해 고정된 임베딩 모델(약 415MB)을 설치하세요.";

/**
 * Runs every check in order and reports all of them.
 *
 * Sequential rather than concurrent, and the order is load-bearing rather than
 * cosmetic: `home-directory` creates the directory that the two database steps
 * then open files inside, so running them in parallel would report two
 * spurious failures whenever the real problem is the home directory. It also
 * reads top to bottom the way an operator fixes things — the environment
 * first, then the state, then the optional backends.
 */
export async function runDiagnosis(
  input: DiagnosisInput,
): Promise<DiagnosisReport> {
  const paths = resolveContextctlPaths(
    input.environment,
    input.workingDirectory,
  );
  const steps: DiagnosisStep[] = [
    checkNodeVersion(),
    await checkHomeDirectory(paths.home),
    await checkSourcesFile(paths.sourcesFile),
    checkRegistryDatabase(paths.registryDatabase),
    checkIngestionDatabase(paths.ingestionDatabase),
    await inspectEmbeddingAssets(
      paths.embeddingAssetDirectory,
      input.deep === true,
    ),
    checkVectorBackend(input.environment),
    checkCardMeaning(input.environment),
  ];

  return {
    steps,
    healthy: steps.every((step) => step.status !== "fail"),
  };
}

/**
 * The runtime itself, checked before anything that depends on it.
 *
 * `node:sqlite` is not a dependency that can be installed — it either is in the
 * runtime or it is not — so an operator on Node 22 gets a module-not-found
 * error from the *store*, which reads as a broken package rather than as a
 * wrong Node. Naming the version here turns that into one sentence.
 */
function checkNodeVersion(): DiagnosisStep {
  const version = process.versions.node;
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  if (Number.isNaN(major) || major < MINIMUM_NODE_MAJOR) {
    return diagnosis(
      "node-version",
      "fail",
      `Node ${version} 에서는 node:sqlite 를 쓸 수 없습니다. Registry·Ingestion 저장소가 열리지 않습니다.`,
      `Node ${MINIMUM_NODE_MAJOR} 이상을 설치한 뒤 다시 실행하세요 (예: nvm install ${MINIMUM_NODE_MAJOR}).`,
    );
  }
  return diagnosis(
    "node-version",
    "ok",
    `Node ${version} — node:sqlite 를 쓸 수 있습니다.`,
  );
}

/**
 * The state root, checked by actually writing to it.
 *
 * A `stat` would tell us the directory exists and would tell us its mode bits,
 * and neither answers the question. Permission is decided by the effective
 * user, the ACLs, and — on the machines where this bites — whether the path is
 * on a read-only or sandboxed mount. Writing a file and removing it is the only
 * check whose success means what the operator needs it to mean.
 */
async function checkHomeDirectory(home: string): Promise<DiagnosisStep> {
  const probe = join(home, `.doctor-${randomBytes(6).toString("hex")}.tmp`);
  try {
    await mkdir(home, { recursive: true });
    await writeFile(probe, "contextctl doctor\n", { flag: "wx" });
    return diagnosis(
      "home-directory",
      "ok",
      `상태 디렉터리에 읽고 쓸 수 있습니다: ${home}`,
    );
  } catch (error) {
    return diagnosis(
      "home-directory",
      "fail",
      `상태 디렉터리를 만들거나 쓸 수 없습니다: ${home} (${describeError(error)})`,
      "권한을 확인하거나 CONTEXTCTL_HOME 으로 쓸 수 있는 경로를 지정하세요.",
    );
  } finally {
    // Best effort: a probe left behind is litter, not a failure, and reporting
    // it would bury the finding the operator actually needs.
    await rm(probe, { force: true }).catch(() => undefined);
  }
}

/**
 * The one file an operator edits, and the only place registrations live.
 *
 * Zero Sources is a warning rather than a failure because it is the correct
 * state of a fresh install — nothing is broken, there is simply nothing to
 * ingest yet, and an operator who sees `fail` here will go looking for a
 * problem that does not exist. A malformed file is the opposite: registrations
 * an operator can see in the file are being ignored.
 */
async function checkSourcesFile(sourcesFile: string): Promise<DiagnosisStep> {
  try {
    const document = await readSourcesFile(sourcesFile);
    const count = Object.keys(document.sources).length;
    if (count === 0) {
      return diagnosis(
        "sources-file",
        "warn",
        `등록된 Source 가 없습니다: ${sourcesFile}`,
        "contextctl source add <경로> 로 문서를 등록한 뒤 contextctl ingest 를 실행하세요.",
      );
    }
    return diagnosis(
      "sources-file",
      "ok",
      `Source ${count}개가 등록되어 있습니다: ${sourcesFile}`,
    );
  } catch (error) {
    // The code, not the message, is what distinguishes "hand-edited into
    // invalid JSON" from "exists but unreadable" — and it is what the operator
    // needs, because the two have different fixes.
    const code = error instanceof SourcesFileError ? error.code : "unknown";
    return diagnosis(
      "sources-file",
      "fail",
      `소스 파일을 읽지 못했습니다(${code}): ${sourcesFile} — ${describeError(error)}`,
      "파일을 고치거나, 등록 내용을 버려도 된다면 지운 뒤 contextctl source add 로 다시 등록하세요.",
    );
  }
}

/**
 * Registry's store, opened and closed again.
 *
 * Opening runs the migrations, so success here means more than "the file is
 * readable": it means this build's schema can be applied to whatever is on
 * disk. The handle is closed in a `finally` because `doctor` runs eight checks
 * in one process and a leaked SQLite handle holds locks that make the *next*
 * check — or the next `doctor` run — fail for a reason that has nothing to do
 * with the operator's install.
 */
function checkRegistryDatabase(location: string): DiagnosisStep {
  let database: { close(): void } | undefined;
  try {
    database = openRegistryDatabase(location);
    return diagnosis(
      "registry-database",
      "ok",
      `Registry 저장소를 열었습니다: ${location}`,
    );
  } catch (error) {
    return diagnosis(
      "registry-database",
      "fail",
      `Registry 저장소를 열지 못했습니다: ${location} — ${describeError(error)}`,
      "경로 권한을 확인하거나 CONTEXTCTL_REGISTRY_DATABASE 로 다른 경로를 지정하세요.",
    );
  } finally {
    database?.close();
  }
}

/**
 * Ingestion's store, with the same identity the CLI will use later.
 *
 * The namespace and security domain are passed rather than defaulted locally
 * because `openIngestionDatabase` stamps them into the file and refuses a file
 * stamped with different ones. Diagnosing with a different identity than the
 * real commands use would report a healthy database that `contextctl ingest`
 * then rejects — the exact class of false negative `doctor` exists to remove.
 */
function checkIngestionDatabase(location: string): DiagnosisStep {
  let database: { close(): void } | undefined;
  try {
    database = openIngestionDatabase({
      location,
      stateNamespaceId: DEFAULT_STATE_NAMESPACE_ID,
      securityDomain: DEFAULT_SECURITY_DOMAIN,
    });
    return diagnosis(
      "ingestion-database",
      "ok",
      `Ingestion 저장소를 열었습니다: ${location}`,
    );
  } catch (error) {
    return diagnosis(
      "ingestion-database",
      "fail",
      `Ingestion 저장소를 열지 못했습니다: ${location} — ${describeError(error)}`,
      "경로 권한을 확인하거나, 이전 버전이 남긴 파일이면 지운 뒤 다시 실행하세요.",
    );
  } finally {
    database?.close();
  }
}

/**
 * The installed model, checked without reading a single asset byte.
 *
 * This is the whole reason `doctor` is worth running, and the reason it is
 * cheap. The naive check — `resolveActiveLocalEmbeddingAssets` — re-hashes
 * ~390MB, which turns a diagnostic into a coffee break and guarantees nobody
 * runs it before filing the bug. So the shallow path leans on a property of how
 * the installer writes: the revision directory is *named* after the manifest
 * digest, and `active.json` is renamed into place only after every byte has
 * already been verified once. A pointer naming the expected digest is therefore
 * evidence that a verified install completed, not merely that files exist.
 *
 * Sizes are still stat'ed, because the failure this misses otherwise is the
 * common one: a truncated or partially deleted asset directory under a pointer
 * that is still valid. `stat` catches every wrong-length file for free.
 *
 * What it cannot catch is silent bit rot — right name, right length, wrong
 * bytes. That is what `deep` is for, and it is opt-in precisely because the two
 * modes disagree only in a case that no fresh install is in.
 */
async function inspectEmbeddingAssets(
  directory: string,
  deep: boolean,
): Promise<DiagnosisStep> {
  const pointerPath = join(directory, LOCAL_EMBEDDING_ACTIVE_POINTER_FILE);
  let raw: string;
  try {
    raw = await readFile(pointerPath, "utf8");
  } catch (error) {
    return diagnosis(
      "embedding-assets",
      "fail",
      `임베딩 모델이 설치되어 있지 않습니다: ${pointerPath} 를 읽을 수 없습니다 (${describeError(error)}).`,
      ASSET_REMEDY,
    );
  }

  const pointer = parsePointer(raw);
  if (pointer === undefined) {
    return diagnosis(
      "embedding-assets",
      "fail",
      `설치 포인터가 손상되었습니다: ${pointerPath}`,
      ASSET_REMEDY,
    );
  }
  if (pointer.manifestSha256 !== DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST_SHA256) {
    return diagnosis(
      "embedding-assets",
      "fail",
      `설치된 개정판이 이 빌드가 요구하는 것과 다릅니다. 설치됨=${pointer.manifestSha256}, 필요=${DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST_SHA256}`,
      ASSET_REMEDY,
    );
  }

  const revisionDirectory = resolve(directory, pointer.revisionDirectory);
  if (!isInside(directory, revisionDirectory)) {
    return diagnosis(
      "embedding-assets",
      "fail",
      `설치 포인터가 자산 디렉터리 밖을 가리킵니다: ${pointer.revisionDirectory}`,
      ASSET_REMEDY,
    );
  }

  const problems = await collectSizeProblems(revisionDirectory);
  if (problems.length > 0) {
    return diagnosis(
      "embedding-assets",
      "fail",
      `설치된 파일이 매니페스트와 다릅니다 (${problems.length}건): ${problems.slice(0, 3).join("; ")}`,
      ASSET_REMEDY,
    );
  }

  if (deep) {
    try {
      await verifyLocalEmbeddingAssets(
        revisionDirectory,
        DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
      );
    } catch (error) {
      return diagnosis(
        "embedding-assets",
        "fail",
        `전체 SHA-256 검증에 실패했습니다: ${revisionDirectory} — ${describeError(error)}`,
        ASSET_REMEDY,
      );
    }
    return diagnosis(
      "embedding-assets",
      "ok",
      `임베딩 모델 ${DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST.files.length}개 파일의 전체 SHA-256 을 검증했습니다: ${revisionDirectory}`,
    );
  }

  return diagnosis(
    "embedding-assets",
    "ok",
    `임베딩 모델이 설치되어 있습니다(파일 ${DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST.files.length}개, 이름·크기 확인): ${revisionDirectory}. 내용까지 확인하려면 --deep 을 쓰세요.`,
  );
}

/**
 * Every manifest entry that is missing, is not a file, or is the wrong length.
 *
 * All of them are collected rather than stopping at the first, because a
 * half-deleted directory is one problem with many symptoms and an operator who
 * fixes them one error message at a time learns that the hard way.
 */
async function collectSizeProblems(
  revisionDirectory: string,
): Promise<readonly string[]> {
  const problems: string[] = [];
  for (const file of DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST.files) {
    const path = join(revisionDirectory, file.path);
    try {
      const metadata = await stat(path);
      if (!metadata.isFile()) {
        problems.push(`${file.path}: 파일이 아닙니다`);
      } else if (metadata.size !== file.bytes) {
        problems.push(
          `${file.path}: 크기가 ${metadata.size}바이트, ${file.bytes}바이트여야 합니다`,
        );
      }
    } catch {
      problems.push(`${file.path}: 없습니다`);
    }
  }
  return problems;
}

/**
 * The pointer, reduced to the two fields this module trusts.
 *
 * Deliberately permissive about *shape* and strict about *use*: an unreadable
 * or unexpected pointer is reported as "not installed, run install-assets",
 * never as a thrown exception, because `doctor` failing to run is strictly
 * worse than `doctor` reporting a failure. Anything the installer did not write
 * ends up here as `undefined`.
 */
function parsePointer(
  raw: string,
): { readonly manifestSha256: string; readonly revisionDirectory: string } | undefined {
  if (raw.trim() === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const candidate = parsed as Record<string, unknown>;
  const manifestSha256 = candidate["manifestSha256"];
  const revisionDirectory = candidate["revisionDirectory"];
  if (
    typeof manifestSha256 !== "string" ||
    typeof revisionDirectory !== "string" ||
    revisionDirectory.trim() === "" ||
    isAbsolute(revisionDirectory)
  ) {
    return undefined;
  }
  return { manifestSha256, revisionDirectory };
}

/**
 * The vector index, read from configuration only.
 *
 * No connection is attempted. A `doctor` that hangs for a TCP timeout against a
 * Qdrant an operator has not started yet is a `doctor` that gets interrupted,
 * and "the server is down" is a different question from "is this CLI set up" —
 * `emptyResultDiagnosis` already answers the first one where it matters.
 *
 * In-memory is a warning rather than `ok` because it is the default and it
 * silently loses every index when the process exits, which reads to an operator
 * as `contextctl ingest` having done nothing.
 */
function checkVectorBackend(
  environment: Readonly<Partial<Record<string, string>>>,
): DiagnosisStep {
  try {
    const backend = resolveVectorBackend(environment);
    if (backend.kind === "in_memory") {
      return diagnosis(
        "vector-backend",
        "warn",
        "벡터 색인이 메모리에만 있습니다. 프로세스가 끝나면 색인이 사라져 다음 contextctl query 는 결과가 비어 있습니다.",
        "CONTEXTCTL_QDRANT_URL 로 Qdrant 를 지정하면 색인이 유지됩니다.",
      );
    }
    return diagnosis(
      "vector-backend",
      "ok",
      `Qdrant 를 쓰도록 설정되어 있습니다: ${backend.endpoint ?? "(주소 없음)"} (접속은 확인하지 않았습니다)`,
    );
  } catch (error) {
    return diagnosis(
      "vector-backend",
      "fail",
      `벡터 백엔드 설정이 잘못되었습니다: ${describeError(error)}`,
      "CONTEXTCTL_QDRANT_URL 과 CONTEXTCTL_QDRANT_TIMEOUT_MS 값을 확인하세요.",
    );
  }
}

/**
 * The Card meaning generator, read from configuration only.
 *
 * Three statuses for three genuinely different situations. All three variables
 * unset is `ok`: the deterministic generator is the intended default and an
 * install with no LLM configured is not broken. Some-but-not-all is `warn`,
 * because that operator meant to configure a model and silently is not using
 * one. A malformed tuning value is `fail`, because it is a typo that will keep
 * being a typo.
 *
 * Every string that leaves here goes through `maskSecret`. Not because this
 * module builds one containing the key — it does not — but because the thrown
 * message comes from a validator that quotes the offending value, and the
 * report is serialized to stdout as a whole. The credential is in hand at this
 * point, so removing it costs one string scan and does not depend on trusting
 * whatever produced the text.
 */
function checkCardMeaning(
  environment: Readonly<Partial<Record<string, string>>>,
): DiagnosisStep {
  const apiKey = readNonEmpty(environment, "CONTEXTCTL_CARD_MEANING_API_KEY");
  try {
    const backend = resolveCardMeaningBackend({
      environment,
      // The generator is never invoked here, so no fallback can be reported.
      onFallback: () => undefined,
    });
    if (backend.kind === "llm_with_fallback") {
      return diagnosis(
        "card-meaning",
        "ok",
        maskSecret(
          `Card 의미 생성에 모델을 씁니다: ${backend.model ?? "(모델 없음)"} @ ${backend.endpoint ?? "(주소 없음)"} (접속은 확인하지 않았습니다)`,
          apiKey,
        ),
      );
    }
    if (backend.notices.length > 0) {
      return diagnosis(
        "card-meaning",
        "warn",
        maskSecret(backend.notices.join(" "), apiKey),
        "세 변수를 모두 설정하거나, 결정적 생성기를 쓸 것이라면 모두 비워 두세요.",
      );
    }
    return diagnosis(
      "card-meaning",
      "ok",
      "Card 의미를 결정적 생성기로 만듭니다(기본값). 모델을 쓰려면 CONTEXTCTL_CARD_MEANING_BASE_URL, _MODEL, _API_KEY 를 모두 설정하세요.",
    );
  } catch (error) {
    return diagnosis(
      "card-meaning",
      "fail",
      maskSecret(
        `Card 의미 생성 설정이 잘못되었습니다: ${describeError(error)}`,
        apiKey,
      ),
      "CONTEXTCTL_CARD_MEANING_TIMEOUT_MS, _CONTEXT_TOKENS, _MAX_OUTPUT_TOKENS 값을 확인하세요.",
    );
  }
}

/**
 * Assembles a step, honouring `exactOptionalPropertyTypes`.
 *
 * The remedy is spread rather than assigned because an explicit `undefined` is
 * a different type from an absent key here, and it is also different on the
 * wire: `JSON.stringify` drops the absent one and would emit `"remedy": null`
 * for the other under any serializer that preserves it.
 */
function diagnosis(
  name: string,
  status: DiagnosisStatus,
  detail: string,
  remedy?: string,
): DiagnosisStep {
  return {
    name,
    status,
    detail,
    ...(remedy === undefined ? {} : { remedy }),
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}
