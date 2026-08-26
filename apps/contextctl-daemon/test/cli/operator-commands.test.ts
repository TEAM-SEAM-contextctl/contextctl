import type { DatabaseSync } from "node:sqlite";

import {
  openIngestionDatabase,
  SqliteIndexPublicationStore,
  SqliteIngestionPublicationStore,
} from "@contextctl/ingestion-indexing";
import {
  appendCardVersion,
  createContextCard,
  openRegistryDatabase,
  SqliteCardStore,
  SqliteLifecycleEventStore,
  withCardVersions,
  type CardVersion,
  type ContextCard,
  type ManagedDocumentScope,
} from "@contextctl/registry-lifecycle";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_SECURITY_DOMAIN,
  DEFAULT_STATE_NAMESPACE_ID,
} from "../../src/main.js";
import { parseCliArguments } from "../../src/cli/arguments.js";
import {
  runCardsDecision,
  runCardsList,
  runCardsShow,
  runReachability,
} from "../../src/cli/commands.js";
import { EXIT_CODES } from "../../src/cli/exit-codes.js";
import {
  openRegistryOnlyRuntime,
  type RegistryOnlyRuntime,
} from "../../src/cli/runtime.js";

/**
 * The four operator decisions and the reachability report, reached the way the
 * CLI reaches them.
 *
 * Registry's operator surface has been complete since SEAM-49 and SEAM-63, and
 * every one of its commands except `approve` was unreachable from a terminal:
 * `runOperatorCommand` was called by tests and nothing else. So the subject here
 * is the wiring — argv through the parser, through the command, into Registry,
 * back out as an exit code — rather than the decisions themselves, which are
 * tested where they are decided.
 *
 * Nothing here is faked. These commands take Registry's database and nothing
 * else — that is the whole shape of `RegistryOnlyRuntime`, and the reason it
 * exists: routing them through the assembled runtime made them refuse to start
 * without the 415MB embedding artifact, which none of them calls. So the runtime
 * under test is the real one, and the assertions are the ones a fake store could
 * not support: that `disable` actually stops the Card serving, and that rolling
 * forward is refused rather than quietly done.
 */

const meaning = {
  description: "결제 실패 재시도 정책",
  representativeQuestions: ["결제가 실패하면 언제 재시도되나요?"],
  aliases: ["payment retry"],
  keywords: ["payment", "retry"],
};

const scope: ManagedDocumentScope = {
  kind: "managed_document",
  reference: { scopeId: "scope_payment_failures", scopeVersion: "scpv_aaaa" },
  documentIndex: {
    documentIndexId: "didx_payments",
    sourceId: "src_payments",
    documentId: "doc_payments",
    indexVersion: "idxv_aaaa",
  },
  selection: { kind: "document" },
};

function versionOf(cardId: string, versionId: string, createdAt: string): CardVersion {
  return {
    id: versionId,
    cardId,
    lineage: {
      publicationId: "pub_initial",
      observationId: "obs_initial",
      knowledgeUnitId: cardId,
    },
    scopes: [scope],
    validationState: "validated",
    createdAt,
  };
}

/** A Card with two validated versions, so `rollback` has somewhere to go. */
function cardWithTwoVersions(cardId: string): ContextCard {
  const card = createContextCard(cardId, meaning, {
    sensitive: false,
    allowedUsage: ["retrieval"],
  });
  const first = appendCardVersion(
    card.versions,
    versionOf(cardId, "cv_1", "2026-08-01T00:00:00.000Z"),
  );
  return withCardVersions(
    card,
    appendCardVersion(first, versionOf(cardId, "cv_2", "2026-08-02T00:00:00.000Z")),
  );
}

let database: DatabaseSync;
let ingestionDatabase: DatabaseSync;
let cards: SqliteCardStore;
let cli: RegistryOnlyRuntime;

beforeEach(async () => {
  database = openRegistryDatabase({ location: ":memory:", stateNamespaceId: "state_local", securityDomain: "local" });
  cards = new SqliteCardStore(database);
  await cards.saveCard(cardWithTwoVersions("card_payments"), []);
  ingestionDatabase = openIngestionDatabase({
    location: ":memory:",
    stateNamespaceId: DEFAULT_STATE_NAMESPACE_ID,
    securityDomain: DEFAULT_SECURITY_DOMAIN,
  });
  cli = {
    stateIdentity: {
      stateNamespaceId: DEFAULT_STATE_NAMESPACE_ID,
      securityDomain: DEFAULT_SECURITY_DOMAIN,
    },
    database,
    cards,
    lifecycleEvents: new SqliteLifecycleEventStore(database),
    publications: new SqliteIngestionPublicationStore(ingestionDatabase),
    indexPublications: new SqliteIndexPublicationStore(ingestionDatabase),
    close: () => {
      ingestionDatabase.close();
      database.close();
    },
  };
});

afterEach(() => {
  cli.close();
});

/** Parses real argv, so the test cannot pass on a command shape nobody types. */
function decisionOf(argv: readonly string[]) {
  const parsed = parseCliArguments(argv);
  if (parsed.status !== "ok" || parsed.command.kind !== "cards_decision") {
    throw new Error(`expected a decision, got ${JSON.stringify(parsed)}`);
  }
  return parsed.command;
}

async function currentVersionOf(cardId: string): Promise<string | undefined> {
  return (await cards.findCard(cardId))?.versions.currentVersionId;
}

describe("cards approve", () => {
  it("promotes the newest version and exits zero", async () => {
    const outcome = await runCardsDecision(
      cli,
      decisionOf(["cards", "approve", "card_payments", "--by", "kim"]),
    );

    expect(outcome.exitCode).toBe(EXIT_CODES.ok);
    expect(outcome.stdout).toContain("cv_2");
    expect(await currentVersionOf("card_payments")).toBe("cv_2");
  });

  it("records who decided, even when nobody said", async () => {
    // The audit trail is the reason `--by` exists, and an operator who omits it
    // still has an identity: the OS account running the command. A constant like
    // `cli` would put a name in an append-only trail that identifies nobody.
    const outcome = await runCardsDecision(
      cli,
      decisionOf(["cards", "approve", "card_payments"]),
    );

    expect(outcome.stdout).toContain("결정자:");
  });
});

describe("cards inspection", () => {
  it("defaults to a compact list of versions awaiting approval", async () => {
    const outcome = await runCardsList(cli, {
      kind: "cards_list",
      json: false,
      filter: "pending",
      compact: true,
    });

    expect(outcome.exitCode).toBe(EXIT_CODES.ok);
    expect(outcome.stdout).toContain("승인 대기 Card 1개");
    expect(outcome.stdout).toContain("card_payments");
    expect(outcome.stdout).toContain("상세: contextctl cards show card_payments");
    expect(outcome.stdout).not.toContain("키워드:");
  });

  it("keeps the previous full JSON shape behind an explicit all filter", async () => {
    const outcome = await runCardsList(cli, {
      kind: "cards_list",
      json: true,
      filter: "all",
      compact: true,
    });
    const parsed = JSON.parse(outcome.stdout) as readonly {
      readonly card: { readonly id: string };
      readonly pendingVersionIds: readonly string[];
    }[];

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.card.id).toBe("card_payments");
    expect(parsed[0]?.pendingVersionIds).toEqual(["cv_1", "cv_2"]);
  });

  it("filters by the source carried by a managed document Scope", async () => {
    const matching = await runCardsList(cli, {
      kind: "cards_list",
      json: false,
      filter: "all",
      compact: true,
      source: "src_payments",
    });
    const absent = await runCardsList(cli, {
      kind: "cards_list",
      json: false,
      filter: "all",
      compact: true,
      source: "src_other",
    });

    expect(matching.stdout).toContain("card_payments");
    expect(absent.stdout).not.toContain("card_payments");
  });

  it("shows complete evidence for one exact version", async () => {
    const outcome = await runCardsShow(cli, {
      kind: "cards_show",
      cardId: "card_payments",
      versionId: "cv_2",
      json: false,
    });

    expect(outcome.stdout).toContain("Card card_payments");
    expect(outcome.stdout).toContain("cv_2");
    expect(outcome.stdout).not.toContain("cv_1 (");
    expect(outcome.stdout).toContain("키워드:");
    expect(outcome.stdout).toContain("근거:");
  });

  it("does not resurface an operator-refused version as pending or auto-approve it", async () => {
    await runCardsDecision(
      cli,
      decisionOf(["cards", "reject", "card_payments", "cv_2", "--by", "kim"]),
    );

    const listing = await runCardsList(cli, {
      kind: "cards_list",
      json: false,
      filter: "pending",
      compact: true,
    });
    expect(listing.stdout).toContain("cv_1");
    expect(listing.stdout).not.toContain("cv_2");

    await runCardsDecision(
      cli,
      decisionOf(["cards", "approve", "card_payments", "--by", "kim"]),
    );
    expect(await currentVersionOf("card_payments")).toBe("cv_1");
  });
});

describe("cards reject", () => {
  it("refuses the named version and leaves nothing serving", async () => {
    const outcome = await runCardsDecision(
      cli,
      decisionOf(["cards", "reject", "card_payments", "cv_2", "--by", "kim"]),
    );

    expect(outcome.exitCode).toBe(EXIT_CODES.ok);
    // The version is not deleted — a reviewer has to be able to see what was
    // turned down — so the observable effect is that it did not become current.
    expect(await currentVersionOf("card_payments")).toBeUndefined();
  });
});

describe("cards disable", () => {
  it("stops the Card serving without touching its history", async () => {
    await runCardsDecision(
      cli,
      decisionOf(["cards", "approve", "card_payments", "--by", "kim"]),
    );

    const outcome = await runCardsDecision(
      cli,
      decisionOf(["cards", "disable", "card_payments", "--by", "kim"]),
    );

    expect(outcome.exitCode).toBe(EXIT_CODES.ok);
    expect(await currentVersionOf("card_payments")).toBeUndefined();
    // Re-approvable afterwards, which is what "history untouched" means in
    // practice: a disabled Card does not have to be rebuilt from a Publication.
    const versions = (await cards.findCard("card_payments"))?.versions.versions ?? [];
    expect(versions.map((version) => version.id)).toEqual(["cv_1", "cv_2"]);
  });
});

describe("cards rollback", () => {
  it("moves the pointer back to the earlier version", async () => {
    await runCardsDecision(
      cli,
      decisionOf(["cards", "approve", "card_payments", "--by", "kim"]),
    );

    const outcome = await runCardsDecision(
      cli,
      decisionOf(["cards", "rollback", "card_payments", "cv_1", "--by", "kim"]),
    );

    expect(outcome.exitCode).toBe(EXIT_CODES.ok);
    expect(await currentVersionOf("card_payments")).toBe("cv_1");
  });

  it("refuses to roll forward, with the refused code", async () => {
    // The whole reason `rollback` is not an alias for `approve`: an operator who
    // mistypes the version would otherwise promote a later one under the word
    // "rollback", and the audit trail would record the opposite of the intent.
    await runCardsDecision(
      cli,
      decisionOf(["cards", "approve", "card_payments", "--by", "kim"]),
    );
    await runCardsDecision(
      cli,
      decisionOf(["cards", "rollback", "card_payments", "cv_1", "--by", "kim"]),
    );

    const outcome = await runCardsDecision(
      cli,
      decisionOf(["cards", "rollback", "card_payments", "cv_2", "--by", "kim"]),
    );

    expect(outcome.exitCode).toBe(EXIT_CODES.refused);
    expect(await currentVersionOf("card_payments")).toBe("cv_1");
  });
});

describe("reachability", () => {
  it("reports the summary and passes the gate on an empty catalog", async () => {
    const outcome = await runReachability(cli, { kind: "reachability" });

    expect(outcome.exitCode).toBe(EXIT_CODES.ok);
    expect(outcome.stdout.length).toBeGreaterThan(0);
  });

  it("narrows the report to one state", async () => {
    const outcome = await runReachability(cli, {
      kind: "reachability",
      state: "orphaned",
    });

    expect(outcome.exitCode).toBe(EXIT_CODES.ok);
  });

  it("reports a state it does not know as a usage error, not a gate failure", async () => {
    const outcome = await runReachability(cli, {
      kind: "reachability",
      state: "not_a_state",
    });

    // Both are non-zero, and telling them apart is the point of the mapping: a
    // typo in a script is fixed in the script, a failed gate stops a release.
    expect(outcome.exitCode).toBe(EXIT_CODES.usageError);
    expect(outcome.exitCode).not.toBe(EXIT_CODES.gateFailed);
  });
});

describe("the runtime these commands open", () => {
  it("creates its home rather than reporting a corrupt database", async () => {
    // A missing parent directory makes SQLite say `unable to open database file`,
    // which reads as damage rather than as a first run — and `reachability` is a
    // legitimate first command, so it reached an operator as an uncaught stack
    // trace before this.
    const parent = await mkdtemp(join(tmpdir(), "contextctl-fresh-"));
    const home = join(parent, "nested", "deeper");

    const runtime = openRegistryOnlyRuntime({
      environment: { CONTEXTCTL_HOME: home },
    });
    try {
      const outcome = await runReachability(runtime, { kind: "reachability" });
      expect(outcome.exitCode).toBe(EXIT_CODES.ok);
    } finally {
      runtime.close();
      await rm(parent, { recursive: true, force: true });
    }
  });
});

describe("a decision handed no version", () => {
  it.each(["reject", "rollback"] as const)(
    "refuses %s as a usage error rather than picking one",
    async (decision) => {
      // The parser blocks this, and the command refuses it again: resolving "the
      // newest" here would record a decision about a version the operator never
      // named, and the two rules have to agree or the guard is decorative.
      const outcome = await runCardsDecision(cli, {
        kind: "cards_decision",
        decision,
        cardId: "card_payments",
        by: "kim",
      });

      expect(outcome.exitCode).toBe(EXIT_CODES.usageError);
      expect(await currentVersionOf("card_payments")).toBeUndefined();
    },
  );
});

describe("reachability when the gate does not pass", () => {
  /**
   * Two approved Cards describe the same Scope version differently, which is what
   * `broken` means: one of them points at something that is no longer what it
   * says it is. The gate treats any `broken` Scope as a release blocker.
   */
  async function breakOneScope(): Promise<void> {
    const rival = createContextCard("card_refunds", meaning, {
      sensitive: false,
      allowedUsage: ["retrieval"],
    });
    const disagreeing: CardVersion = {
      ...versionOf("card_refunds", "cv_rival", "2026-08-03T00:00:00.000Z"),
      scopes: [
        {
          ...scope,
          documentIndex: { ...scope.documentIndex, indexVersion: "idxv_bbbb" },
        },
      ],
    };
    await cards.saveCard(
      withCardVersions(rival, appendCardVersion(rival.versions, disagreeing)),
      [],
    );

    for (const [cardId, versionId] of [
      ["card_payments", "cv_2"],
      ["card_refunds", "cv_rival"],
    ] as const) {
      await runCardsDecision(cli, {
        kind: "cards_decision",
        decision: "approve",
        cardId,
        versionId,
        by: "kim",
      });
    }
  }

  it("exits with the gate code", async () => {
    await breakOneScope();

    const outcome = await runReachability(cli, { kind: "reachability" });

    expect(outcome.exitCode).toBe(EXIT_CODES.gateFailed);
  });

  it("keeps the report on stdout, where the reason is", async () => {
    await breakOneScope();

    const outcome = await runReachability(cli, { kind: "reachability" });

    // The verdict without the reason is not actionable, and CI captures stdout.
    // Moving the report to stderr on failure would hand back an exit code and a
    // sentence naming no Scope.
    expect(outcome.stdout).toContain("broken");
    expect(outcome.stderr.join("\n")).toContain("registry-reachability-v1");
  });
});
