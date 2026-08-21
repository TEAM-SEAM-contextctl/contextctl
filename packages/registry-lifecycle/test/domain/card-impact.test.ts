import type {
  PublishedChangedField,
  PublishedChange,
  PublishedKnowledgeUnit,
} from "@contextctl/contracts";
import { describe, expect, it } from "vitest";

import { analyzeCardImpact } from "../../src/domain/card-impact.js";
import {
  createDocumentCardVersion,
  createHttpCardVersion,
  createSqlCardVersion,
} from "../fixtures/card-version.fixture.js";
import {
  createHttpPublicationFixture,
  createIngestionPublicationFixture,
  createSqlPublicationFixture,
} from "../fixtures/ingestion-publication.fixture.js";

const digest =
  "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const changedDigest =
  "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

function onlyUnit(
  publication: ReturnType<typeof createIngestionPublicationFixture>,
): PublishedKnowledgeUnit {
  const unit = publication.knowledgeUnits[0];
  if (unit === undefined) {
    throw new Error("fixture must publish one knowledge unit");
  }
  return unit;
}

function updated(
  knowledgeUnitId: string,
  // v2 closed this vocabulary, so a change can no longer name a field the
  // contract does not have.
  changedFields: readonly PublishedChangedField[],
): PublishedChange {
  return {
    kind: "updated",
    knowledgeUnitId,
    previousContentDigest: digest,
    currentContentDigest: changedDigest,
    changedFields: [...changedFields],
  };
}

function removed(knowledgeUnitId: string): PublishedChange {
  return { kind: "removed", knowledgeUnitId, previousContentDigest: digest };
}

function rules(impact: ReturnType<typeof analyzeCardImpact>): string[] {
  return impact.reasons.map((reason) => reason.rule);
}

describe("analyzeCardImpact", () => {
  it("ignores a change that belongs to another knowledge unit", () => {
    const impact = analyzeCardImpact(
      createDocumentCardVersion(),
      updated("unit_01890f5c-7b1a-7da8-8d34-611484d6d2b0", ["facts"]),
      undefined,
    );

    expect(impact).toEqual({
      cardId: "unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd",
      decision: "none",
      reasons: [],
    });
  });

  it("marks an edited paragraph for review", () => {
    const impact = analyzeCardImpact(
      createDocumentCardVersion(),
      updated("unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd", ["facts"]),
      onlyUnit(createIngestionPublicationFixture()),
    );

    expect(impact.decision).toBe("review");
    expect(rules(impact)).toEqual(["change.facts"]);
  });

  it("disables a card whose document was deleted", () => {
    const impact = analyzeCardImpact(
      createDocumentCardVersion(),
      removed("unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd"),
      undefined,
    );

    expect(impact.decision).toBe("disable");
    expect(rules(impact)).toEqual(["change.removed"]);
  });

  it("disables a card whose API operation was deleted", () => {
    const impact = analyzeCardImpact(
      createHttpCardVersion(),
      removed("unit_01890f5c-7b1a-7e07-8297-3b51cb4b4083"),
      undefined,
    );

    expect(impact.decision).toBe("disable");
    expect(rules(impact)).toEqual(["change.removed"]);
  });

  it("marks an added DB column for review without touching the card scope", () => {
    // The observation now exposes an extra column the card never referenced.
    const publication = createSqlPublicationFixture();
    const unit = onlyUnit(publication);
    const widened: PublishedKnowledgeUnit = {
      ...unit,
      sourceCoordinate: {
        ...unit.sourceCoordinate,
        kind: "sql_table",
        columns: ["amount", "created_at", "failed_reason", "status"],
      } as PublishedKnowledgeUnit["sourceCoordinate"],
    };

    const impact = analyzeCardImpact(
      createSqlCardVersion(),
      updated("unit_01890f5c-7b1a-784f-8ec3-8cba518ce3ba", ["source.coordinate"]),
      widened,
    );

    expect(impact.decision).toBe("review");
    expect(rules(impact)).toEqual(["change.sourceCoordinate"]);
  });

  it("blocks a card that referenced a DB column the source dropped", () => {
    const publication = createSqlPublicationFixture();
    const unit = onlyUnit(publication);
    const narrowed: PublishedKnowledgeUnit = {
      ...unit,
      sourceCoordinate: {
        ...unit.sourceCoordinate,
        kind: "sql_table",
        columns: ["created_at", "status"],
      } as PublishedKnowledgeUnit["sourceCoordinate"],
    };

    const impact = analyzeCardImpact(
      createSqlCardVersion(),
      updated("unit_01890f5c-7b1a-784f-8ec3-8cba518ce3ba", ["source.coordinate"]),
      narrowed,
    );

    expect(impact.decision).toBe("block");
    expect(rules(impact)).toEqual(["scope.sql.columnRemoved"]);
    expect(impact.reasons[0]?.message).toContain("failed_reason");
  });

  it("marks a rebuilt document index for review", () => {
    // The card was grounded against idxv_aaaa; the publication now serves a
    // freshly generated index, which is how an embedding model change surfaces.
    const impact = analyzeCardImpact(
      createDocumentCardVersion({ indexVersion: "idxv_zzzz" }),
      updated("unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd", ["facts"]),
      onlyUnit(createIngestionPublicationFixture()),
    );

    expect(impact.decision).toBe("review");
    expect(rules(impact)).toContain("scope.document.indexVersionChanged");
  });

  it("blocks a rebuilt index the same publication removed knowledge from", () => {
    // Same drift as the case above, and a different decision, because nothing
    // purges a published index version: the version this Card is left on still
    // holds the section the source deleted, so serving it answers from content
    // that no longer exists. ADR 0005.
    const impact = analyzeCardImpact(
      createDocumentCardVersion({ indexVersion: "idxv_zzzz" }),
      updated("unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd", ["facts"]),
      onlyUnit(createIngestionPublicationFixture()),
      { documentIndexesWithRemovals: new Set(["didx_payments"]) },
    );

    expect(impact.decision).toBe("block");
    expect(rules(impact)).toContain(
      "scope.document.indexVersionSupersededByRemoval",
    );
    // One cause, one reason: the plain drift rule must not also be reported.
    expect(rules(impact)).not.toContain("scope.document.indexVersionChanged");
  });

  it("leaves a rebuilt index alone when another document lost knowledge", () => {
    // The set is keyed by document index for a reason — a deletion in one
    // document cannot make another document's Card unsafe to serve.
    const impact = analyzeCardImpact(
      createDocumentCardVersion({ indexVersion: "idxv_zzzz" }),
      updated("unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd", ["facts"]),
      onlyUnit(createIngestionPublicationFixture()),
      { documentIndexesWithRemovals: new Set(["didx_shipping"]) },
    );

    expect(impact.decision).toBe("review");
    expect(rules(impact)).toContain("scope.document.indexVersionChanged");
  });

  it("blocks a card whose table was replaced by another coordinate kind", () => {
    const impact = analyzeCardImpact(
      createSqlCardVersion(),
      updated("unit_01890f5c-7b1a-784f-8ec3-8cba518ce3ba", ["kind"]),
      {
        ...onlyUnit(createHttpPublicationFixture()),
        id: "unit_01890f5c-7b1a-784f-8ec3-8cba518ce3ba",
      },
    );

    expect(impact.decision).toBe("block");
    expect(rules(impact)).toEqual(["scope.kindDrift"]);
  });

  it("blocks when an added or updated unit is missing from the publication", () => {
    const impact = analyzeCardImpact(
      createDocumentCardVersion(),
      updated("unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd", ["facts"]),
      undefined,
    );

    expect(impact.decision).toBe("block");
    expect(rules(impact)).toEqual(["change.unitMissing"]);
  });

  it("reports no impact when nothing the card depends on moved", () => {
    const impact = analyzeCardImpact(
      createDocumentCardVersion(),
      {
        kind: "added",
        knowledgeUnitId: "unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd",
        currentContentDigest: digest,
      },
      onlyUnit(createIngestionPublicationFixture()),
    );

    expect(impact).toEqual({
      cardId: "unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd",
      decision: "none",
      reasons: [],
    });
  });

  /**
   * Every `changedFields` name, judged one at a time.
   *
   * The vocabulary is closed, so this table can be exhaustive — and it has to be:
   * the rule table in `card-impact.ts` enumerates all five, and a name that fell
   * through would decide nothing while still looking handled. `provenance` is
   * listed here with no rule on purpose. It records how the observation was
   * produced, and treating a policy-version bump as staleness would flag every
   * Card on every rebuild.
   */
  it.each([
    ["facts", "change.facts"],
    ["kind", "change.kind"],
    ["published.scopes", "change.publishedScopes"],
    ["source.coordinate", "change.sourceCoordinate"],
  ] as const)("reports %s as %s", (field, rule) => {
    const impact = analyzeCardImpact(
      createDocumentCardVersion(),
      updated("unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd", [field]),
      onlyUnit(createIngestionPublicationFixture()),
    );

    expect(impact.decision).toBe("review");
    expect(rules(impact)).toEqual([rule]);
  });

  it("reports nothing for a provenance-only change", () => {
    const impact = analyzeCardImpact(
      createDocumentCardVersion(),
      updated("unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd", ["provenance"]),
      onlyUnit(createIngestionPublicationFixture()),
    );

    expect(impact).toEqual({
      cardId: "unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd",
      decision: "none",
      reasons: [],
    });
  });

  it("reports a rebuilt index once, not twice under two names", () => {
    // `documentIndex` lives inside a published Scope, so re-indexing moves
    // `indexVersion` and sets `published.scopes` at the same time. Both are true,
    // and reporting both would tell an operator there are two things to look
    // into. The drift reason survives because it names the index and the versions
    // it moved between; the declared field name only says something differs.
    const impact = analyzeCardImpact(
      createDocumentCardVersion({ indexVersion: "idxv_zzzz" }),
      updated("unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd", ["published.scopes"]),
      onlyUnit(createIngestionPublicationFixture()),
    );

    expect(impact.decision).toBe("review");
    expect(rules(impact)).toEqual(["scope.document.indexVersionChanged"]);
  });

  it("still reports a scope change that moved no index version", () => {
    // The suppression above is narrow. With no drift to report, the declared
    // change is the only thing that would tell an operator the range moved.
    const impact = analyzeCardImpact(
      createDocumentCardVersion(),
      updated("unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd", ["published.scopes"]),
      onlyUnit(createIngestionPublicationFixture()),
    );

    expect(rules(impact)).toEqual(["change.publishedScopes"]);
  });

  it("is deterministic: the same input yields the same decision", () => {
    const version = createSqlCardVersion();
    const change = updated("unit_01890f5c-7b1a-784f-8ec3-8cba518ce3ba", ["source.coordinate"]);
    const unit = onlyUnit(createSqlPublicationFixture());

    expect(analyzeCardImpact(version, change, unit)).toEqual(
      analyzeCardImpact(version, change, unit),
    );
  });
});
