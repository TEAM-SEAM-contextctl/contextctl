import type { DatabaseSync } from "node:sqlite";

import { beforeEach, describe, expect, it } from "vitest";

import {
  appendCardVersion,
  type CardVersion,
} from "../../src/domain/card-version.js";
import {
  createContextCard,
  withCardVersions,
  type ContextCard,
} from "../../src/domain/context-card.js";
import {
  runOperatorCommand,
  type OperatorCommandPorts,
} from "../../src/infrastructure/cli/operator-command.js";
import { openRegistryDatabase } from "../../src/infrastructure/sqlite/registry-database.js";
import { SqliteCardStore } from "../../src/infrastructure/sqlite/sqlite-card-store.js";
import { SqliteLifecycleEventStore } from "../../src/infrastructure/sqlite/sqlite-lifecycle-event-store.js";
import { SqliteConsumerCheckpointStore } from "../../src/infrastructure/sqlite/sqlite-consumer-checkpoint-store.js";
import { SqliteScopeReachabilityStore } from "../../src/infrastructure/sqlite/sqlite-scope-reachability-store.js";
import { createDocumentCardVersion } from "../fixtures/card-version.fixture.js";

const meaning = {
  description: "결제 실패 재시도 정책",
  representativeQuestions: ["결제가 실패하면 언제 재시도되나요?"],
  aliases: [],
  keywords: [],
};

const policy = { sensitive: false, allowedUsage: ["retrieval"] };

function cardWith(
  cardId: string,
  versions: readonly CardVersion[],
): ContextCard {
  const card = createContextCard(cardId, meaning, policy);
  let history = card.versions;
  for (const version of versions) {
    history = appendCardVersion(history, version);
  }
  return withCardVersions(card, history);
}

function version(
  id: string,
  cardId: string,
  validationState: CardVersion["validationState"],
): CardVersion {
  return { ...createDocumentCardVersion(), id, cardId, validationState };
}

describe("runOperatorCommand", () => {
  let database: DatabaseSync;
  let ports: OperatorCommandPorts;
  let events: SqliteLifecycleEventStore;

  beforeEach(async () => {
    database = openRegistryDatabase(":memory:");
    const store = new SqliteCardStore(database);
    events = new SqliteLifecycleEventStore(database);
    let nextId = 0;
    ports = {
      cards: store,
      scopes: new SqliteScopeReachabilityStore(database),
      checkpoints: new SqliteConsumerCheckpointStore(
        database,
        () => "2026-08-19T00:00:00.000Z",
      ),
      clock: { now: () => "2026-08-10T00:00:00.000Z" },
      ids: {
        nextId: () => {
          nextId += 1;
          return `ev_${nextId}`;
        },
      },
    };

    await store.saveCard(
      cardWith("unit_a", [
        version("cv_a", "unit_a", "validated"),
        version("cv_draft", "unit_a", "draft"),
      ]),
      [],
    );
  });

  it("approves a validated version and reports what changed", async () => {
    const result = await runOperatorCommand(ports, [
      "approve",
      "unit_a",
      "cv_a",
      "--by",
      "operator@example.test",
    ]);

    expect(result).toEqual({
      status: "ok",
      output: "approved cv_a as the current version of unit_a",
    });
    expect(
      (await ports.cards.findCard("unit_a"))?.versions.currentVersionId,
    ).toBe("cv_a");
  });

  it("carries the note into the audit trail", async () => {
    await runOperatorCommand(ports, [
      "approve",
      "unit_a",
      "cv_a",
      "--by",
      "operator@example.test",
      "--note",
      "문서 검토 완료",
    ]);

    expect((await events.listForCard("unit_a")).at(-1)).toMatchObject({
      kind: "card_version_promoted",
      decidedBy: "operator@example.test",
      note: "문서 검토 완료",
    });
  });

  it("records a refusal without promoting", async () => {
    const result = await runOperatorCommand(ports, [
      "reject",
      "unit_a",
      "cv_a",
      "--by",
      "operator@example.test",
    ]);

    expect(result).toEqual({ status: "ok", output: "rejected cv_a of unit_a" });
    expect(
      (await ports.cards.findCard("unit_a"))?.versions.currentVersionId,
    ).toBeUndefined();
    expect((await events.listForCard("unit_a")).at(-1)).toMatchObject({
      kind: "card_version_refused",
    });
  });

  it("takes an approved card out of service", async () => {
    await runOperatorCommand(ports, [
      "approve",
      "unit_a",
      "cv_a",
      "--by",
      "operator@example.test",
    ]);

    const result = await runOperatorCommand(ports, [
      "disable",
      "unit_a",
      "--by",
      "operator@example.test",
    ]);

    expect(result).toEqual({ status: "ok", output: "disabled unit_a" });
    expect(
      (await ports.cards.findCard("unit_a"))?.versions.currentVersionId,
    ).toBeUndefined();
  });

  it("refuses to approve a version that failed grounding, and says why", async () => {
    const result = await runOperatorCommand(ports, [
      "approve",
      "unit_a",
      "cv_draft",
      "--by",
      "operator@example.test",
    ]);

    expect(result.status).toBe("refused");
    // The operator should learn which rule stopped them, not just that it failed.
    expect(result.output).toContain("cv_draft");
    expect(result.output).toContain("draft");
    expect(
      (await ports.cards.findCard("unit_a"))?.versions.currentVersionId,
    ).toBeUndefined();
  });

  it("separates a missing card from a malformed command", async () => {
    const missing = await runOperatorCommand(ports, [
      "approve",
      "unit_missing",
      "cv_a",
      "--by",
      "operator@example.test",
    ]);
    const malformed = await runOperatorCommand(ports, ["approve", "unit_a"]);

    expect(missing.status).toBe("refused");
    expect(missing.output).toContain("unit_missing");
    expect(malformed.status).toBe("usage_error");
  });

  it("rejects an unknown command and shows usage", async () => {
    // Was `rollback` until that became a real command. Anything the table does
    // not carry has to fall here rather than be attempted.
    const result = await runOperatorCommand(ports, ["purge", "unit_a"]);

    expect(result.status).toBe("usage_error");
    expect(result.output).toContain("unknown command: purge");
    expect(result.output).toContain("usage:");
  });

  it("rejects an empty command line", async () => {
    expect((await runOperatorCommand(ports, [])).status).toBe("usage_error");
  });

  it("requires --by so the trail can name the decider", async () => {
    const result = await runOperatorCommand(ports, [
      "approve",
      "unit_a",
      "cv_a",
    ]);

    expect(result.status).toBe("usage_error");
    expect(result.output).toContain("--by is required");
    // Nothing was attempted, so no event was written.
    expect(await events.listForCard("unit_a")).toEqual([]);
  });

  it("rejects a flag that was given no value", async () => {
    const result = await runOperatorCommand(ports, [
      "approve",
      "unit_a",
      "cv_a",
      "--by",
      "--note",
      "orphaned",
    ]);

    expect(result.status).toBe("usage_error");
    expect(result.output).toContain("--by needs a value");
  });

  it("rejects an unknown option instead of treating it as an operand", async () => {
    const result = await runOperatorCommand(ports, [
      "approve",
      "unit_a",
      "cv_a",
      "--force",
      "yes",
      "--by",
      "operator@example.test",
    ]);

    expect(result.status).toBe("usage_error");
    expect(result.output).toContain("unknown option: --force");
  });

  it("counts operands per command", async () => {
    const tooMany = await runOperatorCommand(ports, [
      "disable",
      "unit_a",
      "cv_a",
      "--by",
      "operator@example.test",
    ]);
    const tooFew = await runOperatorCommand(ports, [
      "approve",
      "unit_a",
      "--by",
      "operator@example.test",
    ]);

    expect(tooMany.status).toBe("usage_error");
    expect(tooMany.output).toContain("disable takes 1 argument(s), got 2");
    expect(tooFew.status).toBe("usage_error");
    expect(tooFew.output).toContain("approve takes 2 argument(s), got 1");
  });

  describe("reachability", () => {
    // A Card of its own, carrying exactly one version. The shared fixture Card
    // also holds a draft over the same Scope version, and a draft outranks
    // every unreachable state — correct, but it would hide what these cases
    // are about.
    let soloPorts: OperatorCommandPorts;

    beforeEach(async () => {
      const soloDatabase = openRegistryDatabase(":memory:");
      const store = new SqliteCardStore(soloDatabase);
      soloPorts = {
        ...ports,
        cards: store,
        scopes: new SqliteScopeReachabilityStore(soloDatabase),
      checkpoints: new SqliteConsumerCheckpointStore(
        soloDatabase,
        () => "2026-08-19T00:00:00.000Z",
      ),
      };
      await store.saveCard(
        cardWith("unit_solo", [version("cv_solo", "unit_solo", "validated")]),
        [],
      );
    });

    async function approveSolo(): Promise<void> {
      await runOperatorCommand(soloPorts, [
        "approve",
        "unit_solo",
        "cv_solo",
        "--by",
        "operator@example.test",
      ]);
    }

    async function disableSolo(note?: string): Promise<void> {
      await runOperatorCommand(soloPorts, [
        "disable",
        "unit_solo",
        "--by",
        "operator@example.test",
        ...(note === undefined ? [] : ["--note", note]),
      ]);
    }

    /**
     * The processing delay, printed beside the states.
     *
     * The two belong together: a Scope in `pending_registry` is only worrying if
     * its Source is also behind, so an operator holding one number without the
     * other cannot tell a slow minute from a stuck hour.
     */
    describe("processing delay", () => {
      const consumed = {
        publicationId: "pub_first",
        sourceId: "src_payments",
        producedAt: "2026-08-09T20:00:00.000Z",
        knowledgeUnits: [],
      };
      const newest = {
        publicationId: "pub_latest",
        sourceId: "src_payments",
        // Two hours before the clock this suite runs at, so the Scope it carries
        // is well past the five minutes the operating standard allows.
        producedAt: "2026-08-09T22:00:00.000Z",
        knowledgeUnits: [
          {
            publishedScopes: [
              { scopeId: "scope_waiting", scopeVersion: "scpv_waiting" },
            ],
          },
        ],
      };

      function withFeed(latest: typeof newest | undefined): OperatorCommandPorts {
        return {
          ...soloPorts,
          checkpoints: {
            ...soloPorts.checkpoints,
            listCursors: async () => [
              { sourceId: "src_payments", publicationId: "pub_first" },
            ],
          },
          publications: {
            latestForSource: async () => latest as unknown as undefined,
            findById: async (publicationId) =>
              publicationId === "pub_first"
                ? (consumed as unknown as undefined)
                : undefined,
          },
        };
      }

      it("names the Source that is behind and how stale it is", async () => {
        await approveSolo();

        const result = await runOperatorCommand(withFeed(newest), ["reachability"]);

        expect(result.output).toContain("1 source(s) behind");
        expect(result.output).toContain("src_payments");
        expect(result.output).toContain("pub_first -> pub_latest");
        // Two hours, printed as an operator reads it rather than in millis.
        expect(result.output).toContain("lag 2h 0m");
      });

      it("marks the registry lane degraded when a Scope waited too long", async () => {
        // The judgement was unreachable before: no Scope could be
        // `pending_registry`, so the five-minute rule never fired. This is the
        // whole rule working end to end — an unconsumed Publication produces the
        // state, and the state produces the verdict.
        await approveSolo();

        const result = await runOperatorCommand(withFeed(newest), ["reachability"]);

        expect(result.output).toContain("pending_registry over 5m");
        expect(result.output).toContain("registry lane is degraded");
        expect(result.output).toContain("scope_waiting@scpv_waiting");
      });

      it("says nothing about a Source that is current", async () => {
        // Listing every healthy Source would bury the one that is not, and the
        // summary above already states the total, so silence is not ambiguous.
        await approveSolo();

        const result = await runOperatorCommand(
          withFeed({ ...consumed } as typeof newest),
          ["reachability"],
        );

        expect(result.output).not.toContain("source(s) behind");
      });

      it("reports no delay when no publication reader was assembled", async () => {
        // `soloPorts` has no `publications`, which is a legitimate composition:
        // the states need only committed Card state.
        await approveSolo();

        const result = await runOperatorCommand(soloPorts, ["reachability"]);

        expect(result.output).not.toContain("source(s) behind");
        expect(result.status).toBe("ok");
      });
    });

    it("summarises the states and passes the gate when nothing is unreachable", async () => {
      await approveSolo();

      const result = await runOperatorCommand(soloPorts, ["reachability"]);

      expect(result.status).toBe("ok");
      expect(result.output).toContain("reachable");
      expect(result.output).toContain("coverage 100%");
      expect(result.output).toContain("gate registry-reachability-v1: passed");
    });

    it("fails the gate when a Card was disabled with no reason", async () => {
      await approveSolo();
      await disableSolo();

      const result = await runOperatorCommand(soloPorts, ["reachability"]);

      // No note, so nobody can tell later whether the Scope was dropped on
      // purpose. That is the state the gate refuses to ship.
      expect(result.status).toBe("gate_failed");
      expect(result.output).toContain("orphaned");
      expect(result.output).toContain("FAILED");
    });

    it("passes the gate once that same decision records a reason", async () => {
      await approveSolo();
      await disableSolo("정책 핸드북으로 대체됨");

      const result = await runOperatorCommand(soloPorts, ["reachability"]);

      expect(result.status).toBe("ok");
      expect(result.output).toContain("intentionally_unexposed");
    });

    it("names the scope versions in one state, with the reason when there is one", async () => {
      await approveSolo();
      await disableSolo("정책 핸드북으로 대체됨");

      const result = await runOperatorCommand(soloPorts, [
        "reachability",
        "--state",
        "intentionally_unexposed",
      ]);

      expect(result.status).toBe("ok");
      expect(result.output).toContain("scope_payment_failures@scpv_aaaa");
      expect(result.output).toContain("정책 핸드북으로 대체됨");
    });

    it("keeps a draft ahead of the unreachable states", async () => {
      // The shared fixture Card carries a validated version and a draft over
      // one Scope version. Withdrawing the served version leaves the draft, so
      // the Scope is awaiting approval rather than orphaned.
      await runOperatorCommand(ports, [
        "approve",
        "unit_a",
        "cv_a",
        "--by",
        "operator@example.test",
      ]);
      await runOperatorCommand(ports, [
        "disable",
        "unit_a",
        "--by",
        "operator@example.test",
      ]);

      const result = await runOperatorCommand(ports, ["reachability"]);

      expect(result.status).toBe("ok");
      expect(result.output).toContain("pending_approval");
    });

    it("says so rather than printing nothing when a state has no scopes", async () => {
      const result = await runOperatorCommand(soloPorts, [
        "reachability",
        "--state",
        "broken",
      ]);

      expect(result.status).toBe("ok");
      expect(result.output).toBe("no scope versions are broken");
    });

    it("rejects a state name that does not exist", async () => {
      const result = await runOperatorCommand(soloPorts, [
        "reachability",
        "--state",
        "unreachable",
      ]);

      expect(result.status).toBe("usage_error");
      expect(result.output).toContain("unknown state: unreachable");
    });

    it("rejects options it does not take", async () => {
      const result = await runOperatorCommand(soloPorts, [
        "reachability",
        "--by",
        "operator@example.test",
      ]);

      // Reading decides nothing, so there is no actor to record.
      expect(result.status).toBe("usage_error");
      expect(result.output).toContain("unknown option: --by");
    });

    it("reports an empty registry as unprocessed rather than clean", async () => {
      const emptyDatabase = openRegistryDatabase(":memory:");
      const result = await runOperatorCommand(
        {
          ...ports,
          cards: new SqliteCardStore(emptyDatabase),
          scopes: new SqliteScopeReachabilityStore(emptyDatabase),
          checkpoints: new SqliteConsumerCheckpointStore(
            emptyDatabase,
            () => "2026-08-19T00:00:00.000Z",
          ),
        },
        ["reachability"],
      );

      expect(result.status).toBe("ok");
      expect(result.output).toContain("no scope versions have been processed yet");
    });
  });

  describe("rollback", () => {
    // 두 개의 validated 버전을 가진 Card. 픽스처의 unit_a는 validated 하나와
    // draft 하나여서 되돌릴 곳이 없다.
    let twoPorts: OperatorCommandPorts;
    let twoEvents: SqliteLifecycleEventStore;

    beforeEach(async () => {
      const twoDatabase = openRegistryDatabase(":memory:");
      const store = new SqliteCardStore(twoDatabase);
      twoEvents = new SqliteLifecycleEventStore(twoDatabase);
      twoPorts = {
        ...ports,
        cards: store,
        scopes: new SqliteScopeReachabilityStore(twoDatabase),
      checkpoints: new SqliteConsumerCheckpointStore(
        twoDatabase,
        () => "2026-08-19T00:00:00.000Z",
      ),
      };
      await store.saveCard(
        cardWith("unit_b", [
          version("cv_first", "unit_b", "validated"),
          version("cv_second", "unit_b", "validated"),
          version("cv_draft", "unit_b", "draft"),
        ]),
        [],
      );
      await runOperatorCommand(twoPorts, [
        "approve",
        "unit_b",
        "cv_second",
        "--by",
        "operator@example.test",
      ]);
    });

    async function currentVersionId(): Promise<string | undefined> {
      return (await twoPorts.cards.findCard("unit_b"))?.versions
        .currentVersionId;
    }

    it("moves the pointer back to an earlier version", async () => {
      const result = await runOperatorCommand(twoPorts, [
        "rollback",
        "unit_b",
        "cv_first",
        "--by",
        "operator@example.test",
      ]);

      expect(result).toEqual({
        status: "ok",
        output: "rolled unit_b back to cv_first",
      });
      expect(await currentVersionId()).toBe("cv_first");
    });

    it("leaves the version history intact", async () => {
      await runOperatorCommand(twoPorts, [
        "rollback",
        "unit_b",
        "cv_first",
        "--by",
        "operator@example.test",
      ]);

      const card = await twoPorts.cards.findCard("unit_b");
      expect(card?.versions.versions.map((entry) => entry.id)).toEqual([
        "cv_first",
        "cv_second",
        "cv_draft",
      ]);
    });

    it("refuses a target that does not precede the current version", async () => {
      // Reaching for a rollback and mistyping the id must not promote something
      // forward under that word.
      const result = await runOperatorCommand(twoPorts, [
        "rollback",
        "unit_b",
        "cv_second",
        "--by",
        "operator@example.test",
      ]);

      expect(result.status).toBe("refused");
      expect(result.output).toContain("does not precede the current version");
      expect(await currentVersionId()).toBe("cv_second");
    });

    it("refuses a draft target even though it was never current", async () => {
      const result = await runOperatorCommand(twoPorts, [
        "rollback",
        "unit_b",
        "cv_draft",
        "--by",
        "operator@example.test",
      ]);

      expect(result.status).toBe("refused");
      expect(await currentVersionId()).toBe("cv_second");
    });

    it("records the move as a promotion whose previous version came later", async () => {
      await runOperatorCommand(twoPorts, [
        "rollback",
        "unit_b",
        "cv_first",
        "--by",
        "operator@example.test",
        "--note",
        "회귀 확인 후 되돌림",
      ]);

      // One event kind covers both directions; the pair of ids is what says
      // this was a rollback.
      expect((await twoEvents.listForCard("unit_b")).at(-1)).toMatchObject({
        kind: "card_version_promoted",
        versionId: "cv_first",
        previousVersionId: "cv_second",
        decidedBy: "operator@example.test",
        note: "회귀 확인 후 되돌림",
      });
    });

    it("requires --by like every other operator decision", async () => {
      const result = await runOperatorCommand(twoPorts, [
        "rollback",
        "unit_b",
        "cv_first",
      ]);

      expect(result.status).toBe("usage_error");
      expect(result.output).toContain("--by is required");
      expect(await currentVersionId()).toBe("cv_second");
    });

    it("refuses a rollback on a Card that serves nothing", async () => {
      await runOperatorCommand(twoPorts, [
        "disable",
        "unit_b",
        "--by",
        "operator@example.test",
      ]);

      const result = await runOperatorCommand(twoPorts, [
        "rollback",
        "unit_b",
        "cv_first",
        "--by",
        "operator@example.test",
      ]);

      // There is no "back" from nothing. Re-approving is the way forward, and
      // that path already exists.
      expect(result.status).toBe("refused");
      expect(await currentVersionId()).toBeUndefined();
    });
  });
});
