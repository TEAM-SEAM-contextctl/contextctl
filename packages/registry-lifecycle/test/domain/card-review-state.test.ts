import { describe, expect, it } from "vitest";

import {
  pendingReviewCardVersionIds,
  type CardVersion,
  type CardVersionHistory,
  type LifecycleEvent,
} from "../../src/index.js";

function version(
  id: string,
  validationState: CardVersion["validationState"] = "validated",
): CardVersion {
  return {
    id,
    cardId: "card_review",
    lineage: {
      publicationId: `pub_${id}`,
      observationId: `obs_${id}`,
      knowledgeUnitId: "unit_review",
    },
    scopes: [],
    validationState,
    createdAt: "2026-08-27T00:00:00.000Z",
  };
}

function history(
  versions: readonly CardVersion[],
  currentVersionId?: string,
): CardVersionHistory {
  return {
    cardId: "card_review",
    versions,
    currentVersionId,
  };
}

function promoted(
  versionId: string,
  cardId: string = "card_review",
): LifecycleEvent {
  return {
    id: `event_promoted_${versionId}`,
    kind: "card_version_promoted",
    cardId,
    occurredAt: "2026-08-27T00:00:00.000Z",
    versionId,
    previousVersionId: undefined,
    decidedBy: "operator",
    note: undefined,
  };
}

function refused(versionId: string): LifecycleEvent {
  return {
    id: `event_refused_${versionId}`,
    kind: "card_version_refused",
    cardId: "card_review",
    occurredAt: "2026-08-27T00:00:00.000Z",
    versionId,
    decidedBy: "operator",
    note: undefined,
  };
}

describe("pendingReviewCardVersionIds", () => {
  it("returns only validated versions after the reviewed frontier", () => {
    const versions = [
      version("cv_1"),
      version("cv_2"),
      version("cv_3", "rejected"),
      version("cv_4"),
    ];

    expect(
      pendingReviewCardVersionIds(history(versions, "cv_1"), [
        promoted("cv_1"),
        refused("cv_2"),
      ]),
    ).toEqual(["cv_4"]);
  });

  it("does not resurface an older undecided version after a newer promotion", () => {
    const versions = [version("cv_1"), version("cv_2"), version("cv_3")];

    expect(
      pendingReviewCardVersionIds(history(versions, "cv_1"), [
        promoted("cv_3"),
        promoted("cv_1"),
      ]),
    ).toEqual([]);
  });

  it("treats a legacy current pointer as reviewed without an event", () => {
    expect(
      pendingReviewCardVersionIds(
        history([version("cv_1"), version("cv_2")], "cv_2"),
        [],
      ),
    ).toEqual([]);
  });

  it("ignores lifecycle events that belong to another Card", () => {
    expect(
      pendingReviewCardVersionIds(history([version("cv_1")]), [
        promoted("cv_1", "card_other"),
      ]),
    ).toEqual(["cv_1"]);
  });
});
