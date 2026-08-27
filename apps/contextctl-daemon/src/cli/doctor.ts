import { mkdtemp, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
  DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST,
  DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST_SHA256,
  inspectIngestionDatabase,
  verifyLocalEmbeddingAssets,
} from "@contextctl/ingestion-indexing";
import { inspectRegistryDatabase } from "@contextctl/registry-lifecycle";

import {
  readDaemonStateIdentity,
  type DaemonStateIdentity,
} from "../main.js";
import { DEFAULT_GRANITE_ASSET_SIZE_INLINE } from "../embedding-guidance.js";
import {
  describeAssetDirectoryProblem,
  resolveActiveAssetDirectory,
} from "./asset-directory.js";
import {
  cardMeaningRequestUrl,
  maskSecret,
  resolveCardMeaningBackend,
} from "./meaning-generator.js";
import {
  resolvePolicyContext,
  SENSITIVE_ACCESS_VARIABLE,
} from "./policy-context.js";
import { resolveContextctlPaths, readNonEmpty } from "./paths.js";
import { readSourcesFile, SourcesFileError } from "./sources-file.js";
import { resolveVectorBackend } from "../vector-backend.js";
import {
  readActiveEmbeddingProfiles,
  readEmbeddingCompositionConfiguration,
} from "../embedding/configuration.js";

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
  `contextctl install-assets 를 실행해 고정된 임베딩 모델(${DEFAULT_GRANITE_ASSET_SIZE_INLINE})을 설치하세요.`;

/**
 * Runs every check in order and reports all of them.
 *
 * Sequential rather than concurrent so the report reads in the order an
 * operator fixes things — the environment first, then the state, then the
 * optional backends. No step creates persistent application state: a fresh
 * install stays fresh after diagnosis, directory permission probes are
 * removed immediately, and an existing database is opened read-only by its
 * owning package.
 */
export async function runDiagnosis(
  input: DiagnosisInput,
): Promise<DiagnosisReport> {
  const paths = resolveContextctlPaths(
    input.environment,
    input.workingDirectory,
  );
  const stateIdentity = readDaemonStateIdentity(input.environment);
  const steps: DiagnosisStep[] = [
    checkNodeVersion(),
    await checkHomeDirectory(paths.home),
    await checkSourcesFile(paths.sourcesFile),
    checkRegistryDatabase(paths.registryDatabase, stateIdentity),
    checkIngestionDatabase(paths.ingestionDatabase, stateIdentity),
    await inspectConfiguredEmbeddingAssets(
      input.environment,
      paths.embeddingAssetDirectory,
      input.deep === true,
      stateIdentity,
    ),
    checkVectorBackend(input.environment),
    checkCardMeaning(input.environment),
    checkPolicyContext(input.environment),
  ];

  return {
    steps,
    healthy: steps.every((step) => step.status !== "fail"),
  };
}

async function inspectConfiguredEmbeddingAssets(
  environment: Readonly<Partial<Record<string, string>>>,
  directory: string,
  deep: boolean,
  stateIdentity: DaemonStateIdentity,
): Promise<DiagnosisStep> {
  try {
    const configuration = readEmbeddingCompositionConfiguration(
      environment,
      stateIdentity.securityDomain,
    );
    readActiveEmbeddingProfiles(environment, configuration);
    if (
      configuration.document.mode === "remote" &&
      configuration.card.mode === "remote"
    ) {
      return diagnosis(
        "embedding-assets",
        "ok",
        "문서 검색과 Card 선택이 모두 원격 제공자를 사용하므로 활성 로컬 모델 자산이 필요하지 않습니다.",
      );
    }
  } catch (error) {
    return diagnosis(
      "embedding-assets",
      "fail",
      `임베딩 제공자 설정을 사용할 수 없습니다: ${describeError(error)}`,
      "문서 검색과 Card 선택의 모드·엔드포인트·비밀 값·프로필 설정을 확인하세요.",
    );
  }
  return inspectEmbeddingAssets(directory, deep);
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
 * The state root, checked with an ephemeral write probe.
 *
 * A `stat` would tell us the directory exists and would tell us its mode bits,
 * and neither answers the question. Permission is decided by the effective
 * user, the ACLs, and — on the machines where this bites — whether the path is
 * on a read-only or sandboxed mount. Writing a file and removing it is the only
 * check whose success means what the operator needs it to mean.
 */
async function checkHomeDirectory(home: string): Promise<DiagnosisStep> {
  try {
    const metadata = await stat(home);
    if (!metadata.isDirectory()) {
      return diagnosis(
        "home-directory",
        "fail",
        `상태 경로가 디렉터리가 아닙니다: ${home}`,
        "CONTEXTCTL_HOME 으로 디렉터리 경로를 지정하세요.",
      );
    }
    const probe = await mkdtemp(join(home, ".contextctl-doctor-"));
    try {
      await stat(probe);
    } finally {
      await rm(probe, { recursive: true, force: true }).catch(() => undefined);
    }
    return diagnosis(
      "home-directory",
      "ok",
      `상태 디렉터리에 읽고 쓸 수 있습니다: ${home}`,
    );
  } catch (error) {
    if (isMissingPath(error)) {
      return checkMissingHomeDirectory(home);
    }
    return diagnosis(
      "home-directory",
      "fail",
      `상태 디렉터리를 읽거나 쓸 수 없습니다: ${home} (${describeError(error)})`,
      "권한을 확인하거나 CONTEXTCTL_HOME 으로 쓸 수 있는 경로를 지정하세요.",
    );
  }
}

async function checkMissingHomeDirectory(home: string): Promise<DiagnosisStep> {
  try {
    const parent = await nearestExistingDirectory(dirname(home));
    const probe = await mkdtemp(join(parent, ".contextctl-doctor-"));
    await rm(probe, { recursive: true, force: true });
    return diagnosis(
      "home-directory",
      "warn",
      `상태 디렉터리가 아직 없습니다. 필요할 때 만들 수 있는 경로입니다: ${home}`,
      "첫 Source 등록 또는 실행 명령이 상태 디렉터리를 만들며, doctor 자체는 만들지 않습니다.",
    );
  } catch (error) {
    return diagnosis(
      "home-directory",
      "fail",
      `상태 디렉터리를 만들 수 있는 상위 경로가 없습니다: ${home} (${describeError(error)})`,
      "권한을 확인하거나 CONTEXTCTL_HOME 으로 만들 수 있는 경로를 지정하세요.",
    );
  }
}

async function nearestExistingDirectory(path: string): Promise<string> {
  let candidate = path;
  while (true) {
    try {
      const metadata = await stat(candidate);
      if (!metadata.isDirectory()) {
        throw new Error(`상위 경로가 디렉터리가 아닙니다: ${candidate}`);
      }
      return candidate;
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
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
 * Registry's store, inspected through Registry's read-only public surface.
 */
function checkRegistryDatabase(
  location: string,
  stateIdentity: DaemonStateIdentity,
): DiagnosisStep {
  try {
    const inspection = inspectRegistryDatabase({
      location,
      ...stateIdentity,
    });
    if (inspection.status === "missing") {
      return diagnosis(
        "registry-database",
        "warn",
        `Registry 저장소가 아직 없습니다: ${location}`,
        "첫 Registry 작업이 저장소를 초기화합니다. 운영 식별자를 먼저 확정하세요.",
      );
    }
    if (inspection.status === "compatible") {
      return diagnosis(
        "registry-database",
        "ok",
        `Registry 저장소가 읽기 전용 검사에 통과했습니다(schema ${inspection.schemaVersion}): ${location}`,
      );
    }
    if (inspection.status === "incompatible") {
      return diagnosis(
        "registry-database",
        "fail",
        `Registry 저장소가 현재 설정과 호환되지 않습니다(${inspection.code}): ${location}`,
        "상태 식별자와 실행 버전을 확인하고, 변경 전 상태 묶음을 백업한 뒤 지원되는 이관 절차를 사용하세요.",
      );
    }
    return diagnosis(
      "registry-database",
      "fail",
      `Registry 저장소를 읽지 못했습니다: ${location} — ${inspection.detail}`,
      "파일 경로·읽기 권한과 SQLite 파일 손상 여부를 확인하세요.",
    );
  } catch (error) {
    return diagnosis(
      "registry-database",
      "fail",
      `Registry 저장소 설정을 검사하지 못했습니다: ${location} — ${describeError(error)}`,
      "CONTEXTCTL_REGISTRY_DATABASE 와 상태 식별자 설정을 확인하세요.",
    );
  }
}

/**
 * Ingestion's store, inspected with the identity the CLI will use later.
 */
function checkIngestionDatabase(
  location: string,
  stateIdentity: DaemonStateIdentity,
): DiagnosisStep {
  try {
    const inspection = inspectIngestionDatabase({
      location,
      ...stateIdentity,
    });
    if (inspection.status === "missing") {
      return diagnosis(
        "ingestion-database",
        "warn",
        `Ingestion 저장소가 아직 없습니다: ${location}`,
        "첫 수집 작업이 저장소를 초기화합니다. 운영 식별자를 먼저 확정하세요.",
      );
    }
    if (inspection.status === "compatible") {
      return diagnosis(
        "ingestion-database",
        "ok",
        `Ingestion 저장소가 읽기 전용 검사에 통과했습니다(schema ${inspection.schemaVersion}): ${location}`,
      );
    }
    if (inspection.status === "incompatible") {
      return diagnosis(
        "ingestion-database",
        "fail",
        `Ingestion 저장소가 현재 설정과 호환되지 않습니다(${inspection.code}): ${location}`,
        "상태 식별자와 실행 버전을 확인하고, 변경 전 상태 묶음을 백업한 뒤 지원되는 이관 절차를 사용하세요.",
      );
    }
    return diagnosis(
      "ingestion-database",
      "fail",
      `Ingestion 저장소를 읽지 못했습니다: ${location} — ${inspection.detail}`,
      "파일 경로·읽기 권한과 SQLite 파일 손상 여부를 확인하세요.",
    );
  } catch (error) {
    return diagnosis(
      "ingestion-database",
      "fail",
      `Ingestion 저장소 설정을 검사하지 못했습니다: ${location} — ${describeError(error)}`,
      "CONTEXTCTL_INGESTION_DATABASE 와 상태 식별자 설정을 확인하세요.",
    );
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
  // Resolved through the shared module rather than here. Reading `active.json`
  // in this file is what let the diagnosis and the composition disagree about
  // which directory the assets are in — every check passed and the first embed
  // failed. There is one answer now and both callers ask for it.
  const resolution = await resolveActiveAssetDirectory(
    directory,
    DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST_SHA256,
  );
  if (resolution.status === "unavailable") {
    return diagnosis(
      "embedding-assets",
      "fail",
      describeAssetDirectoryProblem(resolution.problem),
      ASSET_REMEDY,
    );
  }
  const revisionDirectory = resolution.directory;

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
 * The vector index, read from configuration only.
 *
 * No connection is attempted. A `doctor` that hangs for a TCP timeout against a
 * Qdrant an operator has not started yet is a `doctor` that gets interrupted,
 * and "the server is down" is a different question from "is this CLI set up".
 * The endpoint is nevertheless mandatory: an unset endpoint is a broken
 * production composition, not a request for a volatile fallback.
 */
function checkVectorBackend(
  environment: Readonly<Partial<Record<string, string>>>,
): DiagnosisStep {
  try {
    const backend = resolveVectorBackend(environment);
    return diagnosis(
      "vector-backend",
      "ok",
      `Qdrant 를 쓰도록 설정되어 있습니다: ${backend.endpoint} (접속은 확인하지 않았습니다)`,
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
      // The URL the adapter will request, not the root that was configured.
      // The adapter appends `/v1/chat/completions` privately, so an operator
      // reading back their own setting cannot see what is actually called —
      // which is how a doubled `/v1` produces a 404 that names neither.
      const requestUrl =
        backend.endpoint === undefined
          ? "(주소 없음)"
          : cardMeaningRequestUrl(backend.endpoint);
      const detail = maskSecret(
        `Card 의미 생성에 모델을 씁니다: ${backend.model ?? "(모델 없음)"} @ ${requestUrl} (접속은 확인하지 않았습니다)`,
        apiKey,
      );
      // Notices are checked inside this branch as well as below it. A complete
      // configuration can still be a wrong one, and reporting `ok` because all
      // three variables are present would hide exactly the warning that says
      // the endpoint they compose is unreachable.
      if (backend.notices.length > 0) {
        return diagnosis(
          "card-meaning",
          "warn",
          maskSecret([detail, ...backend.notices].join("\n       "), apiKey),
          "CONTEXTCTL_CARD_MEANING_BASE_URL 을 루트만 남기고 다시 설정하세요.",
        );
      }
      return diagnosis("card-meaning", "ok", detail);
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
 * The access policy every query will run under, read from configuration only.
 *
 * `deny` is `ok` and says what it excludes. `allow` is `warn` rather than `ok`
 * even though it is a value the operator chose: the consequence — Cards
 * approved as sensitive are reachable by every query this process answers —
 * is the kind a reader of a health report should not have to infer from a
 * variable name, so the step states the result, not the setting. An undefined
 * value is `fail`, because the runtime will refuse to start on it.
 */
function checkPolicyContext(
  environment: Readonly<Partial<Record<string, string>>>,
): DiagnosisStep {
  try {
    const policy = resolvePolicyContext(environment);
    if (policy.sensitiveAccess === "allow") {
      return diagnosis(
        "policy-context",
        "warn",
        `${SENSITIVE_ACCESS_VARIABLE}=allow — 민감(sensitive: true)으로 승인된 Card가 질의에 노출된다. 이 프로세스가 답하는 모든 표면(MCP, HTTP, query CLI)에서 그 Card의 내용이 검색 결과에 실린다.`,
        `의도한 설정이 아니면 ${SENSITIVE_ACCESS_VARIABLE} 를 비워 기본값 deny 로 되돌리라.`,
      );
    }
    return diagnosis(
      "policy-context",
      "ok",
      `민감(sensitive: true) Card는 모든 질의에서 점수 계산 전에 제외된다(기본값 deny). 용도는 retrieval 로 고정이다.`,
    );
  } catch (error) {
    return diagnosis(
      "policy-context",
      "fail",
      `접근 정책 설정이 잘못되었다: ${describeError(error)}`,
      `${SENSITIVE_ACCESS_VARIABLE} 는 deny 또는 allow 만 받는다. ingest, query, serve 는 이 값으로는 시작하지 않는다.`,
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

function isMissingPath(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
