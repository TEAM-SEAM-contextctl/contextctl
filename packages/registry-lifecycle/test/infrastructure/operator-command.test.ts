import type { DatabaseSync } from "node:sqlite";

import { beforeEach, describe, expect, it } from "vitest";

import type { CardDecisionPorts } from "../../src/application/approve-card-version.js";
import {
  appendCardVersion,
  type CardVersion,
} from "../../src/domain/card-version.js";
import {
  createContextCard,
  withCardVersions,
  type ContextCard,
} from "../../src/domain/context-card.js";
import { runOperatorCommand } from "../../src/infrastructure/cli/operator-command.js";
import { openRegistryDatabase } from "../../src/infrastructure/sqlite/registry-database.js";
import { SqliteCardStore } from "../../src/infrastructure/sqlite/sqlite-card-store.js";
import { SqliteLifecycleEventStore } from "../../src/infrastructure/sqlite/sqlite-lifecycle-event-store.js";
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
  let ports: CardDecisionPorts;
  let events: SqliteLifecycleEventStore;

  beforeEach(async () => {
    database = openRegistryDatabase(":memory:");
    const store = new SqliteCardStore(database);
    events = new SqliteLifecycleEventStore(database);
    let nextId = 0;
    ports = {
      cards: store,
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
    const result = await runOperatorCommand(ports, ["rollback", "unit_a"]);

    expect(result.status).toBe("usage_error");
    expect(result.output).toContain("unknown command: rollback");
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
});
