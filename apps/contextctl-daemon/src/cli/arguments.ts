import { parseArgs, type ParseArgsOptionsConfig } from "node:util";

import {
  DEFAULT_GRANITE_ASSET_SIZE_COMPACT,
  DEFAULT_GRANITE_ASSET_SIZE_INLINE,
} from "../embedding-guidance.js";

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
  | { readonly kind: "demo_init"; readonly destination: string }
  | { readonly kind: "ingest"; readonly reference?: string }
  | {
      readonly kind: "cards_list";
      readonly json: boolean;
      readonly filter: "pending" | "approved" | "all";
      readonly compact: boolean;
      readonly source?: string;
    }
  | {
      readonly kind: "cards_show";
      readonly cardId: string;
      readonly versionId?: string;
      readonly json: boolean;
    }
  /**
   * The four decisions share one shape, because Registry's surface does.
   *
   * `runOperatorCommand` takes the same `<card-id> <version-id> --by` for
   * approve, reject and rollback, and `disable` differs only in having no
   * version. Splitting them into four command types here would mean four almost
   * identical parsers and four almost identical call sites, and the one thing
   * that genuinely differs — which word Registry is given — is already the
   * discriminant.
   */
  | {
      readonly kind: "cards_decision";
      readonly decision: "approve" | "reject" | "disable" | "rollback";
      readonly cardId: string;
      readonly versionId?: string;
      readonly by?: string;
      readonly note?: string;
    }
  | { readonly kind: "reachability"; readonly state?: string }
  /**
   * Per-lane readiness. Separate from `doctor` because it answers a different
   * question — see `status.ts` — and `--json` exists because the intended second
   * consumer is a monitor rather than a person.
   */
  | { readonly kind: "status"; readonly json: boolean }
  | { readonly kind: "backup_create"; readonly destination: string }
  | {
      readonly kind: "backup_restore";
      readonly source: string;
      readonly targetHome: string;
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
  | { readonly kind: "paths" }
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
      `질의에 필요한 임베딩 모델을 내려받아 설치한다. ${DEFAULT_GRANITE_ASSET_SIZE_COMPACT}를 받으므로 먼저 동의를 묻는다.`,
  },
  {
    topic: "paths",
    line: "contextctl paths",
    summary:
      "상태·모델·색인이 놓인 경로를 전부 보여준다. 백업하거나 지울 때 무엇을 지워야 하는지 알려준다.",
  },
  {
    topic: "doctor",
    line: "contextctl doctor [--deep]",
    summary:
      "설치 상태를 점검하고 다음에 할 일을 알려준다. --deep 은 모델 파일 전체를 다시 검증한다(느리다).",
  },
  {
    topic: "demo init",
    line: "contextctl demo init [<directory>]",
    summary:
      "설치된 패키지의 데모 문서를 새 디렉터리에 복사한다. 기본 디렉터리는 ./contextctl-demo 이다.",
  },
  {
    topic: "source add",
    line: "contextctl source add <path> [--name <ref>] [--display-name <text>]",
    summary: "Markdown 문서 파일 하나를 소스로 등록한다. --name 을 생략하면 파일 경로에서 참조를 만든다.",
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
    line:
      "contextctl cards list [--pending|--approved|--all] [--source <ref>] [--compact|--verbose] [--json]",
    summary:
      "카드를 탐색한다. 기본값은 승인 대기 카드의 간략 목록이고, --verbose 로 전체 근거를 본다.",
  },
  {
    topic: "cards show",
    line: "contextctl cards show <cardId> [<versionId>] [--json]",
    summary: "한 카드의 설명·키워드·버전·검토 근거를 빠짐없이 보여준다.",
  },
  {
    topic: "cards approve",
    line: "contextctl cards approve <cardId> [<versionId>] [--by <who>] [--note <text>]",
    summary: "카드 버전을 승인한다. 버전을 생략하면 최신 버전을 승인한다.",
  },
  {
    topic: "cards reject",
    line: "contextctl cards reject <cardId> <versionId> [--by <who>] [--note <text>]",
    summary: "카드 버전을 거부한다. 버전은 지우지 않고 거부 사실을 이력에 남긴다.",
  },
  {
    topic: "cards disable",
    line: "contextctl cards disable <cardId> [--by <who>] [--note <text>]",
    summary: "서비스 중인 카드를 내린다. 이력은 남으므로 다시 승인하면 복구된다.",
  },
  {
    topic: "cards rollback",
    line: "contextctl cards rollback <cardId> <versionId> [--by <who>] [--note <text>]",
    summary: "이전 버전으로 되돌린다. 현재보다 뒤가 아닌 버전은 거부한다.",
  },
  {
    topic: "reachability",
    line: "contextctl reachability [--state <state>]",
    summary:
      "인덱싱됐지만 승인 카드로 도달할 수 없는 범위를 보고한다. 릴리스 기준을 넘기지 못하면 0이 아닌 코드로 끝난다.",
  },
  {
    topic: "status",
    line: "contextctl status [--json]",
    summary:
      "실행 영역별로 지금 일을 할 수 있는지 보여준다(resolve, registry, selection_assets, ingestion). 못 하는 영역이 있으면 0이 아닌 코드로 끝난다.",
  },
  {
    topic: "backup create",
    line: "contextctl backup create <directory>",
    summary: "Registry·Ingestion SQLite와 참조 중인 Qdrant 컬렉션을 한 복구 묶음으로 저장한다.",
  },
  {
    topic: "backup restore",
    line: "contextctl backup restore <directory> --target-home <new-directory>",
    summary: "백업을 기존 상태와 겹치지 않는 새 상태 디렉터리와 빈 Qdrant에 복원한다.",
  },
  {
    topic: "query",
    line: 'contextctl query "<질문>" [--json] [--max-context <n>]',
    summary:
      "질문과 관련된 Card와 검색 컨텍스트를 선택해 반환한다. --max-context 는 문자 수 상한이다.",
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
    case "demo":
      return parseDemoCommand(argv.slice(1));
    case "cards":
      return parseCardsCommand(argv.slice(1));
    case "backup":
      return parseBackupCommand(argv.slice(1));
    case "ingest":
      return parseIngestCommand(argv.slice(1));
    case "query":
      return parseQueryCommand(argv.slice(1));
    case "install-assets":
      return parseInstallAssetsCommand(argv.slice(1));
    case "doctor":
      return parseDoctorCommand(argv.slice(1));
    case "paths":
      return parsePathsCommand(argv.slice(1));
    case "reachability":
      return parseReachabilityCommand(argv.slice(1));
    case "status":
      return parseStatusCommand(argv.slice(1));
    case "serve":
      return parseServeCommand(argv.slice(1));
    case "help":
      return parseHelpCommand(argv.slice(1));
    default:
      return usageError(`알 수 없는 명령입니다: ${first}`);
  }
}

function parseBackupCommand(rest: readonly string[]): ParsedArguments {
  const subcommand = rest[0];
  if (subcommand === "create") {
    const outcome = tokenize(rest.slice(1), {}, "backup create");
    if (outcome.status === "usage_error") return outcome;
    const destination = outcome.positionals[0];
    if (destination === undefined) {
      return usageError("백업을 저장할 새 디렉터리가 필요합니다.", "backup create");
    }
    if (outcome.positionals.length !== 1) {
      return usageError("backup create 는 디렉터리 하나만 받습니다.", "backup create");
    }
    return ok({ kind: "backup_create", destination });
  }
  if (subcommand === "restore") {
    const outcome = tokenize(
      rest.slice(1),
      { "target-home": { type: "string" } },
      "backup restore",
    );
    if (outcome.status === "usage_error") return outcome;
    const source = outcome.positionals[0];
    if (source === undefined) {
      return usageError("복원할 백업 디렉터리가 필요합니다.", "backup restore");
    }
    if (outcome.positionals.length !== 1) {
      return usageError("backup restore 는 백업 디렉터리 하나만 받습니다.", "backup restore");
    }
    const targetHome = stringOf(outcome.values["target-home"]);
    if (targetHome === undefined) {
      return usageError(
        "--target-home 으로 비어 있는 새 상태 디렉터리를 지정해야 합니다.",
        "backup restore",
      );
    }
    return ok({ kind: "backup_restore", source, targetHome });
  }
  return usageError(
    subcommand === undefined
      ? "backup 에는 하위 명령이 필요합니다: create, restore"
      : `알 수 없는 하위 명령입니다: backup ${subcommand}`,
    "backup",
  );
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
    "contextctl — 외부 문서를 수집·색인하고 승인 Card로 검색 범위를 결정하는 데몬.",
    "",
    "처음이라면 이 순서로 실행하십시오:",
    `  1. contextctl install-assets    임베딩 모델 설치 (${DEFAULT_GRANITE_ASSET_SIZE_INLINE})`,
    "  2. contextctl doctor            설치 상태 점검",
    "  3. contextctl demo init         데모 문서 준비",
    "  4. contextctl source add <path> 문서 등록",
    "  5. contextctl ingest            카드 후보 생성",
    "  6. contextctl cards approve <id> 카드 승인",
    "  7. contextctl query \"<질문>\"     질의",
    "",
    "사용법:",
    ...COMMAND_USAGES.flatMap(renderUsage),
  ].join("\n");
}

function renderUsage(usage: CommandUsage): readonly string[] {
  return [`  ${usage.line}`, `      ${usage.summary}`];
}

function parseDemoCommand(rest: readonly string[]): ParsedArguments {
  const subcommand = rest[0];
  if (subcommand !== "init") {
    return usageError(
      subcommand === undefined
        ? "demo 에는 하위 명령이 필요합니다: init"
        : `알 수 없는 하위 명령입니다: demo ${subcommand}`,
      "demo",
    );
  }
  const outcome = tokenize(rest.slice(1), {}, "demo init");
  if (outcome.status === "usage_error") return outcome;
  if (outcome.positionals.length > 1) {
    return usageError("demo init 은 디렉터리를 하나만 받습니다.", "demo init");
  }
  return ok({
    kind: "demo_init",
    destination: outcome.positionals[0] ?? "contextctl-demo",
  });
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

/**
 * The three decisions that name a version, and the one that does not.
 *
 * `approve` may omit the version — the surface resolves the newest pending one —
 * but `reject` and `rollback` may not. Rejecting or rolling back "whatever is
 * latest" is not a decision an operator can mean: both statements are about one
 * specific version, and guessing which would record an audit entry naming a
 * version nobody chose. `disable` is the opposite case: it moves the current
 * pointer off whatever is serving, so a version would have nothing to bind to.
 */
function parseDecisionCommand(
  decision: "approve" | "reject" | "disable" | "rollback",
  rest: readonly string[],
): ParsedArguments {
  const topic = `cards ${decision}`;
  const outcome = tokenize(
    rest,
    { by: { type: "string" }, note: { type: "string" } },
    topic,
  );
  if (outcome.status === "usage_error") {
    return outcome;
  }

  const cardId = outcome.positionals[0];
  if (cardId === undefined) {
    return usageError("카드 식별자가 필요합니다.", topic);
  }

  const allowed = decision === "disable" ? 1 : 2;
  if (outcome.positionals.length > allowed) {
    return usageError(
      decision === "disable"
        ? "cards disable 은 카드 식별자만 받습니다."
        : `${topic} 은 카드 식별자와 버전 식별자만 받습니다.`,
      topic,
    );
  }

  const versionId = outcome.positionals[1];
  if (versionId === undefined && (decision === "reject" || decision === "rollback")) {
    return usageError(`${topic} 은 버전 식별자가 필요합니다.`, topic);
  }

  const by = stringOf(outcome.values["by"]);
  const note = stringOf(outcome.values["note"]);
  return ok({
    kind: "cards_decision",
    decision,
    cardId,
    ...(versionId === undefined ? {} : { versionId }),
    ...(by === undefined ? {} : { by }),
    ...(note === undefined ? {} : { note }),
  });
}

/**
 * The reachability report, optionally narrowed to one state.
 *
 * `--state` takes any string rather than a fixed list. The six state names are
 * Registry's vocabulary and it already refuses one it does not know; repeating
 * them here would be a second copy to keep in step, and the error an operator
 * gets from the domain names the states it accepts.
 */
function parseReachabilityCommand(rest: readonly string[]): ParsedArguments {
  const outcome = tokenize(rest, { state: { type: "string" } }, "reachability");
  if (outcome.status === "usage_error") {
    return outcome;
  }
  if (outcome.positionals.length > 0) {
    return usageError("reachability 는 인자를 받지 않습니다.", "reachability");
  }
  const state = stringOf(outcome.values["state"]);
  return ok({ kind: "reachability", ...(state === undefined ? {} : { state }) });
}

/**
 * Per-lane readiness, printed for a person or for a monitor.
 *
 * No `--lane` filter. A status surface exists to show what an operator did not
 * think to ask about, and a command that reported one lane at a time would let a
 * `not_ready` elsewhere go unseen — which is the failure the design's four-lane
 * shape is there to prevent.
 */
function parseStatusCommand(rest: readonly string[]): ParsedArguments {
  const outcome = tokenize(rest, { json: { type: "boolean" } }, "status");
  if (outcome.status === "usage_error") {
    return outcome;
  }
  if (outcome.positionals.length > 0) {
    return usageError("status 는 인자를 받지 않습니다.", "status");
  }
  return ok({ kind: "status", json: outcome.values["json"] === true });
}

function parseCardsCommand(rest: readonly string[]): ParsedArguments {
  const subcommand = rest[0];
  switch (subcommand) {
    case undefined:
      return usageError(
        "cards 에는 하위 명령이 필요합니다: list, show, approve, reject, disable, rollback",
        "cards",
      );
    case "list": {
      const outcome = tokenize(
        rest.slice(1),
        {
          json: { type: "boolean" },
          pending: { type: "boolean" },
          approved: { type: "boolean" },
          all: { type: "boolean" },
          compact: { type: "boolean" },
          verbose: { type: "boolean" },
          source: { type: "string" },
        },
        "cards list",
      );
      if (outcome.status === "usage_error") {
        return outcome;
      }
      if (outcome.positionals.length > 0) {
        return usageError("cards list 는 인자를 받지 않습니다.", "cards list");
      }
      const selectedFilters = (["pending", "approved", "all"] as const).filter(
        (name) => outcome.values[name] === true,
      );
      if (selectedFilters.length > 1) {
        return usageError(
          "--pending, --approved, --all 중 하나만 선택할 수 있습니다.",
          "cards list",
        );
      }
      if (
        outcome.values["compact"] === true &&
        outcome.values["verbose"] === true
      ) {
        return usageError(
          "--compact 와 --verbose 는 함께 쓸 수 없습니다.",
          "cards list",
        );
      }
      const source = stringOf(outcome.values["source"]);
      const json = outcome.values["json"] === true;
      return ok({
        kind: "cards_list",
        json,
        // Preserve the existing machine surface: people open on the review
        // queue, while an unqualified JSON request still returns every Card.
        filter: selectedFilters[0] ?? (json ? "all" : "pending"),
        compact: outcome.values["verbose"] !== true,
        ...(source === undefined ? {} : { source }),
      });
    }
    case "show": {
      const outcome = tokenize(rest.slice(1), { json: { type: "boolean" } }, "cards show");
      if (outcome.status === "usage_error") {
        return outcome;
      }
      const cardId = outcome.positionals[0];
      if (cardId === undefined) {
        return usageError("확인할 Card 식별자가 필요합니다.", "cards show");
      }
      if (outcome.positionals.length > 2) {
        return usageError(
          "cards show 는 Card와 선택적 버전 식별자만 받습니다.",
          "cards show",
        );
      }
      const versionId = outcome.positionals[1];
      return ok({
        kind: "cards_show",
        cardId,
        json: outcome.values["json"] === true,
        ...(versionId === undefined ? {} : { versionId }),
      });
    }
    case "approve":
    case "reject":
    case "disable":
    case "rollback":
      return parseDecisionCommand(subcommand, rest.slice(1));
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
/**
 * No options at all, and none planned.
 *
 * The command exists so an operator can find what to delete; a flag that
 * filtered the list would let them delete less than they meant to while
 * believing they had seen everything.
 */
function parsePathsCommand(rest: readonly string[]): ParsedArguments {
  const outcome = tokenize(rest, {}, "paths");
  if (outcome.status === "usage_error") {
    return outcome;
  }
  if (outcome.positionals.length > 0) {
    return usageError("paths 는 피연산자를 받지 않습니다.", "paths");
  }
  return ok({ kind: "paths" });
}

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

/**
 * A rejection names the immediate syntax and the help command, without
 * burying the actual error under the complete command reference.
 */
function usageError(reason: string, topic?: string): UsageError {
  const selected =
    topic === undefined
      ? []
      : COMMAND_USAGES.filter(
          (usage) =>
            usage.topic === topic || usage.topic.startsWith(`${topic} `),
        );
  const usage =
    selected.length === 0
      ? ["사용법: contextctl <command> [options]"]
      : ["사용법:", ...selected.map((entry) => `  ${entry.line}`)];
  const help = `자세한 도움말: contextctl help${topic === undefined ? "" : ` ${topic}`}`;
  return {
    status: "usage_error",
    message: [reason, "", ...usage, help].join("\n"),
  };
}
