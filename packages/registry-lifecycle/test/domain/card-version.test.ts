import { describe, expect, it } from "vitest";

import type { CardLineage } from "../../src/domain/lineage.js";
import {
  appendCardVersion,
  createCardVersionHistory,
  getCurrentCardVersion,
  precedesCurrentCardVersion,
  promoteCardVersion,
  type CardVersion,
} from "../../src/domain/card-version.js";
import { CardVersionInvariantError } from "../../src/domain/errors.js";
import type { RetrievalScope } from "../../src/domain/retrieval-scope.js";

const lineage: CardLineage = {
  publicationId: "pub_1",
  observationId: "obs_1",
  knowledgeUnitId: "unit_1",
};

const scopes: readonly RetrievalScope[] = [
  {
    kind: "sql_source",
    reference: { scopeId: "scope_1", scopeVersion: "scpv_a" },
    connector: "postgres.main",
    schema: "public",
    table: "payments",
    columns: ["status"],
  },
];

function buildVersion(
  cardId: string,
  id: string,
  validationState: CardVersion["validationState"],
): CardVersion {
  return {
    id,
    cardId,
    lineage,
    scopes,
    validationState,
    createdAt: "2026-07-30T00:00:00.000Z",
  };
}

describe("card version history", () => {
  it("appends a validated version and promotes it to current", () => {
    let history = createCardVersionHistory("card_1");
    const version = buildVersion("card_1", "cv_1", "validated");

    history = appendCardVersion(history, version);
    history = promoteCardVersion(history, version.id);

    expect(getCurrentCardVersion(history)).toEqual(version);
  });

  it("keeps last-known-good current when a new version fails validation", () => {
    let history = createCardVersionHistory("card_1");
    const good = buildVersion("card_1", "cv_1", "validated");
    const rejected = buildVersion("card_1", "cv_2", "rejected");

    history = appendCardVersion(history, good);
    history = promoteCardVersion(history, good.id);
    history = appendCardVersion(history, rejected);

    expect(() => promoteCardVersion(history, rejected.id)).toThrow(
      CardVersionInvariantError,
    );
    expect(getCurrentCardVersion(history)).toEqual(good);
  });

  it("rolls back current pointer to a prior validated version", () => {
    let history = createCardVersionHistory("card_1");
    const first = buildVersion("card_1", "cv_1", "validated");
    const second = buildVersion("card_1", "cv_2", "validated");

    history = appendCardVersion(history, first);
    history = promoteCardVersion(history, first.id);
    history = appendCardVersion(history, second);
    history = promoteCardVersion(history, second.id);
    history = promoteCardVersion(history, first.id);

    expect(getCurrentCardVersion(history)).toEqual(first);
    expect(history.versions).toEqual([first, second]);
  });

  it("rejects appending a version whose id already exists", () => {
    let history = createCardVersionHistory("card_1");
    const version = buildVersion("card_1", "cv_1", "validated");
    history = appendCardVersion(history, version);

    expect(() => appendCardVersion(history, version)).toThrow(
      CardVersionInvariantError,
    );
  });

  it("rejects appending a version that belongs to a different card", () => {
    const history = createCardVersionHistory("card_1");
    const foreignVersion = buildVersion("card_2", "cv_1", "validated");

    expect(() => appendCardVersion(history, foreignVersion)).toThrow(
      CardVersionInvariantError,
    );
  });

  it("rejects promoting a version that is not part of the history", () => {
    const history = createCardVersionHistory("card_1");

    expect(() => promoteCardVersion(history, "cv_missing")).toThrow(
      CardVersionInvariantError,
    );
  });

  describe("precedesCurrentCardVersion", () => {
    function historyOf(currentId: string) {
      let history = createCardVersionHistory("card_1");
      for (const id of ["cv_1", "cv_2", "cv_3"]) {
        history = appendCardVersion(
          history,
          buildVersion("card_1", id, "validated"),
        );
      }
      return promoteCardVersion(history, currentId);
    }

    it("sees an earlier version as preceding the current one", () => {
      expect(precedesCurrentCardVersion(historyOf("cv_3"), "cv_1")).toBe(true);
    });

    it("does not treat the current version as preceding itself", () => {
      expect(precedesCurrentCardVersion(historyOf("cv_2"), "cv_2")).toBe(false);
    });

    it("does not treat a later version as preceding", () => {
      expect(precedesCurrentCardVersion(historyOf("cv_2"), "cv_3")).toBe(false);
    });

    it("answers false when the Card serves nothing", () => {
      // Nothing is current, so there is no "back" to compare against.
      let history = createCardVersionHistory("card_1");
      history = appendCardVersion(
        history,
        buildVersion("card_1", "cv_1", "validated"),
      );

      expect(precedesCurrentCardVersion(history, "cv_1")).toBe(false);
    });

    it("answers false for a version outside the history", () => {
      expect(precedesCurrentCardVersion(historyOf("cv_2"), "cv_missing")).toBe(
        false,
      );
    });
  });
});
