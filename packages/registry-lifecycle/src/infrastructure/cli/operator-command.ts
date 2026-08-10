import {
  approveCardVersion,
  disableCard,
  rejectCardVersion,
  type CardDecisionPorts,
  type OperatorDecision,
} from "../../application/approve-card-version.js";
import { CardNotFoundError } from "../../application/errors.js";
import { CardVersionInvariantError } from "../../domain/errors.js";

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
  /** The decision was carried out. */
  | { readonly status: "ok"; readonly output: string }
  /** The command line was wrong. Nothing was attempted. */
  | { readonly status: "usage_error"; readonly output: string }
  /** The command was well-formed, but Registry refused the decision. */
  | { readonly status: "refused"; readonly output: string };

const USAGE = [
  "usage:",
  "  approve <card-id> <version-id> --by <operator> [--note <text>]",
  "  reject  <card-id> <version-id> --by <operator> [--note <text>]",
  "  disable <card-id> --by <operator> [--note <text>]",
].join("\n");

/** Commands that name a version, and therefore take two operands. */
const VERSION_COMMANDS = { approve: approveCardVersion, reject: rejectCardVersion };

type VersionCommand = keyof typeof VERSION_COMMANDS;

export async function runOperatorCommand(
  ports: CardDecisionPorts,
  argv: readonly string[],
): Promise<OperatorCommandResult> {
  const [command, ...rest] = argv;
  if (command === undefined) {
    return usageError("no command given");
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
    return {
      status: "ok",
      output:
        command === "approve"
          ? `approved ${versionId} as the current version of ${cardId}`
          : `rejected ${versionId} of ${cardId}`,
    };
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
