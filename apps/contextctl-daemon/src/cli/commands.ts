import { userInfo } from "node:os";

import {
  runOperatorCommand,
  SqliteConsumerCheckpointStore,
  SqliteScopeReachabilityStore,
  type ContextCard,
} from "@contextctl/registry-lifecycle";

import type { CliCommand } from "./arguments.js";
import {
  renderCardListings,
  renderResolution,
  renderSourceListing,
  type CardListing,
} from "./render.js";
import type { CliRuntime } from "./runtime.js";
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
  return { stdout: "", stderr: [message], exitCode: 1 };
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
  return ok(lines.join("\n"), warning === undefined ? [] : [warning]);
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
export async function runCardsApprove(
  cli: CliRuntime,
  command: Extract<CliCommand, { kind: "cards_approve" }>,
): Promise<CommandOutcome> {
  const decidedBy = command.by ?? currentOperator();
  const versionId = command.versionId ?? (await latestPendingVersionId(cli, command.cardId));
  if (versionId === undefined) {
    return failed(
      `Card ${command.cardId} 에 승인할 수 있는 버전이 없다. contextctl cards list 로 확인하라.`,
    );
  }

  const result = await runOperatorCommand(
    {
      cards: cli.runtime.cards,
      clock: { now: () => new Date().toISOString() },
      ids: { nextId: () => `id_${randomToken()}` },
      scopes: new SqliteScopeReachabilityStore(cli.runtime.database),
      checkpoints: new SqliteConsumerCheckpointStore(cli.runtime.database, () =>
        new Date().toISOString(),
      ),
    },
    ["approve", command.cardId, versionId, "--by", decidedBy,
      ...(command.note === undefined ? [] : ["--note", command.note])],
  );

  const trail = `승인자: ${decidedBy}`;
  if (result.status === "ok") {
    return ok([result.output, trail, "", "다음: contextctl query \"<질문>\""].join("\n"));
  }
  // `usage_error`, `refused` and `gate_failed` are all "Registry said no", and
  // the CLI reports the reason it was given rather than restating it: the
  // vocabulary belongs to the domain that refused.
  return failed(`${result.status}: ${result.output}`);
}

/** The newest version that is not already current, by append order. */
async function latestPendingVersionId(
  cli: CliRuntime,
  cardId: string,
): Promise<string | undefined> {
  const card = await cli.runtime.cards.findCard(cardId);
  if (card === undefined) {
    return undefined;
  }
  return pendingVersionIdsOf(card).at(-1);
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
