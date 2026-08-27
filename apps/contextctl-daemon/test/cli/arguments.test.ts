import { describe, expect, it } from "vitest";

import {
  parseCliArguments,
  usageText,
  type CliCommand,
} from "../../src/cli/arguments.js";

/**
 * What each argument vector means, asserted as a value.
 *
 * The parser is pure by design, so these tests never spawn a process and never
 * capture stdout. That is the property being protected as much as it is the
 * technique: the moment parsing prints or exits, the only way to test a
 * rejection is to run the binary, and rejections are most of the surface.
 *
 * Optional fields are checked with `in` rather than with `toEqual`, because
 * `toEqual` treats an absent key and a key set to `undefined` as the same
 * thing, and under `exactOptionalPropertyTypes` they are not. A command
 * carrying `reference: undefined` would satisfy `toEqual` and fail to compile
 * at the call site that consumes it.
 */

/** The command, or a failure that names what the parser said instead. */
function commandOf(argv: readonly string[]): CliCommand {
  const parsed = parseCliArguments(argv);
  if (parsed.status !== "ok") {
    throw new Error(`expected a command, got usage error: ${parsed.message}`);
  }
  return parsed.command;
}

function statusOf(argv: readonly string[]): string {
  return parseCliArguments(argv).status;
}

describe("parseCliArguments", () => {
  it("treats no arguments as a request for help", () => {
    expect(commandOf([])).toEqual({ kind: "help" });
  });

  it("recognises --version on its own", () => {
    expect(commandOf(["--version"])).toEqual({ kind: "version" });
  });

  it("rejects an unknown command", () => {
    const parsed = parseCliArguments(["bogus"]);

    expect(parsed.status).toBe("usage_error");
    if (parsed.status === "usage_error") {
      expect(parsed.message).toContain("알 수 없는 명령입니다: bogus");
      expect(parsed.message).toContain("사용법: contextctl <command> [options]");
      expect(parsed.message).toContain("자세한 도움말: contextctl help");
      expect(parsed.message).not.toContain("처음이라면 이 순서로");
    }
  });
});

describe("audit", () => {
  it("parses bounded local audit listing and detail lookup", () => {
    expect(commandOf(["audit", "list"])).toEqual({
      kind: "audit_list",
      limit: 20,
      json: false,
    });
    expect(commandOf(["audit", "list", "--limit", "7", "--json"])).toEqual({
      kind: "audit_list",
      limit: 7,
      json: true,
    });
    expect(
      commandOf([
        "audit",
        "show",
        "sa_00000000000000000000000000000001",
        "--json",
      ]),
    ).toEqual({
      kind: "audit_show",
      auditId: "sa_00000000000000000000000000000001",
      json: true,
    });
  });

  it("rejects unbounded limits and malformed identifiers", () => {
    expect(statusOf(["audit", "list", "--limit", "0"])).toBe("usage_error");
    expect(statusOf(["audit", "list", "--limit", "101"])).toBe("usage_error");
    expect(statusOf(["audit", "show", "query-text"])).toBe("usage_error");
  });
});

describe("source add", () => {
  it("takes the path alone", () => {
    const command = commandOf(["source", "add", "/tmp/a.md"]);

    expect(command).toEqual({ kind: "source_add", path: "/tmp/a.md" });
    expect("reference" in command).toBe(false);
    expect("displayName" in command).toBe(false);
  });

  it("takes the reference and display name when given", () => {
    expect(
      commandOf([
        "source",
        "add",
        "/tmp/a.md",
        "--name",
        "source.x",
        "--display-name",
        "X",
      ]),
    ).toEqual({
      kind: "source_add",
      path: "/tmp/a.md",
      reference: "source.x",
      displayName: "X",
    });
  });

  it("rejects a missing path", () => {
    expect(statusOf(["source", "add"])).toBe("usage_error");
  });

  it("rejects an unknown subcommand", () => {
    expect(statusOf(["source", "bogus"])).toBe("usage_error");
  });
});

describe("source list and remove", () => {
  it("takes source list with no arguments", () => {
    expect(commandOf(["source", "list"])).toEqual({ kind: "source_list" });
  });

  it("takes the reference to remove", () => {
    expect(commandOf(["source", "remove", "source.x"])).toEqual({
      kind: "source_remove",
      reference: "source.x",
    });
  });

  it("rejects source remove with no reference", () => {
    expect(statusOf(["source", "remove"])).toBe("usage_error");
  });
});

describe("demo init", () => {
  it("uses a stable default directory", () => {
    expect(commandOf(["demo", "init"])).toEqual({
      kind: "demo_init",
      destination: "contextctl-demo",
    });
  });

  it("takes one explicit destination", () => {
    expect(commandOf(["demo", "init", "./demo-for-video"])).toEqual({
      kind: "demo_init",
      destination: "./demo-for-video",
    });
  });

  it("rejects ambiguous or unknown operations", () => {
    expect(statusOf(["demo"])).toBe("usage_error");
    expect(statusOf(["demo", "init", "one", "two"])).toBe("usage_error");
    expect(statusOf(["demo", "replace"])).toBe("usage_error");
  });
});

describe("ingest", () => {
  it("omits the reference when none was given", () => {
    const command = commandOf(["ingest"]);

    expect(command).toEqual({ kind: "ingest" });
    expect("reference" in command).toBe(false);
  });

  it("carries the reference when one was given", () => {
    expect(commandOf(["ingest", "source.x"])).toEqual({
      kind: "ingest",
      reference: "source.x",
    });
  });
});

describe("cards", () => {
  it("carries --json on cards list", () => {
    expect(commandOf(["cards", "list", "--json"])).toEqual({
      kind: "cards_list",
      json: true,
      filter: "all",
      compact: true,
    });
  });

  it("defaults cards list to human output", () => {
    expect(commandOf(["cards", "list"])).toEqual({
      kind: "cards_list",
      json: false,
      filter: "pending",
      compact: true,
    });
  });

  it("filters and expands a Card listing only when explicitly requested", () => {
    expect(
      commandOf([
        "cards",
        "list",
        "--approved",
        "--source",
        "source.handbook",
        "--verbose",
      ]),
    ).toEqual({
      kind: "cards_list",
      json: false,
      filter: "approved",
      compact: false,
      source: "source.handbook",
    });
  });

  it("rejects ambiguous listing modes", () => {
    expect(statusOf(["cards", "list", "--pending", "--all"])).toBe(
      "usage_error",
    );
    expect(statusOf(["cards", "list", "--compact", "--verbose"])).toBe(
      "usage_error",
    );
  });

  it("shows one Card or one exact version", () => {
    expect(commandOf(["cards", "show", "card_1"])).toEqual({
      kind: "cards_show",
      cardId: "card_1",
      json: false,
    });
    expect(commandOf(["cards", "show", "card_1", "cv_2", "--json"])).toEqual({
      kind: "cards_show",
      cardId: "card_1",
      versionId: "cv_2",
      json: true,
    });
  });

  it("approves without a version", () => {
    const command = commandOf(["cards", "approve", "card_1"]);

    expect(command).toEqual({
      kind: "cards_decision",
      decision: "approve",
      cardId: "card_1",
    });
    expect("versionId" in command).toBe(false);
    expect("by" in command).toBe(false);
  });

  it("approves a named version with an approver", () => {
    expect(
      commandOf(["cards", "approve", "card_1", "ver_1", "--by", "kim"]),
    ).toEqual({
      kind: "cards_decision",
      decision: "approve",
      cardId: "card_1",
      versionId: "ver_1",
      by: "kim",
    });
  });

  it("rejects cards approve with no card", () => {
    expect(statusOf(["cards", "approve"])).toBe("usage_error");
  });

  it.each(["reject", "rollback"] as const)(
    "parses %s with the version it names",
    (decision) => {
      expect(
        commandOf(["cards", decision, "card_1", "ver_1", "--by", "kim", "--note", "n"]),
      ).toEqual({
        kind: "cards_decision",
        decision,
        cardId: "card_1",
        versionId: "ver_1",
        by: "kim",
        note: "n",
      });
    },
  );

  it.each(["reject", "rollback"] as const)(
    "refuses %s without a version",
    (decision) => {
      // Neither statement can be made about "whatever is latest": both are about
      // one specific version, and guessing would record an audit entry naming a
      // version the operator never chose.
      expect(statusOf(["cards", decision, "card_1"])).toBe("usage_error");
    },
  );

  it("parses disable with no version at all", () => {
    // `disable` moves the current pointer off whatever is serving, so a version
    // would have nothing to bind to.
    expect(commandOf(["cards", "disable", "card_1", "--by", "kim"])).toEqual({
      kind: "cards_decision",
      decision: "disable",
      cardId: "card_1",
      by: "kim",
    });
  });

  it("refuses a version handed to disable", () => {
    expect(statusOf(["cards", "disable", "card_1", "ver_1"])).toBe("usage_error");
  });
});

describe("reachability", () => {
  it("parses the report with no narrowing", () => {
    const command = commandOf(["reachability"]);

    expect(command).toEqual({ kind: "reachability" });
    expect("state" in command).toBe(false);
  });

  it("parses a narrowed report", () => {
    expect(commandOf(["reachability", "--state", "orphaned"])).toEqual({
      kind: "reachability",
      state: "orphaned",
    });
  });

  it("takes no positional argument", () => {
    expect(statusOf(["reachability", "orphaned"])).toBe("usage_error");
  });
});

describe("status", () => {
  it("parses the report a person reads", () => {
    expect(commandOf(["status"])).toEqual({ kind: "status", json: false });
  });

  it("parses the report a monitor reads", () => {
    expect(commandOf(["status", "--json"])).toEqual({ kind: "status", json: true });
  });

  it("takes no positional argument", () => {
    // No `status resolve`. A status surface exists to show what an operator did
    // not think to ask about, so narrowing it to one lane would hide the
    // `not_ready` somewhere else.
    expect(statusOf(["status", "resolve"])).toBe("usage_error");
  });
});

describe("backup", () => {
  it("parses a new backup destination", () => {
    expect(commandOf(["backup", "create", "./backup-2026-08-24"])).toEqual({
      kind: "backup_create",
      destination: "./backup-2026-08-24",
    });
  });

  it("requires an explicit new home for restore", () => {
    expect(
      commandOf([
        "backup",
        "restore",
        "./backup-2026-08-24",
        "--target-home",
        "./restored-home",
      ]),
    ).toEqual({
      kind: "backup_restore",
      source: "./backup-2026-08-24",
      targetHome: "./restored-home",
    });
    expect(statusOf(["backup", "restore", "./backup-2026-08-24"]))
      .toBe("usage_error");
  });

  it("rejects missing and unknown backup operations", () => {
    expect(statusOf(["backup"])).toBe("usage_error");
    expect(statusOf(["backup", "replace", "./backup"])).toBe("usage_error");
  });
});

describe("query", () => {
  it("rejects a query with no question", () => {
    expect(statusOf(["query"])).toBe("usage_error");
  });

  it("takes a character budget", () => {
    expect(commandOf(["query", "질문", "--max-context", "4000"])).toEqual({
      kind: "query",
      text: "질문",
      json: false,
      maxContextCharacters: 4000,
    });
  });

  it.each(["0", "-1", "abc", "1.5"])(
    "rejects --max-context %s",
    (value) => {
      expect(statusOf(["query", "질문", "--max-context", value])).toBe(
        "usage_error",
      );
    },
  );

  it("omits the budget when none was given", () => {
    const command = commandOf(["query", "질문"]);

    expect("maxContextCharacters" in command).toBe(false);
  });

  it("rejects a second operand rather than joining it", () => {
    expect(statusOf(["query", "a", "b"])).toBe("usage_error");
  });

  it("turns an unknown option into a usage error instead of throwing", () => {
    // parseArgs throws in strict mode; the whole point is that the throw is
    // caught here rather than reaching the entry point as a stack trace.
    expect(() => parseCliArguments(["query", "질문", "--nope"])).not.toThrow();
    expect(statusOf(["query", "질문", "--nope"])).toBe("usage_error");
  });
});

describe("serve", () => {
  it("takes no options", () => {
    expect(commandOf(["serve"])).toEqual({ kind: "serve" });
  });

  it("rejects --json, which belongs to other commands", () => {
    expect(statusOf(["serve", "--json"])).toBe("usage_error");
  });
});

describe("help", () => {
  it("has no topic when none was named", () => {
    const command = commandOf(["help"]);

    expect(command).toEqual({ kind: "help" });
    expect("topic" in command).toBe(false);
  });

  it("carries the named topic", () => {
    expect(commandOf(["help", "query"])).toEqual({
      kind: "help",
      topic: "query",
    });
  });

  it("reads --help on a command as help for that command", () => {
    expect(commandOf(["query", "--help"])).toEqual({
      kind: "help",
      topic: "query",
    });
  });

  it("reads -h the same way", () => {
    expect(commandOf(["cards", "approve", "-h"])).toEqual({
      kind: "help",
      topic: "cards approve",
    });
  });
});

describe("usageText", () => {
  const COMMAND_LINES = [
    "contextctl demo init [<directory>]",
    "contextctl source add <path> [--name <ref>] [--display-name <text>]",
    "contextctl source list",
    "contextctl source remove <ref>",
    "contextctl backup create <directory>",
    "contextctl backup restore <directory> --target-home <new-directory>",
    "contextctl ingest [<ref>]",
    "contextctl cards list [--pending|--approved|--all] [--source <ref>] [--compact|--verbose] [--json]",
    "contextctl cards show <cardId> [<versionId>] [--json]",
    "contextctl cards approve <cardId> [<versionId>] [--by <who>] [--note <text>]",
    'contextctl query "<질문>" [--json] [--max-context <n>]',
    "contextctl serve",
    "contextctl help [<command>]",
    "contextctl --version",
  ];

  it.each(COMMAND_LINES)("documents %s", (line) => {
    expect(usageText()).toContain(line);
  });

  it("narrows to one command when a topic is named", () => {
    const text = usageText("query");

    expect(text).toContain('contextctl query "<질문>" [--json] [--max-context <n>]');
    expect(text).not.toContain("contextctl serve");
  });

  it("states the pinned model size in binary and decimal units", () => {
    expect(usageText("install-assets")).toContain("396.1 MiB(약 415 MB)");
    expect(usageText()).toContain("396.1 MiB, 약 415 MB");
  });

  it("puts the usage into every rejection message", () => {
    const parsed = parseCliArguments(["query"]);

    expect(parsed.status).toBe("usage_error");
    expect(parsed.status === "usage_error" ? parsed.message : "").toContain(
      "contextctl query",
    );
    expect(parsed.status === "usage_error" ? parsed.message : "").toContain(
      "자세한 도움말: contextctl help query",
    );
  });
});

describe("paths", () => {
  it("takes no options and no operands", () => {
    expect(parseCliArguments(["paths"])).toEqual({
      status: "ok",
      command: { kind: "paths" },
    });
    expect(parseCliArguments(["paths", "extra"]).status).toBe("usage_error");
    expect(parseCliArguments(["paths", "--json"]).status).toBe("usage_error");
  });

  it("is listed in the usage text", () => {
    // The command exists so an operator can find what to remove. A command that
    // is not in the help is one they will not find when they need it.
    expect(usageText()).toContain("contextctl paths");
  });
});
