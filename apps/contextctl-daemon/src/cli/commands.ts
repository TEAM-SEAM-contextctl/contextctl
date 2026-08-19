import { userInfo } from "node:os";

import {
  runOperatorCommand,
  SqliteConsumerCheckpointStore,
  SqliteScopeReachabilityStore,
  type ContextCard,
  type OperatorCommandPorts,
} from "@contextctl/registry-lifecycle";

import type { CliCommand } from "./arguments.js";
import { EXIT_CODES, operatorExitCode, type ExitCode } from "./exit-codes.js";
import {
  describeAssetInstallationPlan,
  planAssetInstallation,
  resolveAssetInstallationTarget,
  runAssetInstallation,
} from "./asset-installation.js";
import { runDiagnosis, type DiagnosisReport } from "./doctor.js";
import { buildPathsReport, renderPathsReport } from "./paths-report.js";
import {
  renderCardListings,
  renderResolution,
  renderSourceListing,
  type CardListing,
} from "./render.js";
import type { RegistryIntakeResult } from "../registry-intake.js";

/** A Source that Registry refused, with the diagnostic that says why. */
type IngestRefusal = Extract<
  RegistryIntakeResult,
  { readonly status: "deferred" | "forked" }
>;
import type { CliRuntime, RegistryOnlyRuntime } from "./runtime.js";
import {
  addSource,
  defaultReferenceFor,
  readSourcesFile,
  removeSource,
  writeSourcesFile,
} from "./sources-file.js";
import { emptyResultDiagnosis, ingestVolatilityWarning } from "./vector-backend.js";

/**
 * What a command produced, before anything is written anywhere.
 *
 * Commands return this rather than printing, for the reason
 * `runOperatorCommand` states about itself: a function that writes to a stream
 * and exits can only be tested through a process. Here it matters twice over,
 * because `serve` puts stdout under JSON-RPC and a command that printed on its
 * own would have no way to know that.
 */
export interface CommandOutcome {
  /** Goes to stdout. Empty means the command has nothing to report. */
  readonly stdout: string;
  /** Goes to stderr. Warnings, diagnoses, and anything a pipe must not eat. */
  readonly stderr: readonly string[];
  readonly exitCode: number;
}

export function ok(stdout: string, stderr: readonly string[] = []): CommandOutcome {
  return { stdout, stderr, exitCode: 0 };
}

export function failed(message: string): CommandOutcome {
  return { stdout: "", stderr: [message], exitCode: EXIT_CODES.refused };
}

/** Fails with a code other than the default, for outcomes a script must tell apart. */
export function failedWith(code: ExitCode, message: string): CommandOutcome {
  return { stdout: "", stderr: [message], exitCode: code };
}

/* ------------------------------------------------------------------ source */

/**
 * Registers a Source, and deliberately does not open a runtime to do it.
 *
 * Registration is a statement about a file on disk; it needs no embedding
 * assets, no databases and no model. Building the runtime here would make
 * `contextctl source add` fail on a machine where the 390MB artifact is not
 * installed yet — which is precisely the machine an operator is standing at when
 * they run it for the first time.
 */
export async function runSourceAdd(
  command: Extract<CliCommand, { kind: "source_add" }>,
  sourcesFile: string,
  workingDirectory: string,
): Promise<CommandOutcome> {
  const document = await readSourcesFile(sourcesFile);
  const reference = command.reference ?? defaultReferenceFor(command.path);
  const updated = addSource(document, {
    reference,
    path: command.path,
    workingDirectory,
    ...(command.displayName === undefined ? {} : { displayName: command.displayName }),
  });
  await writeSourcesFile(sourcesFile, updated);

  const added = updated.sources[reference];
  return ok(
    [
      `Source를 등록했다: ${reference}`,
      `  경로: ${added?.path ?? command.path}`,
      "",
      "다음: contextctl ingest",
    ].join("\n"),
  );
}

export async function runSourceList(sourcesFile: string): Promise<CommandOutcome> {
  const document = await readSourcesFile(sourcesFile);
  return ok(
    renderSourceListing(
      Object.entries(document.sources).map(([reference, source]) => ({
        reference,
        path: source.path,
        displayName: source.displayName,
      })),
    ),
  );
}

export async function runSourceRemove(
  reference: string,
  sourcesFile: string,
): Promise<CommandOutcome> {
  const document = await readSourcesFile(sourcesFile);
  await writeSourcesFile(sourcesFile, removeSource(document, reference));
  return ok(`Source를 제거했다: ${reference}`);
}

/* ------------------------------------------------------------------ ingest */

/**
 * Publishes every registered Source and lets Registry claim what it produced.
 *
 * Publish and claim stay one command because neither is a decision: a document
 * arriving and Registry noticing it are the same operational event. Approval is
 * the decision, and it is a separate command for the reason ADR 0003 gives —
 * nothing reaches service because a file appeared.
 */
export async function runIngest(
  cli: CliRuntime,
  reference: string | undefined,
): Promise<CommandOutcome> {
  const document = await readSourcesFile(cli.paths.sourcesFile);
  const references =
    reference === undefined ? Object.keys(document.sources) : [reference];
  if (references.length === 0) {
    return failed(
      "등록된 Source가 없다. contextctl source add <path> 를 먼저 하라.",
    );
  }
  const unknown = references.filter((each) => document.sources[each] === undefined);
  if (unknown.length > 0) {
    return failed(`등록되지 않은 Source: ${unknown.join(", ")}`);
  }

  const lines: string[] = [];
  // Narrowed at the point of collection rather than at the point of use, so the
  // exit-code decision below reads the diagnostic without re-proving it exists.
  const refusals: IngestRefusal[] = [];
  let claimedVersions = 0;

  for (const each of references) {
    const source = document.sources[each];
    if (source === undefined) {
      continue;
    }
    const published = await cli.runtime.ingestion.workflow.publish({
      source: {
        sourceType: "markdown",
        displayName: source.displayName,
        configReference: each,
        polling: { enabled: false },
      },
      connectorId: cli.runtime.connectorId,
      securityDomain: cli.runtime.securityDomain,
    });

    lines.push(`${each}: ${published.status}`);
    const publicationId = published.publication?.publicationId;
    if (publicationId === undefined) {
      // `unchanged` and `already_published` both reach here. Neither is a
      // failure: the file has not moved since the last run, so there is nothing
      // new for Registry to claim.
      lines.push("  새로 게시된 Publication 없음");
      continue;
    }

    const claimed = await cli.runtime.registryIntake.claim(publicationId);
    lines.push(`  Publication ${publicationId} — ${claimed.status}`);
    if (claimed.status === "deferred" || claimed.status === "forked") {
      // The code and the Source are printed, not just the status word. A refusal
      // that reads as one word tells an operator that something stopped without
      // saying which Source or what to do about it, and the sentence Registry
      // built names the Publications that actually collided.
      refusals.push(claimed);
      lines.push(
        `    ${claimed.diagnostic.code} — ${claimed.diagnostic.detail}`,
        `    Source: ${claimed.sourceId}`,
      );
    }
    for (const version of claimed.cardVersions) {
      claimedVersions += 1;
      const findings =
        version.findings.length === 0
          ? ""
          : ` — 근거 검증 실패: ${version.findings.map((finding) => finding.rule).join(", ")}`;
      lines.push(
        `  Card ${version.cardId} / 버전 ${version.versionId} [${version.validationState}]${findings}`,
      );
    }
  }

  lines.push("");
  lines.push(
    claimedVersions === 0
      ? "새로 만들어진 Card 버전이 없다."
      : `Card 버전 ${claimedVersions}개가 승인을 기다린다. 다음: contextctl cards list`,
  );

  const warning = ingestVolatilityWarning(cli.vectorBackend);
  const stderr = warning === undefined ? [] : [warning];

  // A refused Source means the run did not do what it was asked, so it cannot
  // exit 0: a script or a scheduled job would read a stopped Source as a
  // successful ingest. Fork outranks gap when both happened, because a gap
  // clears itself on the next delivery and a fork waits for a person.
  const forked = refusals.find((refusal) => refusal.status === "forked");
  if (forked !== undefined) {
    return {
      stdout: lines.join("\n"),
      stderr: [...stderr, refusalSummary(forked, "체인이 갈라져 소비를 멈췄습니다")],
      exitCode: EXIT_CODES.chainForked,
    };
  }
  const deferred = refusals[0];
  if (deferred !== undefined) {
    return {
      stdout: lines.join("\n"),
      stderr: [
        ...stderr,
        refusalSummary(deferred, "선행 Publication을 아직 소비하지 않아 보류했습니다"),
      ],
      exitCode: EXIT_CODES.chainDeferred,
    };
  }
  return ok(lines.join("\n"), stderr);
}

/** One line naming the Source, the code and what an operator should read next. */
function refusalSummary(refusal: IngestRefusal, headline: string): string {
  return [
    `${headline}: ${refusal.sourceId} (${refusal.diagnostic.code})`,
    refusal.diagnostic.detail,
  ].join("\n  ");
}

/* ------------------------------------------------------------------- cards */

/**
 * Every Card the Registry database holds, approved or not.
 *
 * The enumeration is one raw `SELECT` against Registry's own table, and it is
 * the single place in this app that depends on Registry's schema rather than on
 * its ports. `CardStore` exposes `listCurrentVersions` and `listApprovedCards`,
 * both of which skip a Card that has never been approved — which is exactly the
 * Card an operator opens this command to find. Everything past the id list goes
 * back through `findCard`, so only the identifiers, never the content, come out
 * of SQL.
 */
export async function runCardsList(
  cli: CliRuntime,
  json: boolean,
): Promise<CommandOutcome> {
  const rows = cli.runtime.database
    .prepare("SELECT card_id FROM cards ORDER BY rowid")
    .all();

  const listings: CardListing[] = [];
  for (const row of rows) {
    // Narrowed rather than cast. `node:sqlite` types a column as the union of
    // everything SQLite can return, so asserting the row shape would be this
    // file claiming knowledge of a schema it only borrows one column from — and
    // a column that changed type would then surface as a confusing failure
    // somewhere else instead of being skipped here.
    const cardId = row["card_id"];
    if (typeof cardId !== "string") {
      continue;
    }
    const card = await cli.runtime.cards.findCard(cardId);
    if (card === undefined) {
      continue;
    }
    listings.push({ card, pendingVersionIds: pendingVersionIdsOf(card) });
  }

  if (json) {
    return ok(JSON.stringify(listings, undefined, 2));
  }
  return ok(renderCardListings(listings));
}

/** Versions that exist but are not the one currently serving. */
function pendingVersionIdsOf(card: ContextCard): readonly string[] {
  return card.versions.versions
    .filter((version) => version.id !== card.versions.currentVersionId)
    .map((version) => version.id);
}

/**
 * Promotes one Card Version, through Registry's own operator surface.
 *
 * `runOperatorCommand` is that surface — ADR 0003 keeps approval off MCP and
 * puts it in an operator's hands, and that file states it never reads
 * `process.argv`, writes to a stream, or exits, because the daemon owns those.
 * This is the daemon owning them. Rebuilding the same decision path here would
 * mean a second place where "may this version be promoted" is answered.
 */
export async function runCardsDecision(
  cli: RegistryOnlyRuntime,
  command: Extract<CliCommand, { kind: "cards_decision" }>,
): Promise<CommandOutcome> {
  const decidedBy = command.by ?? currentOperator();
  let versionId = command.versionId;
  if (command.decision === "disable") {
    return decide(cli, command, ["disable", command.cardId, "--by", decidedBy], decidedBy);
  }
  if (versionId === undefined) {
    const target = await resolveApprovalTarget(cli, command.cardId);
    switch (target.kind) {
      case "version":
        versionId = target.versionId;
        break;
      case "already_current":
        // Reported as success, because it is one. The Card an operator asked to
        // approve is the Card that is serving, and exiting non-zero here would
        // make a re-run of a finished step look like a broken install. Only
        // `approve` can reach this branch — the other decisions require a
        // version, so they never ask which one was meant.
        return ok(
          [
            `Card ${command.cardId} 는 이미 승인되어 있습니다.`,
            `  현재 승인 버전: ${target.currentVersionId}`,
            "",
            '다음: contextctl query "<질문>"',
          ].join("\n"),
        );
      case "card_missing":
        return failed(
          `Card ${command.cardId} 를 찾을 수 없습니다. contextctl cards list 로 확인하세요.`,
        );
      default:
        return failed(
          `Card ${command.cardId} 에 버전이 하나도 없습니다. contextctl ingest 를 먼저 실행하세요.`,
        );
    }
  }

  return decide(
    cli,
    command,
    [command.decision, command.cardId, versionId, "--by", decidedBy],
    decidedBy,
  );
}

/**
 * Hands one decision to Registry and turns its answer into an exit code.
 *
 * The four decisions differ in the word they pass and in nothing else, so they
 * share this path: a second place that assembled ports or mapped statuses would
 * be a second place to keep in step with `OperatorCommandResult`.
 */
async function decide(
  cli: RegistryOnlyRuntime,
  command: Extract<CliCommand, { kind: "cards_decision" }>,
  argv: readonly string[],
  decidedBy: string,
): Promise<CommandOutcome> {
  const result = await runOperatorCommand(
    operatorPorts(cli),
    [...argv, ...(command.note === undefined ? [] : ["--note", command.note])],
  );

  const trail = `결정자: ${decidedBy}`;
  if (result.status === "ok") {
    return ok([result.output, trail, "", ...nextStepFor(command.decision)].join("\n"));
  }
  // The reason is reported as Registry gave it — the vocabulary belongs to the
  // domain that refused — but the status is not flattened into it. A script has
  // to be able to tell a mistyped command from a rule that said no.
  return failedWith(operatorExitCode(result.status), `${result.status}: ${result.output}`);
}

/** What an operator does next, which differs by decision rather than by outcome. */
function nextStepFor(
  decision: Extract<CliCommand, { kind: "cards_decision" }>["decision"],
): readonly string[] {
  switch (decision) {
    case "approve":
    case "rollback":
      return ['다음: contextctl query "<질문>"'];
    case "reject":
    case "disable":
      // Deliberately not a query: nothing new is servable, and the useful next
      // look is at what the Card's state now is.
      return ["다음: contextctl cards list"];
    default: {
      const unreachable: never = decision;
      throw new Error(`unknown decision: ${String(unreachable)}`);
    }
  }
}

/** The ports Registry's operator surface needs, assembled from one database. */
function operatorPorts(cli: RegistryOnlyRuntime): OperatorCommandPorts {
  return {
    cards: cli.cards,
    clock: { now: () => new Date().toISOString() },
    ids: { nextId: () => `id_${randomToken()}` },
    scopes: new SqliteScopeReachabilityStore(cli.database),
    checkpoints: new SqliteConsumerCheckpointStore(cli.database, () =>
      new Date().toISOString(),
    ),
  };
}

/* ------------------------------------------------------ reachability report */

/**
 * The reachability report, and the release gate that reads it.
 *
 * This is the only surface the report has: the design keeps approved Card lists,
 * reachability, status checks and audit on the local operator CLI and status
 * surface, so without this command an operator has no way to see a Scope that
 * was indexed and cannot be reached. `gate_failed` gets its own exit code
 * because CI is the consumer that matters here — a gate whose failure a script
 * cannot detect is not a gate.
 */
export async function runReachability(
  cli: RegistryOnlyRuntime,
  command: Extract<CliCommand, { kind: "reachability" }>,
): Promise<CommandOutcome> {
  const result = await runOperatorCommand(operatorPorts(cli), [
    "reachability",
    ...(command.state === undefined ? [] : ["--state", command.state]),
  ]);

  if (result.status === "ok") {
    return ok(result.output);
  }
  return failedWith(operatorExitCode(result.status), result.output);
}

/**
 * Which version `approve` should promote, or why there is none.
 *
 * Four situations used to collapse into one `undefined` and one sentence about
 * having nothing to approve, and the most common of them is not a failure at
 * all: running `approve` twice on a Card that is already serving. The operator
 * reads "no version can be approved" and concludes the Card is broken.
 *
 * The distinction is read off the Card rather than guessed. `currentVersionId`
 * is the version being served, so a Card with no pending versions and a current
 * one is approved, and a Card with no versions at all never had one.
 */
type ApprovalTarget =
  | { readonly kind: "version"; readonly versionId: string }
  | { readonly kind: "card_missing" }
  | { readonly kind: "no_versions" }
  | { readonly kind: "already_current"; readonly currentVersionId: string };

async function resolveApprovalTarget(
  cli: RegistryOnlyRuntime,
  cardId: string,
): Promise<ApprovalTarget> {
  const card = await cli.cards.findCard(cardId);
  if (card === undefined) {
    return { kind: "card_missing" };
  }
  // Newest first by append order: the latest version is the one an operator
  // means when they name no version at all.
  const pending = pendingVersionIdsOf(card).at(-1);
  if (pending !== undefined) {
    return { kind: "version", versionId: pending };
  }
  const current = card.versions.currentVersionId;
  if (current !== undefined) {
    return { kind: "already_current", currentVersionId: current };
  }
  return { kind: "no_versions" };
}

/**
 * Who the audit trail records when `--by` was not given.
 *
 * The operating system account running the command, because that is the one
 * identity this process can state truthfully. A constant like `cli` would put a
 * name in an append-only trail that identifies nobody.
 */
function currentOperator(): string {
  try {
    return userInfo().username;
  } catch {
    return "unknown-operator";
  }
}

function randomToken(): string {
  return globalThis.crypto.randomUUID().replaceAll("-", "");
}

/* ------------------------------------------------------------------- query */

export async function runQuery(
  cli: CliRuntime,
  command: Extract<CliCommand, { kind: "query" }>,
): Promise<CommandOutcome> {
  const resolution = await cli.runtime.contextApplication.resolveContext({
    query: command.text,
    ...(command.maxContextCharacters === undefined
      ? {}
      : { maxContextCharacters: command.maxContextCharacters }),
  });

  const stdout = command.json
    ? JSON.stringify(resolution, undefined, 2)
    : renderResolution(resolution);

  // Counted through the catalog rather than from the response, because the
  // response deliberately names no Card it did not admit: an answer with zero
  // items and an empty catalog is a different situation from one with a full
  // catalog, and only the first is the operator's next step.
  const approved = await cli.runtime.catalog.listApprovedCards();
  const diagnosis = emptyResultDiagnosis({
    backend: cli.vectorBackend,
    approvedCardCount: approved.length,
    itemCount: resolution.items.length,
  });

  return ok(stdout, diagnosis === undefined ? [] : [diagnosis]);
}


/* --------------------------------------------------------- install-assets */

/**
 * Installs the pinned embedding model, asking first.
 *
 * `progress` is written as the download runs rather than returned with the
 * outcome, which is why this command takes a writer while every other one does
 * not. 415MB moving in silence reads as a hang, and a `CommandOutcome` is only
 * printed once the work it describes has finished.
 *
 * Consent is the caller's to obtain. Whether a prompt is even possible depends
 * on the terminal, and `--yes` is a statement the operator already made; this
 * function is handed the answer rather than working it out from `process`.
 */
export async function runInstallAssets(input: {
  readonly command: Extract<CliCommand, { kind: "install_assets" }>;
  readonly environment: Readonly<Partial<Record<string, string>>>;
  readonly workingDirectory?: string;
  readonly progress: (message: string) => void;
  readonly confirm?: () => Promise<boolean>;
}): Promise<CommandOutcome> {
  const targetDirectory = resolveAssetInstallationTarget({
    environment: input.environment,
    ...(input.command.target === undefined ? {} : { override: input.command.target }),
    ...(input.workingDirectory === undefined
      ? {}
      : { workingDirectory: input.workingDirectory }),
  });
  const plan = planAssetInstallation({
    targetDirectory,
    ...(input.command.sourceDirectory === undefined
      ? {}
      : { sourceDirectory: input.command.sourceDirectory }),
  });
  // The plan is shown before anything is asked, so the operator is agreeing to
  // a stated size, origin and licence rather than to the word "yes".
  input.progress(describeAssetInstallationPlan(plan));

  const outcome = await runAssetInstallation({
    targetDirectory,
    ...(input.command.sourceDirectory === undefined
      ? {}
      : { sourceDirectory: input.command.sourceDirectory }),
    progress: input.progress,
    ...(input.confirm === undefined ? {} : { confirm: input.confirm }),
  });

  switch (outcome.status) {
    case "declined":
      // Not a failure. The operator was asked and said no, and reporting that
      // as an error would make a deliberate choice look like a broken install.
      return ok("설치를 취소했습니다.");
    case "already_installed":
      return ok(
        [
          `이미 설치돼 있습니다: ${outcome.directory ?? targetDirectory}`,
          "",
          "다음: contextctl doctor",
        ].join("\n"),
      );
    default:
      return ok(
        [
          `설치를 마쳤습니다: ${outcome.directory ?? targetDirectory}`,
          "",
          "다음: contextctl doctor",
        ].join("\n"),
      );
  }
}

/* ------------------------------------------------------------------ doctor */

export async function runDoctor(input: {
  readonly command: Extract<CliCommand, { kind: "doctor" }>;
  readonly environment: Readonly<Partial<Record<string, string>>>;
  readonly workingDirectory?: string;
}): Promise<CommandOutcome> {
  const report = await runDiagnosis({
    environment: input.environment,
    deep: input.command.deep,
    ...(input.workingDirectory === undefined
      ? {}
      : { workingDirectory: input.workingDirectory }),
  });

  // Non-zero on any failure, so a script can gate on the diagnosis instead of
  // parsing it. A `warn` keeps zero: it names something worth knowing, not
  // something that stops the next command from working.
  return {
    stdout: renderDiagnosis(report),
    stderr: [],
    exitCode: report.healthy ? 0 : 1,
  };
}

const DIAGNOSIS_MARKS: Readonly<Record<DiagnosisReport["steps"][number]["status"], string>> = {
  ok: "[ok  ]",
  warn: "[warn]",
  fail: "[FAIL]",
};

/**
 * The report as an operator reads it.
 *
 * A fixed-width mark rather than colour, for the reason `render.ts` gives about
 * ANSI: the output is piped into files and pasted into issues, and escape
 * sequences survive both as noise.
 */
function renderDiagnosis(report: DiagnosisReport): string {
  const lines: string[] = [];
  for (const step of report.steps) {
    lines.push(`${DIAGNOSIS_MARKS[step.status]} ${step.name}`);
    lines.push(`       ${step.detail}`);
    if (step.remedy !== undefined) {
      lines.push(`       → ${step.remedy}`);
    }
  }
  lines.push("");
  const failed = report.steps.filter((step) => step.status === "fail").length;
  const warned = report.steps.filter((step) => step.status === "warn").length;
  lines.push(
    report.healthy
      ? warned === 0
        ? "점검을 모두 통과했습니다."
        : `치명적인 문제는 없습니다. 확인할 항목 ${String(warned)}건.`
      : `해결해야 할 문제 ${String(failed)}건. 위의 → 를 따르십시오.`,
  );
  return lines.join("\n");
}


/* ------------------------------------------------------------------- paths */

/**
 * Reports where everything lives. Removes nothing.
 *
 * Runs without a runtime for the same reason `doctor` does: an operator asking
 * where the files are is often asking because something will not start.
 */
export async function runPaths(input: {
  readonly environment: Readonly<Partial<Record<string, string>>>;
  readonly workingDirectory?: string;
}): Promise<CommandOutcome> {
  const report = await buildPathsReport({
    environment: input.environment,
    ...(input.workingDirectory === undefined
      ? {}
      : { workingDirectory: input.workingDirectory }),
  });
  return ok(renderPathsReport(report));
}
