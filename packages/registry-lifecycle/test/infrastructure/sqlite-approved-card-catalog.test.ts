import type { DatabaseSync } from "node:sqlite";

import { beforeEach, describe, expect, it } from "vitest";

import {
  approveCardVersion,
  disableCard,
  type CardDecisionPorts,
} from "../../src/application/approve-card-version.js";
import {
  appendCardVersion,
  type CardVersion,
} from "../../src/domain/card-version.js";
import {
  createContextCard,
  withCardVersions,
  type ContextCard,
} from "../../src/domain/context-card.js";
import { openRegistryDatabase } from "../../src/infrastructure/sqlite/registry-database.js";
import { SqliteCardStore } from "../../src/infrastructure/sqlite/sqlite-card-store.js";
import { createDocumentCardVersion } from "../fixtures/card-version.fixture.js";

const meaning = {
  description: "결제 실패 재시도 정책",
  representativeQuestions: ["결제가 실패하면 언제 재시도되나요?"],
  aliases: ["payment retry"],
  keywords: ["payment", "retry"],
};

const policy = { sensitive: false, allowedUsage: ["retrieval"] };
const decision = { decidedBy: "operator@example.test" };

function cardWith(cardId: string, versionId: string): ContextCard {
  const card = createContextCard(cardId, meaning, policy);
  const version: CardVersion = {
    ...createDocumentCardVersion(),
    id: versionId,
    cardId,
  };
  return withCardVersions(card, appendCardVersion(card.versions, version));
}

/** Counts prepared statements so query volume can be asserted, not assumed. */
function countingDatabase(database: DatabaseSync): {
  readonly database: DatabaseSync;
  prepareCount: () => number;
  reset: () => void;
} {
  let prepares = 0;
  const proxy = new Proxy(database, {
    get(target, property, receiver) {
      if (property === "prepare") {
        return (sql: string) => {
          prepares += 1;
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return {
    database: proxy,
    prepareCount: () => prepares,
    reset: () => {
      prepares = 0;
    },
  };
}

describe("SqliteCardStore approved catalog", () => {
  let database: DatabaseSync;
  let store: SqliteCardStore;
  let ports: CardDecisionPorts;

  beforeEach(() => {
    database = openRegistryDatabase(":memory:");
    store = new SqliteCardStore(database);
    let nextId = 0;
    ports = {
      cards: store,
      clock: { now: () => "2026-08-05T00:00:00.000Z" },
      ids: {
        nextId: () => {
          nextId += 1;
          return `ev_${nextId}`;
        },
      },
    };
  });

  it("returns meaning, policy, and scopes inline for an approved card", async () => {
    await store.saveCard(cardWith("unit_a", "cv_a"), []);
    await approveCardVersion(ports, "unit_a", "cv_a", decision);

    expect(await store.listApprovedCards()).toEqual([
      {
        cardId: "unit_a",
        versionId: "cv_a",
        meaning,
        policy,
        scopes: createDocumentCardVersion().scopes,
      },
    ]);
  });

  it("omits a card that has never been approved", async () => {
    await store.saveCard(cardWith("unit_a", "cv_a"), []);

    expect(await store.listApprovedCards()).toEqual([]);
  });

  it("drops a card once it is withdrawn", async () => {
    await store.saveCard(cardWith("unit_a", "cv_a"), []);
    await approveCardVersion(ports, "unit_a", "cv_a", decision);
    await disableCard(ports, "unit_a", decision);

    expect(await store.listApprovedCards()).toEqual([]);
  });

  it("serves only the current version when a card has several", async () => {
    const card = cardWith("unit_a", "cv_a");
    const second: CardVersion = {
      ...createDocumentCardVersion(),
      id: "cv_b",
      cardId: "unit_a",
    };
    await store.saveCard(
      withCardVersions(card, appendCardVersion(card.versions, second)),
      [],
    );
    await approveCardVersion(ports, "unit_a", "cv_b", decision);

    const catalog = await store.listApprovedCards();
    expect(catalog).toHaveLength(1);
    expect(catalog[0]?.versionId).toBe("cv_b");
  });

  it("costs the same number of queries no matter how many cards are approved", async () => {
    const counting = countingDatabase(database);
    const countingStore = new SqliteCardStore(counting.database);

    for (const suffix of ["a", "b", "c", "d", "e"]) {
      await store.saveCard(cardWith(`unit_${suffix}`, `cv_${suffix}`), []);
      await approveCardVersion(ports, `unit_${suffix}`, `cv_${suffix}`, decision);
    }

    // Control: findCard needs two statements, which shows the counter is live
    // and that this test would notice a per-card lookup creeping in.
    counting.reset();
    await countingStore.findCard("unit_a");
    expect(counting.prepareCount()).toBe(2);

    counting.reset();
    const catalog = await countingStore.listApprovedCards();

    expect(catalog).toHaveLength(5);
    // One statement total: meaning and scopes arrive together, so the cost does
    // not grow with the catalog the way a per-card meaning lookup would.
    expect(counting.prepareCount()).toBe(1);
  });
});
