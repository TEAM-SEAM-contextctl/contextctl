import { describe, expect, it } from "vitest";

import {
  createContextCard,
  isCardApproved,
  withCardVersions,
  type CardMeaning,
  type CardPolicy,
} from "../../src/domain/context-card.js";
import {
  appendCardVersion,
  promoteCardVersion,
  type CardVersion,
} from "../../src/domain/card-version.js";

const meaning: CardMeaning = {
  description: "환불 불가 상품 안내",
  representativeQuestions: ["환불이 안 되는 상품은 뭐야?"],
  aliases: ["refund exceptions"],
  keywords: ["refund", "exception"],
};

const policy: CardPolicy = { sensitive: false, allowedUsage: ["retrieval"] };

const version: CardVersion = {
  id: "cv_1",
  cardId: "card_1",
  lineage: {
    publicationId: "pub_1",
    observationId: "obs_1",
    knowledgeUnitId: "unit_1",
    scopeRef: { scopeId: "scope_1", scopeVersion: "scpv_a" },
  },
  validationState: "validated",
  createdAt: "2026-07-30T00:00:00.000Z",
};

describe("context card", () => {
  it("is not approved until a validated version is promoted to current", () => {
    const card = createContextCard("card_1", meaning, policy);
    expect(isCardApproved(card)).toBe(false);

    const versionsWithDraft = appendCardVersion(card.versions, version);
    const cardWithDraft = withCardVersions(card, versionsWithDraft);
    expect(isCardApproved(cardWithDraft)).toBe(false);

    const versionsPromoted = promoteCardVersion(versionsWithDraft, version.id);
    const approvedCard = withCardVersions(card, versionsPromoted);
    expect(isCardApproved(approvedCard)).toBe(true);
  });
});
