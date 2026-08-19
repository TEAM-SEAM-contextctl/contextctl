import type {
  PublishedChangedFieldV2 as PublishedChangedField,
  PublishedChangeV2 as PublishedChange,
  PublishedKnowledgeUnitV2 as PublishedKnowledgeUnit,
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
      updated("unit_unrelated", ["facts"]),
      undefined,
    );

    expect(impact).toEqual({
      cardId: "unit_payment_failures",
      decision: "none",
      reasons: [],
    });
  });

  it("marks an edited paragraph for review", () => {
    const impact = analyzeCardImpact(
      createDocumentCardVersion(),
      updated("unit_payment_failures", ["facts"]),
      onlyUnit(createIngestionPublicationFixture()),
    );

    expect(impact.decision).toBe("review");
    expect(rules(impact)).toEqual(["change.facts"]);
  });

  it("disables a card whose document was deleted", () => {
    const impact = analyzeCardImpact(
      createDocumentCardVersion(),
      removed("unit_payment_failures"),
      undefined,
    );

    expect(impact.decision).toBe("disable");
    expect(rules(impact)).toEqual(["change.removed"]);
  });

  it("disables a card whose API operation was deleted", () => {
    const impact = analyzeCardImpact(
      createHttpCardVersion(),
      removed("unit_get_payment"),
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
      updated("unit_payments_table", ["source.coordinate"]),
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
      updated("unit_payments_table", ["source.coordinate"]),
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
      updated("unit_payment_failures", ["facts"]),
      onlyUnit(createIngestionPublicationFixture()),
    );

    expect(impact.decision).toBe("review");
    expect(rules(impact)).toContain("scope.document.indexVersionChanged");
  });

  it("blocks a card whose table was replaced by another coordinate kind", () => {
    const impact = analyzeCardImpact(
      createSqlCardVersion(),
      updated("unit_payments_table", ["kind"]),
      {
        ...onlyUnit(createHttpPublicationFixture()),
        id: "unit_payments_table",
      },
    );

    expect(impact.decision).toBe("block");
    expect(rules(impact)).toEqual(["scope.kindDrift"]);
  });

  it("blocks when an added or updated unit is missing from the publication", () => {
    const impact = analyzeCardImpact(
      createDocumentCardVersion(),
      updated("unit_payment_failures", ["facts"]),
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
        knowledgeUnitId: "unit_payment_failures",
        currentContentDigest: digest,
      },
      onlyUnit(createIngestionPublicationFixture()),
    );

    expect(impact).toEqual({
      cardId: "unit_payment_failures",
      decision: "none",
      reasons: [],
    });
  });

  it("is deterministic: the same input yields the same decision", () => {
    const version = createSqlCardVersion();
    const change = updated("unit_payments_table", ["source.coordinate"]);
    const unit = onlyUnit(createSqlPublicationFixture());

    expect(analyzeCardImpact(version, change, unit)).toEqual(
      analyzeCardImpact(version, change, unit),
    );
  });
});
