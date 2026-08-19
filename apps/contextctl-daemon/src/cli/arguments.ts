import { parseArgs, type ParseArgsOptionsConfig } from "node:util";

/**
 * Turns an argument vector into a command, and nothing else.
 *
 * This module is deliberately inert: it does not read `process.argv`, does not
 * write to stdout or stderr, and never calls `process.exit`. All three are
 * effects that make a parser untestable — a test would have to spawn a process
 * to find out whether `--max-context 0` is rejected — and all three belong to
 * the entry point, which is the one place that legitimately owns the process.
 * So a usage error is *returned* as a value, and the caller decides that it
 * means "print this and exit 2".
 *
 * `node:util`'s `parseArgs` does the tokenizing. ADR 0005 fixed this repository
 * at zero runtime dependencies, so a CLI framework was never an option, and
 * `parseArgs` handles the part that is genuinely tedious (`--name=value` versus
 * `--name value`, `--` termination) while leaving the part that is actually
 * ours — which combinations mean what — to code below that can be read.
 */

export type CliCommand =
  | {
      readonly kind: "source_add";
      readonly path: string;
      readonly reference?: string;
      readonly displayName?: string;
    }
  | { readonly kind: "source_list" }
  | { readonly kind: "source_remove"; readonly reference: string }
  | { readonly kind: "ingest"; readonly reference?: string }
  | { readonly kind: "cards_list"; readonly json: boolean }
  | {
      readonly kind: "cards_approve";
      readonly cardId: string;
      readonly versionId?: string;
      readonly by?: string;
      readonly note?: string;
    }
  | {
      readonly kind: "query";
      readonly text: string;
      readonly json: boolean;
      readonly maxContextCharacters?: number;
    }
  | {
      readonly kind: "install_assets";
      /** Skip the consent prompt. Also implied when stdin is not a terminal. */
      readonly yes: boolean;
      /** Read the bytes from a directory staged ahead of time. */
      readonly sourceDirectory?: string;
      /** Install somewhere other than the configured asset directory. */
      readonly target?: string;
    }
  | { readonly kind: "doctor"; readonly deep: boolean }
  | { readonly kind: "serve" }
  | { readonly kind: "help"; readonly topic?: string }
  | { readonly kind: "version" };

export type ParsedArguments =
  | { readonly status: "ok"; readonly command: CliCommand }
  | UsageError;

/**
 * The operator typed something this CLI cannot act on.
 *
 * One message rather than a code plus a template, because a usage error has
 * exactly one consumer — a human reading a terminal — and splitting it would
 * only push the job of assembling the sentence out to every call site.
 */
export interface UsageError {
  readonly status: "usage_error";
  readonly message: string;
}

interface CommandUsage {
  /** How `help <topic>` and `--help` name this command. */
  readonly topic: string;
  readonly line: string;
  readonly summary: string;
}

/**
 * The whole surface, in one table.
 *
 * Usage text is generated from this rather than written as a string constant
 * beside a separate parser, because the two drift: a flag gets added to the
 * parser, the help text keeps describing the old surface, and the operator
 * trusts the help text. Here a command that is not in the table has no help,
 * which is a visible gap rather than a silent lie.
 */
const COMMAND_USAGES: readonly CommandUsage[] = [
  {
    topic: "install-assets",
    line: "contextctl install-assets [--yes] [--target <dir>] [--source-directory <dir>]",
    summary:
      "질의에 필요한 임베딩 모델을 내려받아 설치한다. 약 415MB를 받으므로 먼저 동의를 묻는다.",
  },
  {
    topic: "doctor",
    line: "contextctl doctor [--deep]",
    summary:
      "설치 상태를 점검하고 다음에 할 일을 알려준다. --deep 은 모델 파일 전체를 다시 검증한다(느리다).",
  },
  {
    topic: "source add",
    line: "contextctl source add <path> [--name <ref>] [--display-name <text>]",
    summary: "문서 파일이나 디렉터리를 소스로 등록한다. --name 을 생략하면 경로에서 참조를 만든다.",
  },
  {
    topic: "source list",
    line: "contextctl source list",
    summary: "등록된 소스를 모두 보여준다.",
  },
  {
    topic: "source remove",
    line: "contextctl source remove <ref>",
    summary: "등록된 소스를 지운다. 이미 수집된 문서는 지우지 않는다.",
  },
  {
    topic: "ingest",
    line: "contextctl ingest [<ref>]",
    summary: "소스를 읽어 카드 후보를 만든다. 참조를 생략하면 등록된 소스를 전부 수집한다.",
  },
  {
    topic: "cards list",
    line: "contextctl cards list [--json]",
    summary: "카드와 승인 상태를 보여준다.",
  },
  {
    topic: "cards approve",
    line: "contextctl cards approve <cardId> [<versionId>] [--by <who>] [--note <text>]",
    summary: "카드 버전을 승인한다. 버전을 생략하면 최신 버전을 승인한다.",
  },
  {
    topic: "query",
    line: 'contextctl query "<질문>" [--json] [--max-context <n>]',
    summary: "승인된 카드에서 컨텍스트를 선택해 답한다. --max-context 는 문자 수 상한이다.",
  },
  {
    topic: "serve",
    line: "contextctl serve",
    summary: "MCP 서버를 띄운다.",
  },
  {
    topic: "help",
    line: "contextctl help [<command>]",
    summary: "이 도움말, 또는 한 명령의 도움말을 보여준다.",
  },
  {
    topic: "version",
    line: "contextctl --version",
    summary: "버전을 출력한다.",
  },
];

/** `argv` is `process.argv.slice(2)` — the program and script are not ours. */
export function parseCliArguments(argv: readonly string[]): ParsedArguments {
  // No arguments is not a mistake, it is someone finding out what this is. It
  // resolves to `help` rather than to a usage error so the caller can exit 0:
  // a bare `contextctl` that exits non-zero breaks any script that probes for
  // the binary's presence.
  if (argv.length === 0) {
    return ok({ kind: "help" });
  }

  // `--help` wins wherever it appears, before any option validation, because
  // help is exactly what someone who typed an invalid flag needs. Rejecting
  // `contextctl query --nope --help` for `--nope` would be technically correct
  // and useless.
  const helpIndex = argv.findIndex(
    (token) => token === "--help" || token === "-h",
  );
  if (helpIndex >= 0) {
    const leading = argv
      .slice(0, helpIndex)
      .filter((token) => !token.startsWith("-"));
    if (leading.length === 0) {
      return ok({ kind: "help" });
    }
    const topic = resolveTopic(leading);
    return topic === undefined
      ? usageError(`알 수 없는 명령입니다: ${leading.join(" ")}`)
      : ok({ kind: "help", topic });
  }

  // Only as the sole argument. `--version` combined with a command is not a
  // request this CLI can honour in one process, and guessing which half the
  // operator meant is worse than saying so.
  if (argv.length === 1 && argv[0] === "--version") {
    return ok({ kind: "version" });
  }

  const first = argv[0];
  if (first === undefined || first.startsWith("-")) {
    return usageError(`알 수 없는 옵션입니다: ${String(first)}`);
  }

  switch (first) {
    case "source":
      return parseSourceCommand(argv.slice(1));
    case "cards":
      return parseCardsCommand(argv.slice(1));
    case "ingest":
      return parseIngestCommand(argv.slice(1));
    case "query":
      return parseQueryCommand(argv.slice(1));
    case "install-assets":
      return parseInstallAssetsCommand(argv.slice(1));
    case "doctor":
      return parseDoctorCommand(argv.slice(1));
    case "serve":
      return parseServeCommand(argv.slice(1));
    case "help":
      return parseHelpCommand(argv.slice(1));
    default:
      return usageError(`알 수 없는 명령입니다: ${first}`);
  }
}

/** The full usage text, or one command's, when `topic` names a known command. */
export function usageText(topic?: string): string {
  const selected =
    topic === undefined
      ? undefined
      : COMMAND_USAGES.filter(
          (usage) => usage.topic === topic || usage.topic.startsWith(`${topic} `),
        );

  if (selected !== undefined && selected.length > 0) {
    return ["사용법:", ...selected.flatMap(renderUsage)].join("\n");
  }

  // The order of operations comes before the command list, because the list
  // answers "what exists" and a first run needs "what now". Someone who has
  // just installed the binary has no model, no source and no approved Card, and
  // every command except the first two will tell them so one at a time.
  return [
    "contextctl — 승인된 컨텍스트 카드를 골라 전달하는 데몬.",
    "",
    "처음이라면 이 순서로 실행하십시오:",
    "  1. contextctl install-assets    임베딩 모델 설치 (약 415MB)",
    "  2. contextctl doctor            설치 상태 점검",
    "  3. contextctl source add <path> 문서 등록",
    "  4. contextctl ingest            카드 후보 생성",
    "  5. contextctl cards approve <id> 카드 승인",
    "  6. contextctl query \"<질문>\"     질의",
    "",
    "사용법:",
    ...COMMAND_USAGES.flatMap(renderUsage),
  ].join("\n");
}

function renderUsage(usage: CommandUsage): readonly string[] {
  return [`  ${usage.line}`, `      ${usage.summary}`];
}

function parseSourceCommand(rest: readonly string[]): ParsedArguments {
  const subcommand = rest[0];
  switch (subcommand) {
    case undefined:
      return usageError("source 에는 하위 명령이 필요합니다: add, list, remove", "source");
    case "add": {
      const outcome = tokenize(rest.slice(1), {
        name: { type: "string" },
        "display-name": { type: "string" },
      }, "source add");
      if (outcome.status === "usage_error") {
        return outcome;
      }
      const path = outcome.positionals[0];
      if (path === undefined) {
        return usageError("등록할 경로가 필요합니다.", "source add");
      }
      if (outcome.positionals.length > 1) {
        return usageError("source add 는 경로 하나만 받습니다.", "source add");
      }
      const reference = stringOf(outcome.values["name"]);
      const displayName = stringOf(outcome.values["display-name"]);
      return ok({
        kind: "source_add",
        path,
        ...(reference === undefined ? {} : { reference }),
        ...(displayName === undefined ? {} : { displayName }),
      });
    }
    case "list": {
      const outcome = tokenize(rest.slice(1), {}, "source list");
      if (outcome.status === "usage_error") {
        return outcome;
      }
      if (outcome.positionals.length > 0) {
        return usageError("source list 는 인자를 받지 않습니다.", "source list");
      }
      return ok({ kind: "source_list" });
    }
    case "remove": {
      const outcome = tokenize(rest.slice(1), {}, "source remove");
      if (outcome.status === "usage_error") {
        return outcome;
      }
      const reference = outcome.positionals[0];
      if (reference === undefined) {
        return usageError("지울 소스 참조가 필요합니다.", "source remove");
      }
      if (outcome.positionals.length > 1) {
        return usageError("source remove 는 참조 하나만 받습니다.", "source remove");
      }
      return ok({ kind: "source_remove", reference });
    }
    default:
      return usageError(`알 수 없는 하위 명령입니다: source ${subcommand}`, "source");
  }
}

function parseCardsCommand(rest: readonly string[]): ParsedArguments {
  const subcommand = rest[0];
  switch (subcommand) {
    case undefined:
      return usageError("cards 에는 하위 명령이 필요합니다: list, approve", "cards");
    case "list": {
      const outcome = tokenize(rest.slice(1), { json: { type: "boolean" } }, "cards list");
      if (outcome.status === "usage_error") {
        return outcome;
      }
      if (outcome.positionals.length > 0) {
        return usageError("cards list 는 인자를 받지 않습니다.", "cards list");
      }
      return ok({ kind: "cards_list", json: outcome.values["json"] === true });
    }
    case "approve": {
      const outcome = tokenize(rest.slice(1), {
        by: { type: "string" },
        note: { type: "string" },
      }, "cards approve");
      if (outcome.status === "usage_error") {
        return outcome;
      }
      const cardId = outcome.positionals[0];
      if (cardId === undefined) {
        return usageError("승인할 카드 식별자가 필요합니다.", "cards approve");
      }
      if (outcome.positionals.length > 2) {
        return usageError(
          "cards approve 는 카드 식별자와 버전 식별자만 받습니다.",
          "cards approve",
        );
      }
      const versionId = outcome.positionals[1];
      const by = stringOf(outcome.values["by"]);
      const note = stringOf(outcome.values["note"]);
      return ok({
        kind: "cards_approve",
        cardId,
        ...(versionId === undefined ? {} : { versionId }),
        ...(by === undefined ? {} : { by }),
        ...(note === undefined ? {} : { note }),
      });
    }
    default:
      return usageError(`알 수 없는 하위 명령입니다: cards ${subcommand}`, "cards");
  }
}

/**
 * Consent is a flag rather than a prompt decision made here.
 *
 * `--yes` states that the operator already agreed; whether a prompt is possible
 * at all depends on the terminal, and that is the caller's fact to know. Parsing
 * only records what was typed.
 */
function parseInstallAssetsCommand(rest: readonly string[]): ParsedArguments {
  const outcome = tokenize(
    rest,
    {
      yes: { type: "boolean" },
      target: { type: "string" },
      "source-directory": { type: "string" },
    },
    "install-assets",
  );
  if (outcome.status === "usage_error") {
    return outcome;
  }
  if (outcome.positionals.length > 0) {
    return usageError(
      "install-assets 는 피연산자를 받지 않습니다.",
      "install-assets",
    );
  }
  const target = outcome.values["target"];
  const sourceDirectory = outcome.values["source-directory"];
  if (target !== undefined && typeof target !== "string") {
    return usageError("--target 은 디렉터리 경로가 필요합니다.", "install-assets");
  }
  if (sourceDirectory !== undefined && typeof sourceDirectory !== "string") {
    return usageError(
      "--source-directory 는 디렉터리 경로가 필요합니다.",
      "install-assets",
    );
  }
  return ok({
    kind: "install_assets",
    yes: outcome.values["yes"] === true,
    ...(target === undefined ? {} : { target }),
    ...(sourceDirectory === undefined ? {} : { sourceDirectory }),
  });
}

/**
 * `--deep` is off by default because a diagnosis nobody runs diagnoses nothing.
 *
 * The shallow pass answers "is the model installed" from the pointer and the
 * file sizes; the deep pass re-hashes 390MB. Making the slow one the default
 * would turn a first-run check into something an operator waits out once and
 * then stops using.
 */
function parseDoctorCommand(rest: readonly string[]): ParsedArguments {
  const outcome = tokenize(rest, { deep: { type: "boolean" } }, "doctor");
  if (outcome.status === "usage_error") {
    return outcome;
  }
  if (outcome.positionals.length > 0) {
    return usageError("doctor 는 피연산자를 받지 않습니다.", "doctor");
  }
  return ok({ kind: "doctor", deep: outcome.values["deep"] === true });
}

function parseIngestCommand(rest: readonly string[]): ParsedArguments {
  const outcome = tokenize(rest, {}, "ingest");
  if (outcome.status === "usage_error") {
    return outcome;
  }
  if (outcome.positionals.length > 1) {
    return usageError("ingest 는 소스 참조 하나만 받습니다.", "ingest");
  }
  const reference = outcome.positionals[0];
  return ok({
    kind: "ingest",
    ...(reference === undefined ? {} : { reference }),
  });
}

function parseQueryCommand(rest: readonly string[]): ParsedArguments {
  const outcome = tokenize(rest, {
    json: { type: "boolean" },
    "max-context": { type: "string" },
  }, "query");
  if (outcome.status === "usage_error") {
    return outcome;
  }

  const text = outcome.positionals[0];
  if (text === undefined) {
    return usageError("질문이 필요합니다.", "query");
  }
  // More than one operand almost always means an unquoted question, and the
  // shell has already split it. Joining the pieces would answer a question the
  // operator did not ask; saying so lets them add the quotes.
  if (outcome.positionals.length > 1) {
    return usageError(
      "질문은 하나만 받습니다. 여러 낱말이면 따옴표로 묶으세요.",
      "query",
    );
  }

  const rawMaxContext = stringOf(outcome.values["max-context"]);
  let maxContextCharacters: number | undefined;
  if (rawMaxContext !== undefined) {
    // Digits only, then range. `Number` alone would accept `0x400`, `1e3` and
    // ` 12 `, none of which an operator meant to type as a character budget.
    const trimmed = rawMaxContext.trim();
    const parsed = /^[0-9]+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      return usageError(
        `--max-context 는 1 이상의 정수여야 합니다: ${rawMaxContext}`,
        "query",
      );
    }
    maxContextCharacters = parsed;
  }

  return ok({
    kind: "query",
    text,
    json: outcome.values["json"] === true,
    ...(maxContextCharacters === undefined ? {} : { maxContextCharacters }),
  });
}

function parseServeCommand(rest: readonly string[]): ParsedArguments {
  const outcome = tokenize(rest, {}, "serve");
  if (outcome.status === "usage_error") {
    return outcome;
  }
  if (outcome.positionals.length > 0) {
    return usageError("serve 는 인자를 받지 않습니다.", "serve");
  }
  return ok({ kind: "serve" });
}

function parseHelpCommand(rest: readonly string[]): ParsedArguments {
  const outcome = tokenize(rest, {}, "help");
  if (outcome.status === "usage_error") {
    return outcome;
  }
  if (outcome.positionals.length === 0) {
    return ok({ kind: "help" });
  }
  const topic = resolveTopic(outcome.positionals);
  return topic === undefined
    ? usageError(`알 수 없는 명령입니다: ${outcome.positionals.join(" ")}`)
    : ok({ kind: "help", topic });
}

/**
 * Matches operands against the command table, longest first.
 *
 * Longest first so that `help source add` names the one command rather than the
 * `source` group, while `help source` still resolves — the two are different
 * requests and both are reasonable to type.
 */
function resolveTopic(tokens: readonly string[]): string | undefined {
  const twoWord = tokens.slice(0, 2).join(" ");
  if (COMMAND_USAGES.some((usage) => usage.topic === twoWord)) {
    return twoWord;
  }
  const oneWord = tokens[0];
  if (oneWord === undefined) {
    return undefined;
  }
  return COMMAND_USAGES.some(
    (usage) => usage.topic === oneWord || usage.topic.startsWith(`${oneWord} `),
  )
    ? oneWord
    : undefined;
}

interface TokenizeSuccess {
  readonly status: "ok";
  readonly values: Readonly<
    Record<string, string | boolean | readonly (string | boolean)[] | undefined>
  >;
  readonly positionals: readonly string[];
}

/**
 * Runs `parseArgs` and converts its exceptions into usage errors.
 *
 * `strict: true` is what makes an unknown flag an error rather than a silently
 * ignored token, which matters here: `contextctl query "…" --max-contex 4000`
 * must not quietly answer with the default budget. But strict mode signals by
 * throwing, and an exception escaping the parser would reach the entry point as
 * a stack trace. So every throw is caught here and becomes the same kind of
 * value every other rejection in this module produces.
 */
function tokenize(
  args: readonly string[],
  options: ParseArgsOptionsConfig,
  topic: string,
): TokenizeSuccess | UsageError {
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      options,
      allowPositionals: true,
      strict: true,
    });
    return { status: "ok", values, positionals };
  } catch (cause) {
    return usageError(describeParseFailure(cause), topic);
  }
}

function describeParseFailure(cause: unknown): string {
  const detail =
    cause instanceof Error ? cause.message.split("\n")[0] : String(cause);
  switch (codeOf(cause)) {
    case "ERR_PARSE_ARGS_UNKNOWN_OPTION":
      return `알 수 없는 옵션입니다. (${detail})`;
    case "ERR_PARSE_ARGS_INVALID_OPTION_VALUE":
      return `옵션 값이 잘못되었습니다. (${detail})`;
    case "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL":
      return `인자가 너무 많습니다. (${detail})`;
    default:
      return `명령을 해석하지 못했습니다. (${detail})`;
  }
}

function codeOf(cause: unknown): string | undefined {
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    const code = (cause as { readonly code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/** Narrows `parseArgs`'s union down to the one shape a string option yields. */
function stringOf(
  value: string | boolean | readonly (string | boolean)[] | undefined,
): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function ok(command: CliCommand): ParsedArguments {
  return { status: "ok", command };
}

/** Every rejection carries the usage, because it is what the reader needs next. */
function usageError(reason: string, topic?: string): UsageError {
  return { status: "usage_error", message: `${reason}\n\n${usageText(topic)}` };
}
