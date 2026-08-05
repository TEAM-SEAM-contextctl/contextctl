import { describe, expect, it } from "vitest";

import { toCardCatalogEntry } from "../../src/domain/card-catalog.js";
import {
  appendCardVersion,
  promoteCardVersion,
  withdrawCurrentVersion,
} from "../../src/domain/card-version.js";
import {
  createContextCard,
  withCardVersions,
  type ContextCard,
} from "../../src/domain/context-card.js";
import { createDocumentCardVersion } from "../fixtures/card-version.fixture.js";

const meaning = {
  description: "결제 실패 재시도 정책",
  representativeQuestions: ["결제가 실패하면 언제 재시도되나요?"],
  aliases: ["payment retry"],
  keywords: ["payment", "retry"],
};

const policy = { sensitive: false, allowedUsage: ["retrieval"] };

function cardWithVersion(): ContextCard {
  const card = createContextCard("unit_payment_failures", meaning, policy);
  return withCardVersions(
    card,
    appendCardVersion(card.versions, createDocumentCardVersion()),
  );
}

describe("toCardCatalogEntry", () => {
  it("projects a serving card into the catalog", () => {
    const card = cardWithVersion();
    const serving = withCardVersions(
      card,
      promoteCardVersion(card.versions, "cv_document"),
    );

    expect(toCardCatalogEntry(serving)).toEqual({
      cardId: "unit_payment_failures",
      versionId: "cv_document",
      meaning,
      policy,
      scopes: createDocumentCardVersion().scopes,
    });
  });

  it("omits a card that was never approved", () => {
    expect(toCardCatalogEntry(cardWithVersion())).toBeUndefined();
  });

  it("omits a card whose current version was withdrawn", () => {
    const card = cardWithVersion();
    const serving = withCardVersions(
      card,
      promoteCardVersion(card.versions, "cv_document"),
    );
    const withdrawn = withCardVersions(
      serving,
      withdrawCurrentVersion(serving.versions),
    );

    expect(toCardCatalogEntry(withdrawn)).toBeUndefined();
  });

  it("exposes no version history, validation state, or lineage", () => {
    const card = cardWithVersion();
    const serving = withCardVersions(
      card,
      promoteCardVersion(card.versions, "cv_document"),
    );

    const entry = toCardCatalogEntry(serving);
    expect(Object.keys(entry ?? {}).sort()).toEqual([
      "cardId",
      "meaning",
      "policy",
      "scopes",
      "versionId",
    ]);
    expect(JSON.stringify(entry)).not.toContain("validationState");
    expect(JSON.stringify(entry)).not.toContain("lineage");
  });
});
