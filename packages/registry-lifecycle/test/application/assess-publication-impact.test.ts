import {
  computePublishedKnowledgeUnitDigest,
  parseIngestionPublication,
  type IngestionPublication,
} from "@contextctl/contracts";
import { describe, expect, it } from "vitest";

import {
  assessPublicationImpact,
  type AssessPublicationImpactPorts,
} from "../../src/application/assess-publication-impact.js";
import type { CardVersion } from "../../src/domain/card-version.js";
import {
  createDocumentCardVersion,
  createHttpCardVersion,
} from "../fixtures/card-version.fixture.js";
import {
  createIngestionPublicationFixture,
  fixtureRootId,
} from "../fixtures/ingestion-publication.fixture.js";

// Taken from the fixture rather than written down: v2 refuses a unit whose
// digest is not the canonical digest of its own content, so a change fixture
// cannot name two digests it made up.
const initialUnit = (() => {
  const unit = createIngestionPublicationFixture().knowledgeUnits[0];
  if (unit === undefined) {
    throw new Error("fixture must publish one knowledge unit");
  }
  return unit;
})();
const digest = initialUnit.contentDigest;

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
  // The edit is real: one observed fact reads differently, which is what makes
  // the digest differ. Stamping a new digest onto identical content would be
  // refused, and would also describe a publication Ingestion cannot produce.
  const { contentDigest: _previous, ...content } = initialUnit;
  const edited = {
    ...content,
    facts: [
      { name: "section.label" as const, value: "Payment failures, revised" },
    ],
  };
  const unit = {
    ...edited,
    contentDigest: computePublishedKnowledgeUnitDigest(edited),
  };

  return parseIngestionPublication({
    ...initial,
    publicationId: fixtureRootId("pub", "second"),
    previousPublicationId: fixtureRootId("pub", "initial"),
    knowledgeUnits: [unit],
    changes: [
      {
        kind: "updated",
        knowledgeUnitId: "unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd",
        previousContentDigest: digest,
        currentContentDigest: unit.contentDigest,
        changedFields: ["facts"],
      },
    ],
  });
}

/** Publication that records the document being deleted. */
function createRemovalPublication(): IngestionPublication {
  const initial = createIngestionPublicationFixture();

  return parseIngestionPublication({
    ...initial,
    publicationId: fixtureRootId("pub", "removal"),
    previousPublicationId: fixtureRootId("pub", "initial"),
    knowledgeUnits: [],
    changes: [
      {
        kind: "removed",
        knowledgeUnitId: "unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd",
        previousContentDigest: digest,
      },
    ],
  });
}

const NEIGHBOUR_UNIT_ID = "unit_01890f5c-7b1a-7684-8f82-b5950cf2b0de";

/**
 * A deletion that also rebuilt the document index the deleted unit lived in.
 *
 * The realistic shape of deleting a section: the section's unit goes away, and
 * the rest of the document is republished against a new index version. The
 * neighbour keeps its Card, and the question is whether that Card may keep
 * serving the version it was approved on.
 */
function createRemovalWithRebuildPublication(): IngestionPublication {
  const initial = createIngestionPublicationFixture();
  const { contentDigest: _previous, ...content } = initialUnit;
  const publishedScope = content.publishedScopes[0];
  if (publishedScope?.kind !== "managed_document") {
    throw new Error("fixture must publish a managed document scope");
  }
  const neighbourContent = {
    ...content,
    id: NEIGHBOUR_UNIT_ID,
    sourceCoordinate: {
      ...content.sourceCoordinate,
      semanticUnitId: NEIGHBOUR_UNIT_ID,
    },
    publishedScopes: [
      {
        ...publishedScope,
        scopeId: "scope_shipping",
        scopeVersion: "scpv_bbbb",
        documentIndex: {
          ...publishedScope.documentIndex,
          indexVersion: "idxv_bbbb",
        },
        selector: {
          kind: "semantic_units" as const,
          semanticUnitIds: [NEIGHBOUR_UNIT_ID],
        },
      },
    ],
  };
  const neighbour = {
    ...neighbourContent,
    contentDigest: computePublishedKnowledgeUnitDigest(neighbourContent),
  };

  return parseIngestionPublication({
    ...initial,
    publicationId: fixtureRootId("pub", "removal-rebuild"),
    previousPublicationId: fixtureRootId("pub", "initial"),
    knowledgeUnits: [neighbour],
    changes: [
      {
        kind: "removed",
        knowledgeUnitId: "unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd",
        previousContentDigest: digest,
      },
      {
        kind: "updated",
        knowledgeUnitId: NEIGHBOUR_UNIT_ID,
        previousContentDigest: digest,
        currentContentDigest: neighbour.contentDigest,
        changedFields: ["published.scopes"],
      },
    ],
  });
}

/** The neighbour's Card, still serving the index version the deletion replaced. */
function createNeighbourCardVersion(): CardVersion {
  const base = createDocumentCardVersion();
  const [scope] = base.scopes;
  if (scope?.kind !== "managed_document") {
    throw new Error("fixture must carry a managed document scope");
  }
  return {
    ...base,
    id: "cv_neighbour",
    cardId: NEIGHBOUR_UNIT_ID,
    lineage: { ...base.lineage, knowledgeUnitId: NEIGHBOUR_UNIT_ID },
    scopes: [
      {
        ...scope,
        reference: { scopeId: "scope_shipping", scopeVersion: "scpv_aaaa" },
        selection: {
          kind: "semantic_units",
          semanticUnitIds: [NEIGHBOUR_UNIT_ID],
        },
      },
    ],
  };
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
        cardId: "unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd",
        decision: "review",
        reasons: [
          {
            rule: "change.facts",
            message:
              "knowledge unit unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd: the observed facts the card text was written from are no longer the same",
          },
        ],
      },
    ]);
    expect(result.events).toEqual([
      {
        id: "ev_1",
        kind: "card_impact_assessed",
        cardId: "unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd",
        occurredAt: "2026-08-03T00:00:00.000Z",
        publicationId: fixtureRootId("pub", "second"),
        decision: "review",
        reasons: [
          {
            rule: "change.facts",
            message:
              "knowledge unit unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd: the observed facts the card text was written from are no longer the same",
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

  it("blocks a neighbour left on the index version the deletion replaced", () => {
    // The removed unit is absent from the Publication, so the document index it
    // lived in is only knowable from the Card that was serving it. That is the
    // derivation under test: without it the neighbour would be a plain review
    // and would keep answering from an index version that still holds the
    // deleted section. ADR 0005.
    const result = assessPublicationImpact(
      createPorts(),
      createRemovalWithRebuildPublication(),
      [createDocumentCardVersion(), createNeighbourCardVersion()],
    );

    expect(
      result.impacts.map((impact) => [impact.cardId, impact.decision]),
    ).toEqual([
      ["unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd", "disable"],
      [NEIGHBOUR_UNIT_ID, "block"],
    ]);
    expect(
      result.impacts[1]?.reasons.map((reason) => reason.rule),
    ).toEqual(["scope.document.indexVersionSupersededByRemoval"]);
  });

  it("leaves unrelated cards untouched and emits no event for them", () => {
    const result = assessPublicationImpact(
      createPorts(),
      createUpdatePublication(),
      [createDocumentCardVersion(), createHttpCardVersion()],
    );

    expect(result.impacts.map((impact) => impact.cardId)).toEqual([
      "unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd",
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
