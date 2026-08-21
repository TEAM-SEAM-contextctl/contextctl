import type { DatabaseSync } from "node:sqlite";

import { beforeEach, describe, expect, it } from "vitest";

import { buildReachabilityReport } from "../../src/application/build-reachability-report.js";
import {
  appendCardVersion,
  promoteCardVersion,
  withdrawCurrentVersion,
  type CardVersion,
} from "../../src/domain/card-version.js";
import {
  createContextCard,
  withCardVersions,
  type ContextCard,
} from "../../src/domain/context-card.js";
import type { LifecycleEvent } from "../../src/domain/lifecycle-event.js";
import { openRegistryDatabase } from "../../src/infrastructure/sqlite/registry-database.js";
import { SqliteCardStore } from "../../src/infrastructure/sqlite/sqlite-card-store.js";
import { SqliteConsumerCheckpointStore } from "../../src/infrastructure/sqlite/sqlite-consumer-checkpoint-store.js";
import { SqliteScopeReachabilityStore } from "../../src/infrastructure/sqlite/sqlite-scope-reachability-store.js";
import type { Clock } from "../../src/ports/clock.js";
import { createDocumentCardVersion } from "../fixtures/card-version.fixture.js";
import { fixtureRootId } from "../fixtures/ingestion-publication.fixture.js";

const meaning = {
  description: "결제 실패 재시도 정책",
  representativeQuestions: ["결제가 실패하면 언제 재시도되나요?"],
  aliases: ["payment retry"],
  keywords: ["payment", "retry"],
};

const policy = { sensitive: false, allowedUsage: ["retrieval"] };

const clock: Clock = { now: () => "2026-08-15T00:00:00.000Z" };

function servingCard(version: CardVersion = createDocumentCardVersion()): ContextCard {
  const card = createContextCard(version.cardId, meaning, policy);
  let history = appendCardVersion(card.versions, version);
  history = promoteCardVersion(history, version.id);
  return withCardVersions(card, history);
}

function withdrawn(card: ContextCard): ContextCard {
  return withCardVersions(card, withdrawCurrentVersion(card.versions));
}

function withdrawalEvent(note: string | undefined): LifecycleEvent {
  return {
    kind: "card_withdrawn",
    id: "ev_withdrawn",
    cardId: "unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd",
    occurredAt: "2026-08-05T00:00:00.000Z",
    withdrawnVersionId: "cv_document",
    decidedBy: "dayeon",
    note,
  };
}

/** A reader with nothing to report — required, and not the same as no reader. */
const emptyFeed = {
  latestForSource: async () => undefined,
  findById: async () => undefined,
};

describe("SqliteScopeReachabilityStore", () => {
  let database: DatabaseSync;
  let cards: SqliteCardStore;
  let scopes: SqliteScopeReachabilityStore;
  let checkpoints: SqliteConsumerCheckpointStore;

  beforeEach(() => {
    database = openRegistryDatabase(":memory:");
    cards = new SqliteCardStore(database);
    scopes = new SqliteScopeReachabilityStore(database);
    checkpoints = new SqliteConsumerCheckpointStore(
      database,
      () => "2026-08-19T00:00:00.000Z",
    );
  });

  it("names the Source from the claim record, not from Ingestion", async () => {
    // The join that makes `sourceId` possible without crossing a boundary:
    // `consumer_checkpoints` stores the Source beside every Publication Registry
    // consumed, so a Scope observed through a Card Version already knows it.
    await cards.saveCard(servingCard(), []);
    await checkpoints.markProcessed({
      sourceId: fixtureRootId("src", "payments"),
      publicationId: fixtureRootId("pub", "initial"),
    });

    const report = await buildReachabilityReport({
      scopes,
      checkpoints,
      clock,
      publications: emptyFeed,
    });

    expect(report.scopes[0]?.sourceId).toBe(fixtureRootId("src", "payments"));
  });

  it("falls back to the Publication id when no claim row names the Source", async () => {
    // A Card Version written before the claim record carried a Source would
    // otherwise drop out of the report, and a Scope missing from a reachability
    // report is the one failure this report exists to prevent.
    await cards.saveCard(servingCard(), []);

    const report = await buildReachabilityReport({
      scopes,
      checkpoints,
      clock,
      publications: emptyFeed,
    });

    expect(report.scopes[0]?.sourceId).toBe(fixtureRootId("pub", "initial"));
  });

  it("reports a served Scope as reachable", async () => {
    await cards.saveCard(servingCard(), []);

    const report = await buildReachabilityReport({ scopes, checkpoints, clock, publications: emptyFeed });

    expect(report.counts.reachable).toBe(1);
    expect(report.scopes[0]?.reference).toEqual({
      scopeId: "scope_payment_failures",
      scopeVersion: "scpv_aaaa",
    });
  });

  it("keeps seeing a Scope after its Card stops serving", async () => {
    // The catalog drops a withdrawn Card, and that is what makes its Scope
    // invisible today. Reachability has to read the versions the catalog no
    // longer returns, or an unreachable Scope simply vanishes from view.
    const card = servingCard();
    await cards.saveCard(card, []);
    await cards.saveCard(withdrawn(card), [withdrawalEvent(undefined)]);

    expect((await cards.listApprovedCards()).cards).toHaveLength(0);

    const report = await buildReachabilityReport({ scopes, checkpoints, clock, publications: emptyFeed });

    expect(report.scopes).toHaveLength(1);
    expect(report.counts.orphaned).toBe(1);
  });

  it("reads the reason an operator recorded when withdrawing", async () => {
    const card = servingCard();
    await cards.saveCard(card, []);
    await cards.saveCard(withdrawn(card), [
      withdrawalEvent("문서가 정책 핸드북으로 대체됨"),
    ]);

    const report = await buildReachabilityReport({ scopes, checkpoints, clock, publications: emptyFeed });

    expect(report.counts.intentionally_unexposed).toBe(1);
    expect(report.scopes[0]?.reason).toBe("문서가 정책 핸드북으로 대체됨");
  });

  it("judges a Card's older and newer Scope versions separately", async () => {
    const first = createDocumentCardVersion();
    const card = servingCard(first);
    await cards.saveCard(card, []);

    const second: CardVersion = {
      ...first,
      id: "cv_document_2",
      scopes: first.scopes.map((scope) =>
        scope.kind === "managed_document"
          ? {
              ...scope,
              reference: { ...scope.reference, scopeVersion: "scpv_bbbb" },
              documentIndex: {
                ...scope.documentIndex,
                indexVersion: "idxv_bbbb",
              },
            }
          : scope,
      ),
      validationState: "draft",
      createdAt: "2026-08-06T00:00:00.000Z",
    };
    await cards.saveCard(
      withCardVersions(card, appendCardVersion(card.versions, second)),
      [],
    );

    const report = await buildReachabilityReport({ scopes, checkpoints, clock, publications: emptyFeed });

    expect(report.counts.reachable).toBe(1);
    expect(report.counts.pending_approval).toBe(1);
  });

  it("reads every Scope a Card Version carries", async () => {
    const version = createDocumentCardVersion();
    const twoScopes: CardVersion = {
      ...version,
      scopes: [
        ...version.scopes,
        {
          kind: "sql_source",
          reference: {
            scopeId: "scope_payments_table",
            scopeVersion: "scpv_cccc",
          },
          connector: "postgres.main",
          schema: "public",
          table: "payments",
          columns: ["status"],
        },
      ],
    };
    await cards.saveCard(servingCard(twoScopes), []);

    const report = await buildReachabilityReport({ scopes, checkpoints, clock, publications: emptyFeed });

    expect(report.scopes.map((scope) => scope.reference.scopeId).sort()).toEqual(
      ["scope_payment_failures", "scope_payments_table"],
    );
  });

  it("does not read event kinds that decide nothing about exposure", async () => {
    const card = servingCard();
    await cards.saveCard(card, [
      {
        id: "ev_added",
        kind: "card_version_added",
        cardId: "unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd",
        occurredAt: "2026-08-04T00:00:00.000Z",
        versionId: "cv_document",
        publicationId: "pub_initial",
      },
    ]);

    expect(await scopes.listOperatorDecisions()).toEqual([]);
  });
});
