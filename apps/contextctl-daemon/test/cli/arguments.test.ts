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
    expect(statusOf(["bogus"])).toBe("usage_error");
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
    });
  });

  it("defaults cards list to human output", () => {
    expect(commandOf(["cards", "list"])).toEqual({
      kind: "cards_list",
      json: false,
    });
  });

  it("approves without a version", () => {
    const command = commandOf(["cards", "approve", "card_1"]);

    expect(command).toEqual({ kind: "cards_approve", cardId: "card_1" });
    expect("versionId" in command).toBe(false);
    expect("by" in command).toBe(false);
  });

  it("approves a named version with an approver", () => {
    expect(
      commandOf(["cards", "approve", "card_1", "ver_1", "--by", "kim"]),
    ).toEqual({
      kind: "cards_approve",
      cardId: "card_1",
      versionId: "ver_1",
      by: "kim",
    });
  });

  it("rejects cards approve with no card", () => {
    expect(statusOf(["cards", "approve"])).toBe("usage_error");
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
    "contextctl source add <path> [--name <ref>] [--display-name <text>]",
    "contextctl source list",
    "contextctl source remove <ref>",
    "contextctl ingest [<ref>]",
    "contextctl cards list [--json]",
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

  it("puts the usage into every rejection message", () => {
    const parsed = parseCliArguments(["query"]);

    expect(parsed.status).toBe("usage_error");
    expect(parsed.status === "usage_error" ? parsed.message : "").toContain(
      "contextctl query",
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
