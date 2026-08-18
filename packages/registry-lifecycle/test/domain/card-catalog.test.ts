import { describe, expect, it } from "vitest";

import {
  checkCatalogSnapshotLimits,
  computeCatalogSnapshotVersion,
  toApprovedCardCatalogSnapshot,
  type CardCatalogEntry,
} from "../../src/domain/card-catalog.js";
import type { RetrievalScope } from "../../src/domain/retrieval-scope.js";

const scope: RetrievalScope = {
  kind: "sql_source",
  reference: { scopeId: "scope_payments", scopeVersion: "scpv_a" },
  connector: "postgres.main",
  table: "payments",
  columns: ["failed_reason", "status"],
};

function entry(overrides: Partial<CardCatalogEntry> = {}): CardCatalogEntry {
  return {
    cardId: "card_payments",
    versionId: "cv_1",
    meaning: {
      description: "결제 상태와 실패 사유",
      representativeQuestions: ["결제가 왜 실패했나요?"],
      aliases: ["payments"],
      keywords: ["payments", "status"],
    },
    policy: { sensitive: false, allowedUsage: ["retrieval"] },
    scopes: [scope],
    ...overrides,
  };
}

// The digest values themselves are never asserted. Publication v2 adds fields
// to Scopes, which will change every digest without changing what the version
// means, so these pin the properties a snapshot version has to have.
describe("computeCatalogSnapshotVersion", () => {
  it("gives the same version to the same catalog", () => {
    expect(computeCatalogSnapshotVersion([entry()])).toBe(
      computeCatalogSnapshotVersion([entry()]),
    );
  });

  it("ignores the order rows came back in", () => {
    const first = entry({ cardId: "card_a" });
    const second = entry({ cardId: "card_b", versionId: "cv_2" });

    expect(computeCatalogSnapshotVersion([first, second])).toBe(
      computeCatalogSnapshotVersion([second, first]),
    );
  });

  it("changes when a Card is added", () => {
    const one = computeCatalogSnapshotVersion([entry()]);
    const two = computeCatalogSnapshotVersion([
      entry(),
      entry({ cardId: "card_refunds", versionId: "cv_2" }),
    ]);

    expect(two).not.toBe(one);
  });

  it("changes when a Card serves a different version", () => {
    expect(computeCatalogSnapshotVersion([entry({ versionId: "cv_2" })])).not.toBe(
      computeCatalogSnapshotVersion([entry()]),
    );
  });

  it("changes when only the description changed", () => {
    // Same version id, different reading: Selection built its candidate text
    // from this wording, so a snapshot that looked unchanged would leave a
    // stale index in place.
    const reworded = entry({
      meaning: { ...entry().meaning, description: "결제 실패 사유 정리" },
    });

    expect(computeCatalogSnapshotVersion([reworded])).not.toBe(
      computeCatalogSnapshotVersion([entry()]),
    );
  });

  it("changes when a scope reference moves to a new version", () => {
    const moved = entry({
      scopes: [
        {
          ...scope,
          reference: { scopeId: "scope_payments", scopeVersion: "scpv_b" },
        },
      ],
    });

    expect(computeCatalogSnapshotVersion([moved])).not.toBe(
      computeCatalogSnapshotVersion([entry()]),
    );
  });

  it("does not change when a policy field is written in another key order", () => {
    const reordered = entry({
      policy: { allowedUsage: ["retrieval"], sensitive: false },
    });

    expect(computeCatalogSnapshotVersion([reordered])).toBe(
      computeCatalogSnapshotVersion([entry()]),
    );
  });

  it("reports an empty catalog with a stable version rather than nothing", () => {
    expect(computeCatalogSnapshotVersion([])).toBe(
      computeCatalogSnapshotVersion([]),
    );
    expect(computeCatalogSnapshotVersion([])).not.toBe(
      computeCatalogSnapshotVersion([entry()]),
    );
  });
});

describe("toApprovedCardCatalogSnapshot", () => {
  it("carries the cards and the version that identifies them", () => {
    const snapshot = toApprovedCardCatalogSnapshot([entry()]);

    expect(snapshot.cards).toEqual([entry()]);
    expect(snapshot.catalogSnapshotVersion).toBe(
      computeCatalogSnapshotVersion([entry()]),
    );
  });
});

describe("checkCatalogSnapshotLimits", () => {
  function rules(cards: readonly CardCatalogEntry[]): string[] {
    return checkCatalogSnapshotLimits(cards).map((finding) => finding.rule);
  }

  it("passes a catalog inside every ceiling", () => {
    expect(checkCatalogSnapshotLimits([entry()])).toEqual([]);
  });

  it("passes an empty catalog", () => {
    expect(checkCatalogSnapshotLimits([])).toEqual([]);
  });

  it("refuses more than 10,000 cards", () => {
    const cards = Array.from({ length: 10_001 }, (_value, index) =>
      entry({ cardId: `card_${index}`, versionId: `cv_${index}` }),
    );

    // Refused whole, not trimmed to fit: a catalog missing some Cards answers
    // queries as though it covered everything, and the Card that fell out is
    // invisible precisely because it is gone.
    expect(rules(cards)).toContain("catalog.cardCount");
  });

  it("accepts exactly 10,000 cards", () => {
    const cards = Array.from({ length: 10_000 }, (_value, index) =>
      entry({ cardId: `card_${index}`, versionId: `cv_${index}` }),
    );

    expect(rules(cards)).not.toContain("catalog.cardCount");
  });

  it("refuses a card id longer than 256 code units", () => {
    // The contract identifiers bound the character set but not the length, so
    // this is the only place an oversized token is caught.
    expect(rules([entry({ cardId: `card_${"a".repeat(256)}` })])).toContain(
      "catalog.token",
    );
  });

  it("refuses an oversized version id as well", () => {
    expect(rules([entry({ versionId: `cv_${"a".repeat(256)}` })])).toContain(
      "catalog.token",
    );
  });

  it("refuses a catalog whose canonical JSON passes 64 MiB", () => {
    // One Card carrying a description near the per-Card limit, repeated until
    // the whole snapshot is too large. Grounding allows each one; together they
    // do not fit.
    const description = "가".repeat(1_024);
    const cards = Array.from({ length: 24_000 }, (_value, index) =>
      entry({
        cardId: `card_${index}`,
        versionId: `cv_${index}`,
        meaning: { ...entry().meaning, description },
      }),
    );

    const violated = rules(cards);
    expect(violated).toContain("catalog.canonicalBytes");
  });
});
