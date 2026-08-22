/**
 * What each execution lane can do right now, judged from durable state.
 *
 * A different question from `doctor`, which is why it is a different command.
 * `doctor` asks whether the install is correct and answers with one boolean;
 * this asks which lane cannot do its work at this moment, and one boolean cannot
 * carry that answer. The design says so directly (§130): 상태 점검은 프로세스 하나의
 * 불리언이 아니라 `resolve`, `registry`, `selection_assets`, `ingestion`별
 * `ready | degraded | not_ready`를 제공한다.
 *
 * The judgement is pure and the reads are the caller's. That split is the whole
 * reason this file exists separately from `commands.ts`: every interesting case
 * — Registry two hours behind, assets never installed, a publish that stopped
 * halfway — is a combination of observations, and reproducing those combinations
 * against real SQLite and a 415MB model would mean most of them never get a test.
 *
 * Nothing here is stored. The same reasoning as ADR 0002 in registry-lifecycle:
 * a second copy of a lane's state can disagree with the state it describes, and
 * a status surface that reports a lane degraded because a previous process said
 * so is worse than one that has to re-derive it.
 */

import {
  describeEmbeddingModes,
  localAssetsAreRequired,
  type EmbeddingObservation,
} from "../embedding/readiness.js";
import type { LaneDepth } from "../runtime/admission.js";
import type { DaemonLifecycleState } from "../runtime/lifecycle.js";

export type LaneName = "resolve" | "registry" | "selection_assets" | "ingestion";

/**
 * How well one lane is working.
 *
 * `degraded` is not a failure. A Registry that is two Publications behind keeps
 * serving the Cards it already approved, correctly, and the operator's action is
 * to wait or to run `ingest` — not to treat the service as down. Folding that
 * into `not_ready` is what makes an operator restart a process that was fine.
 */
export type LaneStatus = "ready" | "degraded" | "not_ready";

export interface LaneVerdict {
  readonly lane: LaneName;
  readonly status: LaneStatus;
  /** Why, in the operator's language. One sentence per finding. */
  readonly detail: string;
}

/**
 * What the four execution lanes are doing, when the process being asked is this
 * one.
 *
 * Absent from a one-shot CLI probe, which runs in its own process and has no
 * lanes to report — a `status` invocation is not the daemon. Present when a
 * running daemon answers about itself.
 *
 * Counts only. A queue depth says how loaded a lane is; the queries inside it,
 * the text they carry and the bindings they would reach are none of a status
 * surface's business, and a field that could hold them is a field that
 * eventually does.
 */
export interface RuntimeActivity {
  readonly lifecycle: DaemonLifecycleState;
  readonly profileVersion: string;
  readonly depths: readonly LaneDepth[];
}

export interface StatusReport {
  readonly lanes: readonly LaneVerdict[];
  readonly activity?: RuntimeActivity;
  /** False when any lane is `not_ready`. A `degraded` lane is still serving. */
  readonly serviceable: boolean;
}

/** The embedding artifact, as `resolveActiveAssetDirectory` reports it. */
export type AssetObservation =
  | { readonly status: "installed"; readonly directory: string }
  | { readonly status: "unavailable"; readonly detail: string };

/** The durable vector index required by both publish and resolve paths. */
export type VectorIndexObservation =
  | { readonly status: "configured"; readonly endpoint: string }
  | { readonly status: "unavailable"; readonly detail: string };

/**
 * Registry's own state, as the reachability report gives it.
 *
 * Both signals are derived on every read, which is what makes them usable from a
 * one-shot CLI process. The fork and gap diagnostics are deliberately absent:
 * SEAM-80 decided Registry stores no diagnostics, so a fork is a fact about one
 * `ingest` run and the next process has no way to learn it. Listing it here
 * would have meant a field that is always empty.
 */
export type RegistryObservation =
  | {
      readonly status: "read";
      /** Sources whose newest ready Publication has not been consumed. */
      readonly behindSources: readonly string[];
      /** The longest such delay, when any Source reported one. */
      readonly worstFreshnessLagMs?: number | undefined;
      /** Scope versions that have waited past `STALE_PENDING_REGISTRY_MS`. */
      readonly stalePendingScopeCount: number;
      /** Whether the approved catalog could be read at all. */
      readonly approvedCardCount: number;
    }
  | { readonly status: "unreadable"; readonly detail: string };

/**
 * Ingestion's state, probed one Source at a time.
 *
 * `probedSources` is carried rather than just a count because the limit has to
 * be reportable: the only durable read-only signal Ingestion offers is
 * `pendingRecoveryIntentForSource(sourceId)`, and there is no query that
 * enumerates Sources. The ones we can name are the ones with a consumer cursor —
 * Sources consumed at least once — so a Source that was published and never
 * consumed is outside this probe. Saying `ready` without saying that would be
 * reporting on the absence of evidence.
 */
export type IngestionObservation =
  | {
      readonly status: "read";
      readonly probedSources: readonly string[];
      /** Sources with a prepared publish that never committed. */
      readonly incompleteSources: readonly string[];
    }
  | { readonly status: "unreadable"; readonly detail: string };

export interface StatusObservation {
  readonly assets: AssetObservation;
  /**
   * How the two embedding layers were bound.
   *
   * Present so the asset lanes can tell an absent artifact apart from a
   * missing one. A deployment whose required bindings are all remote never
   * opens the artifact directory, and reporting it unhealthy for being empty
   * would be reporting on a file it was configured not to need.
   */
  readonly embedding: EmbeddingObservation;
  readonly registry: RegistryObservation;
  readonly ingestion: IngestionObservation;
  readonly vectorIndex: VectorIndexObservation;
}

const LANE_ORDER: readonly LaneName[] = [
  "resolve",
  "registry",
  "selection_assets",
  "ingestion",
];

/** Judges every lane from one set of observations. Pure and total. */
export function judgeLanes(
  observation: StatusObservation,
  activity?: RuntimeActivity,
): StatusReport {
  const verdicts: readonly LaneVerdict[] = [
    judgeResolve(observation),
    judgeRegistry(observation.registry),
    judgeSelectionAssets(observation.assets, observation.embedding),
    judgeIngestion(observation.ingestion, observation.vectorIndex),
  ];
  // Ordered by the design's own list rather than by severity. An operator reads
  // the same four lines in the same places every time, and a report that
  // reorders itself by what is wrong is one an operator has to parse rather than
  // scan.
  const lanes = LANE_ORDER.map(
    (lane) => verdicts.find((verdict) => verdict.lane === lane),
  ).filter((verdict): verdict is LaneVerdict => verdict !== undefined);

  return {
    lanes,
    ...(activity === undefined ? {} : { activity }),
    // A draining daemon is not serviceable: it has stopped admitting, so a
    // monitor that kept routing to it would be sending requests that are
    // refused by design rather than by fault.
    serviceable:
      lanes.every((verdict) => verdict.status !== "not_ready") &&
      (activity === undefined || activity.lifecycle === "accepting"),
  };
}

/**
 * Whether a question can be answered right now.
 *
 * The one lane whose rule the design states outright (§120): 마지막 정상 Card와
 * Index를 읽을 수 있으면 Registry 또는 Ingestion 실행 영역이 저하여도 Resolve는
 * 준비 상태를 유지한다. 설정·마이그레이션·공유 저장소가 손상됐거나 승인 대상을
 * 안전하게 해석할 수 없으면 준비 상태로 전환하지 않는다.
 *
 * So a Registry that is behind does not appear here at all. Answering from a
 * Card that is a day old is the system working as designed — the Card describes
 * the source as it was observed, not incorrectly — and a status surface that
 * called that `degraded` would tell an operator to intervene in the normal case.
 *
 * Two things do stop it. Unreadable Registry state means the approval decision
 * cannot be interpreted, which is the design's own second sentence. Missing
 * embedding assets mean the question cannot be turned into a vector, so there is
 * no selection to make — the lane is not slow, it is unable.
 */
function judgeResolve(observation: StatusObservation): LaneVerdict {
  const { registry, assets, vectorIndex } = observation;
  if (registry.status === "unreadable") {
    return lane(
      "resolve",
      "not_ready",
      `승인 Card 상태를 읽을 수 없어 무엇을 답해도 되는지 판단할 수 없습니다: ${registry.detail}`,
    );
  }
  if (observation.embedding.status === "unavailable") {
    return lane(
      "resolve",
      "not_ready",
      `임베딩 제공자를 조립할 수 없어 질문을 벡터로 만들 수 없습니다: ${observation.embedding.detail}`,
    );
  }
  if (
    assets.status === "unavailable" &&
    localAssetsAreRequired(observation.embedding)
  ) {
    return lane(
      "resolve",
      "not_ready",
      "임베딩 자산이 없어 질문을 벡터로 만들 수 없습니다. contextctl install-assets 를 실행하세요.",
    );
  }
  if (vectorIndex.status === "unavailable") {
    return lane(
      "resolve",
      "not_ready",
      `지속 가능한 벡터 인덱스가 설정되지 않았습니다: ${vectorIndex.detail}`,
    );
  }
  if (registry.approvedCardCount === 0) {
    // Degraded, not not_ready: every part works and there is nothing approved to
    // answer with. A fresh install is in this state legitimately, and the action
    // is to approve a Card rather than to repair anything.
    return lane(
      "resolve",
      "degraded",
      "승인된 Card 가 없어 답할 수 있는 것이 없습니다. contextctl cards approve <id> 로 승인하세요.",
    );
  }
  return lane(
    "resolve",
    "ready",
    `승인 Card ${registry.approvedCardCount}개로 답할 수 있습니다. Registry 지연은 이 판정에 영향을 주지 않습니다(설계안 120절).`,
  );
}

/**
 * Whether Registry is keeping up with what Ingestion published.
 *
 * Two findings, both derived: a Source whose newest ready Publication has not
 * been consumed, and a Scope version that has been waiting past the operating
 * standard's five minutes. They are reported together because they are the same
 * delay seen from the two ends — the Source that is behind, and the knowledge
 * that is therefore unreachable.
 */
function judgeRegistry(observation: RegistryObservation): LaneVerdict {
  if (observation.status === "unreadable") {
    return lane(
      "registry",
      "not_ready",
      `Registry 상태를 읽을 수 없습니다: ${observation.detail}`,
    );
  }
  const findings: string[] = [];
  if (observation.behindSources.length > 0) {
    findings.push(
      `소비하지 않은 Publication 이 있는 Source ${observation.behindSources.length}개: ${observation.behindSources.join(", ")}` +
        (observation.worstFreshnessLagMs === undefined
          ? ""
          : ` (가장 오래된 지연 ${formatDuration(observation.worstFreshnessLagMs)})`),
    );
  }
  if (observation.stalePendingScopeCount > 0) {
    findings.push(
      `5분을 넘겨 대기 중인 Scope ${observation.stalePendingScopeCount}개 — registry-reachability-v1 기준으로 lane 을 저하로 봅니다`,
    );
  }
  if (findings.length === 0) {
    return lane(
      "registry",
      "ready",
      "게시된 Publication 을 모두 소비했습니다.",
    );
  }
  // Degraded rather than not_ready, and that is the distinction this whole
  // command exists for: the Cards Registry already approved keep serving while
  // it catches up. `contextctl ingest` is what clears it.
  return lane("registry", "degraded", findings.join(" / "));
}

/**
 * Whether the embedding artifact this build pins is installed.
 *
 * `not_ready` rather than `degraded` when it is missing, because there is no
 * reduced service to speak of: no query can be embedded, so the lane does not
 * work at all. `doctor` reports the same fact and reaches a different sentence —
 * it tells an operator to install, this tells them which lane is down — and both
 * ask `resolveActiveAssetDirectory` so the two cannot disagree about which
 * directory is active.
 */
function judgeSelectionAssets(
  observation: AssetObservation,
  embedding: EmbeddingObservation,
): LaneVerdict {
  if (embedding.status === "unavailable") {
    return lane(
      "selection_assets",
      "not_ready",
      `임베딩 제공자 바인딩을 조립할 수 없습니다: ${embedding.detail}`,
    );
  }
  if (observation.status === "unavailable") {
    // Only a deployment that actually opens an artifact is stopped by its
    // absence. Both layers remote, with no approved Card still reaching a
    // locally published Scope, is a supported way to run: there is no file to
    // install, so telling an operator to install one would be wrong advice.
    if (!localAssetsAreRequired(embedding)) {
      return lane(
        "selection_assets",
        "ready",
        `${describeEmbeddingModes(embedding)}. 로컬 자산이 필요하지 않습니다.`,
      );
    }
    return lane(
      "selection_assets",
      "not_ready",
      `${observation.detail} contextctl install-assets 를 실행하세요.`,
    );
  }
  return lane(
    "selection_assets",
    "ready",
    `임베딩 자산을 쓸 수 있습니다: ${observation.directory}. ${describeEmbeddingModes(embedding)}`,
  );
}

/**
 * Whether any Source has a publish that started and never committed.
 *
 * The probe's limit is stated in every answer, including the healthy one. It can
 * only ask about Sources it can name, and the names come from Registry's
 * consumer cursors — so a Source that was published and never consumed is not
 * covered. An unqualified `ready` here would claim more than was checked.
 */
function judgeIngestion(
  observation: IngestionObservation,
  vectorIndex: VectorIndexObservation,
): LaneVerdict {
  if (vectorIndex.status === "unavailable") {
    return lane(
      "ingestion",
      "not_ready",
      `게시할 지속 가능한 벡터 인덱스가 설정되지 않았습니다: ${vectorIndex.detail}`,
    );
  }
  if (observation.status === "unreadable") {
    return lane(
      "ingestion",
      "not_ready",
      `Ingestion 상태를 읽을 수 없습니다: ${observation.detail}`,
    );
  }
  const limit = `점검 대상은 한 번이라도 소비된 Source ${observation.probedSources.length}개입니다. 게시만 되고 소비된 적 없는 Source 는 여기서 알 수 없습니다.`;
  if (observation.incompleteSources.length > 0) {
    return lane(
      "ingestion",
      "degraded",
      `게시가 끝나지 않은 Source ${observation.incompleteSources.length}개: ${observation.incompleteSources.join(", ")} — contextctl ingest 를 다시 실행하면 이어서 마칩니다. ${limit}`,
    );
  }
  return lane("ingestion", "ready", `끝나지 않은 게시가 없습니다. ${limit}`);
}

function lane(name: LaneName, status: LaneStatus, detail: string): LaneVerdict {
  return { lane: name, status, detail };
}

/**
 * A delay an operator can read without dividing by 1000 in their head.
 *
 * Coarse on purpose: the difference between 8 and 9 minutes changes nothing an
 * operator does, and a millisecond count invites reading precision into a value
 * that came from two `producedAt` timestamps on different clocks.
 */
export function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds < 60) {
    return `${seconds}초`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}분`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}시간` : `${Math.floor(hours / 24)}일`;
}

/** The report as an operator reads it. `--json` prints the object instead. */
export function renderStatusReport(report: StatusReport): string {
  const width = Math.max(...report.lanes.map((verdict) => verdict.lane.length));
  return [
    ...report.lanes.map(
      (verdict) =>
        `${verdict.lane.padEnd(width)}  ${verdict.status.padEnd(9)}  ${verdict.detail}`,
    ),
    "",
    report.serviceable
      ? "서비스할 수 없는 lane 은 없습니다."
      : "not_ready lane 이 있어 서비스할 수 없습니다.",
  ].join("\n");
}
