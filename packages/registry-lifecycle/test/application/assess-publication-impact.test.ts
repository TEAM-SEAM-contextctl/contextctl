import {
  parseIngestionPublication,
  type IngestionPublication,
} from "@contextctl/contracts";
import { describe, expect, it } from "vitest";

import {
  assessPublicationImpact,
  type AssessPublicationImpactPorts,
} from "../../src/application/assess-publication-impact.js";
import {
  createDocumentCardVersion,
  createHttpCardVersion,
} from "../fixtures/card-version.fixture.js";
import { createIngestionPublicationFixture } from "../fixtures/ingestion-publication.fixture.js";

const digest =
  "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const changedDigest =
  "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

function createPorts(): AssessPublicationImpactPorts {
  let nextId = 0;
  return {
    clock: { now: () => "2026-08-03T00:00:00.000Z" },
    ids: {
      nextId: () => {
        nextId += 1;
        return `ev_${nextId}`;
      },
    },
  };
}

/** Second publication for the same document, carrying an updated paragraph. */
function createUpdatePublication(): IngestionPublication {
  const initial = createIngestionPublicationFixture();
  const unit = initial.knowledgeUnits[0];
  if (unit === undefined) {
    throw new Error("fixture must publish one knowledge unit");
  }

  return parseIngestionPublication({
    ...initial,
    publicationId: "pub_second",
    previousPublicationId: "pub_initial",
    knowledgeUnits: [{ ...unit, contentDigest: changedDigest }],
    changes: [
      {
        kind: "updated",
        knowledgeUnitId: "unit_payment_failures",
        previousContentDigest: digest,
        currentContentDigest: changedDigest,
        changedFields: ["content"],
      },
    ],
  });
}

/** Publication that records the document being deleted. */
function createRemovalPublication(): IngestionPublication {
  const initial = createIngestionPublicationFixture();

  return parseIngestionPublication({
    ...initial,
    publicationId: "pub_removal",
    previousPublicationId: "pub_initial",
    knowledgeUnits: [],
    changes: [
      {
        kind: "removed",
        knowledgeUnitId: "unit_payment_failures",
        previousContentDigest: digest,
      },
    ],
  });
}

describe("assessPublicationImpact", () => {
  it("marks the affected card for review and records one lifecycle event", () => {
    const result = assessPublicationImpact(
      createPorts(),
      createUpdatePublication(),
      [createDocumentCardVersion()],
    );

    expect(result.impacts).toEqual([
      {
        cardId: "unit_payment_failures",
        decision: "review",
        reasons: [
          {
            rule: "change.updated",
            message: "knowledge unit unit_payment_failures changed content",
          },
        ],
      },
    ]);
    expect(result.events).toEqual([
      {
        id: "ev_1",
        kind: "card_impact_assessed",
        cardId: "unit_payment_failures",
        occurredAt: "2026-08-03T00:00:00.000Z",
        publicationId: "pub_second",
        decision: "review",
        reasons: [
          {
            rule: "change.updated",
            message: "knowledge unit unit_payment_failures changed content",
          },
        ],
      },
    ]);
  });

  it("disables the card when the publication records a deletion", () => {
    const result = assessPublicationImpact(
      createPorts(),
      createRemovalPublication(),
      [createDocumentCardVersion()],
    );

    expect(result.impacts.map((impact) => impact.decision)).toEqual(["disable"]);
    expect(result.events.map((event) => event.kind)).toEqual([
      "card_impact_assessed",
    ]);
  });

  it("leaves unrelated cards untouched and emits no event for them", () => {
    const result = assessPublicationImpact(
      createPorts(),
      createUpdatePublication(),
      [createDocumentCardVersion(), createHttpCardVersion()],
    );

    expect(result.impacts.map((impact) => impact.cardId)).toEqual([
      "unit_payment_failures",
    ]);
    expect(result.events).toHaveLength(1);
  });

  it("returns nothing when no serving card depends on the publication", () => {
    const result = assessPublicationImpact(
      createPorts(),
      createUpdatePublication(),
      [createHttpCardVersion()],
    );

    expect(result).toEqual({ impacts: [], events: [] });
  });

  it("is deterministic across repeated assessments of the same input", () => {
    const publication = createUpdatePublication();
    const versions = [createDocumentCardVersion()];

    expect(
      assessPublicationImpact(createPorts(), publication, versions),
    ).toEqual(assessPublicationImpact(createPorts(), publication, versions));
  });
});
