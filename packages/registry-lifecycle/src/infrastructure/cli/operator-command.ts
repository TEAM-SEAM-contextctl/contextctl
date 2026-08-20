import {
  approveCardVersion,
  disableCard,
  rejectCardVersion,
  rollbackCardVersion,
  type CardDecisionPorts,
  type OperatorDecision,
} from "../../application/approve-card-version.js";
import { buildReachabilityReport } from "../../application/build-reachability-report.js";
import { CardNotFoundError } from "../../application/errors.js";
import { CardVersionInvariantError } from "../../domain/errors.js";
import {
  STALE_PENDING_REGISTRY_MS,
  stalePendingRegistryScopes,
} from "../../domain/processing-lag.js";
import {
  reachabilityGateViolations,
  type ReachabilityGateViolation,
  type ReachabilityReport,
  type ScopeReachabilityState,
} from "../../domain/scope-reachability.js";
import type { ConsumerCheckpointStore } from "../../ports/consumer-checkpoint-store.js";
import type {
  PublicationRepository,
  SourcePublicationFeed,
} from "../../ports/publication-repository.js";
import type { ScopeReachabilityStore } from "../../ports/scope-reachability-store.js";

/**
 * The operator control plane surface over this domain.
 *
 * ADR 0003 keeps approval off MCP, so a Card reaches service only through an
 * operator's own hands. This file is that path. It parses arguments and calls a
 * use case; it never reads `process.argv`, writes to a stream, or exits. The
 * daemon owns those, exactly as it owns `listen` for Selection's HTTP surface.
 *
 * Keeping the process out means every branch below is reachable from a plain
 * function call in a test, including the ones that reject bad input.
 */
export type OperatorCommandResult =
  /** The decision was carried out, or the report came back clean. */
  | { readonly status: "ok"; readonly output: string }
  /** The command line was wrong. Nothing was attempted. */
  | { readonly status: "usage_error"; readonly output: string }
  /** The command was well-formed, but Registry refused the decision. */
  | { readonly status: "refused"; readonly output: string }
  /**
   * The report ran and the release gate did not pass.
   *
   * Separate from `ok` so a caller learns the outcome from the status rather
   * than by reading the text. A gate that always reports success unless
   * someone reads the output is not a gate.
   */
  | { readonly status: "gate_failed"; readonly output: string };

export interface OperatorCommandPorts extends CardDecisionPorts {
  readonly scopes: ScopeReachabilityStore;
  /** Read for the reachability report's per-Source checkpoints. */
  readonly checkpoints: ConsumerCheckpointStore;
  /**
   * How far each Source has been published, and what those Publications carry.
   *
   * Required for the same reason `buildReachabilityReport` requires it: a Scope
   * waiting to be consumed can only be found by reading Ingestion, and that is
   * one of the six states rather than an optional extra.
   */
  readonly publications: SourcePublicationFeed & PublicationRepository;
}

const USAGE = [
  "usage:",
  "  approve <card-id> <version-id> --by <operator> [--note <text>]",
  "  reject  <card-id> <version-id> --by <operator> [--note <text>]",
  "  rollback <card-id> <version-id> --by <operator> [--note <text>]",
  "  disable <card-id> --by <operator> [--note <text>]",
  "  reachability [--state <state>]",
].join("\n");

const REACHABILITY_STATES: readonly ScopeReachabilityState[] = [
  "pending_registry",
  "broken",
  "reachable",
  "pending_approval",
  "intentionally_unexposed",
  "orphaned",
];

/** Commands that name a version, and therefore take two operands. */
const VERSION_COMMANDS = {
  approve: approveCardVersion,
  reject: rejectCardVersion,
  // Rollback is a pointer move like approve, and refuses a target that does not
  // precede the current version. Same shape, so it belongs in the same table.
  rollback: rollbackCardVersion,
};

type VersionCommand = keyof typeof VERSION_COMMANDS;

export async function runOperatorCommand(
  ports: OperatorCommandPorts,
  argv: readonly string[],
): Promise<OperatorCommandResult> {
  const [command, ...rest] = argv;
  if (command === undefined) {
    return usageError("no command given");
  }
  // Reachability reads; it decides nothing. It parses on its own so it never
  // has to answer for `--by`, which exists to name who decided.
  if (command === "reachability") {
    return runReachability(ports, rest);
  }
  if (!isVersionCommand(command) && command !== "disable") {
    return usageError(`unknown command: ${command}`);
  }

  const parsed = parseArguments(rest);
  if (parsed.error !== undefined) {
    return usageError(parsed.error);
  }

  if (parsed.decidedBy === undefined) {
    // An approval trail that cannot name who approved is not a trail, so the
    // surface refuses rather than inventing an actor.
    return usageError("--by is required: the audit trail records who decided");
  }
  const decision: OperatorDecision = {
    decidedBy: parsed.decidedBy,
    ...(parsed.note === undefined ? {} : { note: parsed.note }),
  };

  const expected = command === "disable" ? 1 : 2;
  if (parsed.operands.length !== expected) {
    return usageError(
      `${command} takes ${expected} argument(s), got ${parsed.operands.length}`,
    );
  }
  const [cardId, versionId] = parsed.operands;
  if (cardId === undefined) {
    return usageError("card id is required");
  }

  try {
    if (command === "disable") {
      await disableCard(ports, cardId, decision);
      return { status: "ok", output: `disabled ${cardId}` };
    }
    if (versionId === undefined) {
      return usageError("version id is required");
    }
    await VERSION_COMMANDS[command](ports, cardId, versionId, decision);
    return { status: "ok", output: describeDone(command, cardId, versionId) };
  } catch (error) {
    // A missing Card or a refused promotion is the operator being told no, not
    // a crash: report it and let the daemon turn the status into an exit code.
    if (
      error instanceof CardNotFoundError ||
      error instanceof CardVersionInvariantError
    ) {
      return { status: "refused", output: error.message };
    }
    throw error;
  }
}

/**
 * Prints the reachability report, and fails when the release gate does.
 *
 * Listing one state is the second question an operator asks: the summary says
 * an orphaned Scope exists, and `--state orphaned` says which one, which is
 * what they need before deciding to build a Card, approve one, or record why
 * it stays unexposed.
 */
async function runReachability(
  ports: OperatorCommandPorts,
  argv: readonly string[],
): Promise<OperatorCommandResult> {
  const [option, value, ...extra] = argv;
  if (option !== undefined && option !== "--state") {
    return usageError(`unknown option: ${option}`);
  }
  if (option === "--state" && (value === undefined || value.startsWith("--"))) {
    return usageError("--state needs a value");
  }
  if (extra.length > 0) {
    return usageError(`reachability takes no extra arguments: ${extra[0]}`);
  }

  const state = REACHABILITY_STATES.find((candidate) => candidate === value);
  if (option === "--state" && state === undefined) {
    return usageError(
      `unknown state: ${value}\nstates: ${REACHABILITY_STATES.join(", ")}`,
    );
  }

  const report = await buildReachabilityReport(ports);

  if (state !== undefined) {
    return { status: "ok", output: formatScopeList(report, state) };
  }

  const violations = reachabilityGateViolations(report);
  const output = [formatSummary(report), formatGate(violations)].join("\n");
  return violations.length === 0
    ? { status: "ok", output }
    : { status: "gate_failed", output };
}

function formatSummary(report: ReachabilityReport): string {
  if (report.scopes.length === 0) {
    // An empty list would read as "all clear" when it may mean nothing has
    // been processed at all, so it says which.
    return `no scope versions have been processed yet (at ${report.generatedAt})`;
  }

  const coverage = Math.round(report.currentReachabilityCoverage * 100);
  const width = Math.max(...REACHABILITY_STATES.map((state) => state.length));
  const lines = REACHABILITY_STATES.filter(
    (state) => report.counts[state] > 0,
  ).map((state) => `  ${state.padEnd(width)}  ${report.counts[state]}`);

  return [
    `reachability at ${report.generatedAt} — coverage ${coverage}% of ${report.scopes.length} scope version(s)`,
    ...lines,
    ...formatProcessingDelay(report),
  ].join("\n");
}

/**
 * Per-Source processing delay, and the stale `pending_registry` verdict.
 *
 * Printed with the states rather than behind a separate command, because the two
 * answer one question together: a Scope sitting in `pending_registry` is only
 * worrying if the Source it belongs to is also behind, and an operator holding
 * one number without the other cannot tell a slow minute from a stuck hour.
 *
 * Sources that are caught up print nothing. Listing every healthy Source would
 * bury the one that is not, and "no line" already means "nothing owed" — the
 * summary above states the total, so silence here is not ambiguous.
 */
function formatProcessingDelay(report: ReachabilityReport): readonly string[] {
  const behind = report.sourceFreshnessLags.filter((source) => source.behind);
  const stale = stalePendingRegistryScopes(report);
  if (behind.length === 0 && stale.length === 0) {
    return [];
  }

  // Position and delay are two readings of the same Source, joined here by id
  // rather than in the model: what an operator reads is one line per Source, and
  // what the report publishes is two arrays the design keeps apart.
  const positions = new Map(
    report.sourceCheckpoints.map((checkpoint) => [checkpoint.sourceId, checkpoint]),
  );
  const lines = behind.map((source) => {
    const lag =
      source.freshnessLagMs === undefined
        ? "lag unknown"
        : `lag ${formatDuration(source.freshnessLagMs)}`;
    const position = positions.get(source.sourceId);
    const processed = position?.processedPublicationId ?? "nothing consumed";
    return `  ${source.sourceId}: ${processed} -> ${position?.latestReadyPublicationId ?? "?"} (${lag})`;
  });

  return [
    behind.length === 0
      ? "processing delay: every source is current"
      : `processing delay: ${behind.length} source(s) behind`,
    ...lines,
    ...(stale.length === 0
      ? []
      : [
          `pending_registry over ${formatDuration(STALE_PENDING_REGISTRY_MS)}: ${stale.length} scope version(s) — registry lane is degraded`,
          ...stale.map(
            (scope) =>
              `  ${scope.reference.scopeId}@${scope.reference.scopeVersion} since ${scope.stateSince ?? "unknown"}`,
          ),
        ]),
  ];
}

/** Milliseconds as something an operator reads, not as a number of millis. */
function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function formatGate(
  violations: readonly ReachabilityGateViolation[],
): string {
  if (violations.length === 0) {
    return "gate registry-reachability-v1: passed";
  }
  return [
    "gate registry-reachability-v1: FAILED",
    ...violations.map(
      (violation) => `  ${violation.rule}: ${violation.message}`,
    ),
  ].join("\n");
}

function formatScopeList(
  report: ReachabilityReport,
  state: ScopeReachabilityState,
): string {
  const matching = report.scopes.filter((scope) => scope.state === state);
  if (matching.length === 0) {
    return `no scope versions are ${state}`;
  }

  return [
    `${matching.length} scope version(s) are ${state}`,
    ...matching.map((scope) => {
      const reason = scope.reason === undefined ? "" : ` — ${scope.reason}`;
      // Both ids: the first says when the Scope appeared, the second which
       // Publication last carried it. One of them alone reads as the whole story.
      const carried =
        scope.lastSeenPublicationId === scope.introducedByPublicationId
          ? scope.introducedByPublicationId
          : `${scope.introducedByPublicationId} → ${scope.lastSeenPublicationId}`;
      // The Source leads the line. An operator reading this list is choosing
      // whether to create a Card, approve one, or mark the Scope unexposed, and
      // none of those decisions can be made about a bare Scope id.
      const source = scope.sourceId;
      const event =
        scope.lifecycleEventId === undefined ? "" : ` [event ${scope.lifecycleEventId}]`;
      return `  ${source}  ${scope.reference.scopeId}@${scope.reference.scopeVersion} (${carried})${event}${reason}`;
    }),
  ].join("\n");
}

function describeDone(
  command: VersionCommand,
  cardId: string,
  versionId: string,
): string {
  switch (command) {
    case "approve":
      return `approved ${versionId} as the current version of ${cardId}`;
    case "reject":
      return `rejected ${versionId} of ${cardId}`;
    case "rollback":
      // Says which direction the pointer moved, so the operator can see the
      // rollback took effect rather than inferring it from silence.
      return `rolled ${cardId} back to ${versionId}`;
    default: {
      const unreachable: never = command;
      throw new Error(`unknown command: ${String(unreachable)}`);
    }
  }
}

function isVersionCommand(command: string): command is VersionCommand {
  return Object.hasOwn(VERSION_COMMANDS, command);
}

function usageError(reason: string): OperatorCommandResult {
  return { status: "usage_error", output: `${reason}\n\n${USAGE}` };
}

type ParsedArguments =
  | { readonly error: string }
  | {
      readonly error?: undefined;
      readonly operands: readonly string[];
      readonly decidedBy: string | undefined;
      readonly note: string | undefined;
    };

/** Splits `--by` and `--note` out of the positional arguments. */
function parseArguments(argv: readonly string[]): ParsedArguments {
  const operands: string[] = [];
  let decidedBy: string | undefined;
  let note: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      break;
    }
    if (!token.startsWith("--")) {
      operands.push(token);
      continue;
    }

    if (token !== "--by" && token !== "--note") {
      return { error: `unknown option: ${token}` };
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return { error: `${token} needs a value` };
    }
    if (token === "--by") {
      decidedBy = value === "" ? undefined : value;
    } else {
      note = value;
    }
    index += 1;
  }

  return { operands, decidedBy, note };
}
