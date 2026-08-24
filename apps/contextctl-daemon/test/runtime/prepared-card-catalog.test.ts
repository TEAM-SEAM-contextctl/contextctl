import {
  CardCandidateIndex,
  DETERMINISTIC_CARD_SELECTION_PROFILE,
  type ApprovedCard,
  type ApprovedCardCatalog,
  type CardCandidateIndexRequest,
  type CardCandidateIndexStore,
  type CardEmbeddingPort,
} from "@contextctl/selection-delivery";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { describe, expect, it } from "vitest";

import {
  PreparedApprovedCardCatalog,
  RetainingCardCandidateIndexStore,
} from "../../src/runtime/prepared-card-catalog.js";

const embedding: CardEmbeddingPort = { embed: async () => [] };

function card(version: string): ApprovedCard {
  return {
    cardId: "card_payments",
    versionId: version,
    meaning: {
      description: "결제 재시도 정책",
      representativeQuestions: ["결제는 몇 번 재시도하나요?"],
      aliases: ["payments"],
      keywords: ["payment", "retry"],
    },
    policy: { sensitive: false, allowedUsage: ["retrieval"] },
    scopes: [
      {
        kind: "managed_document",
        reference: { scopeId: "scope_payments", scopeVersion: "scpv_1" },
        documentIndex: {
          documentIndexId: "didx_payments",
          sourceId: "src_payments",
          documentId: "doc_payments",
          indexVersion: "idxv_1",
        },
        selection: { kind: "document" },
      },
    ],
  };
}

class MutableCatalog implements ApprovedCardCatalog {
  cards: readonly ApprovedCard[] = [];
  calls = 0;

  async listApprovedCards(): Promise<readonly ApprovedCard[]> {
    this.calls += 1;
    return this.cards;
  }
}

class ControlledIndexStore implements CardCandidateIndexStore {
  calls = 0;
  blockNext = false;
  release: (() => void) | undefined;

  async acquire(request: CardCandidateIndexRequest): Promise<CardCandidateIndex> {
    this.calls += 1;
    if (this.blockNext) {
      this.blockNext = false;
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
    return indexFor(request);
  }
}

function indexFor(request: CardCandidateIndexRequest): CardCandidateIndex {
  return new CardCandidateIndex({
    catalogSnapshotVersion: request.catalogSnapshotVersion,
    profile: request.profile,
    records: request.entries.map((entry) => ({
      cardId: entry.cardId,
      cardVersionId: entry.cardVersionId,
      catalogSnapshotVersion: request.catalogSnapshotVersion,
      selectionTextDigest: entry.selectionTextDigest,
      embeddingProfileId: request.profile.id,
      embeddingProfileVersion: request.profile.version,
      embedding: Array.from({ length: request.profile.dimensions }, () => 0),
    })),
  });
}

describe("PreparedApprovedCardCatalog", () => {
  it("serves the previous complete generation while the replacement builds", async () => {
    const upstream = new MutableCatalog();
    const index = new ControlledIndexStore();
    const prepared = new PreparedApprovedCardCatalog({
      upstream,
      index,
      profile: DETERMINISTIC_CARD_SELECTION_PROFILE,
      embedding,
    });

    upstream.cards = [card("cv_1")];
    await prepared.refresh();
    expect((await prepared.listApprovedCards()).map((item) => item.versionId))
      .toEqual(["cv_1"]);

    upstream.cards = [card("cv_2")];
    index.blockNext = true;
    const refresh = prepared.refresh();
    await Promise.resolve();
    expect(prepared.status.refreshing).toBe(true);
    expect((await prepared.listApprovedCards()).map((item) => item.versionId))
      .toEqual(["cv_1"]);

    index.release?.();
    await refresh;
    expect((await prepared.listApprovedCards()).map((item) => item.versionId))
      .toEqual(["cv_2"]);
  });

  it("records a bounded diagnostic without discarding the active generation", async () => {
    const upstream = new MutableCatalog();
    const index: CardCandidateIndexStore = {
      acquire: async () => {
        throw new Error("secret provider response");
      },
    };
    const prepared = new PreparedApprovedCardCatalog({
      upstream,
      index,
      profile: DETERMINISTIC_CARD_SELECTION_PROFILE,
      embedding,
    });

    await expect(prepared.refresh()).rejects.toThrow("secret provider response");
    expect(prepared.status).toEqual({
      refreshing: false,
      lastFailureCode: "card_candidate_refresh_failed",
    });
    expect(await prepared.listApprovedCards()).toEqual([]);
  });

  it("coalesces passive polling while explicit refresh remains immediate", async () => {
    const upstream = new MutableCatalog();
    const index = new ControlledIndexStore();
    let now = 1_000;
    const prepared = new PreparedApprovedCardCatalog({
      upstream,
      index,
      profile: DETERMINISTIC_CARD_SELECTION_PROFILE,
      embedding,
      passiveRefreshIntervalMs: 250,
      now: () => now,
    });

    upstream.cards = [card("cv_1")];
    await prepared.refresh();
    expect(upstream.calls).toBe(1);
    await prepared.listApprovedCards();
    await prepared.listApprovedCards();
    expect(upstream.calls).toBe(1);

    now += 249;
    await prepared.listApprovedCards();
    expect(upstream.calls).toBe(1);
    now += 1;
    await prepared.listApprovedCards();
    await yieldToEventLoop();
    expect(upstream.calls).toBe(2);

    await prepared.refresh();
    expect(upstream.calls).toBe(3);
  });

  it("refuses an invalid passive refresh interval", () => {
    expect(
      () =>
        new PreparedApprovedCardCatalog({
          upstream: new MutableCatalog(),
          index: new ControlledIndexStore(),
          profile: DETERMINISTIC_CARD_SELECTION_PROFILE,
          embedding,
          passiveRefreshIntervalMs: -1,
        }),
    ).toThrow(/non-negative/);
  });
});

describe("RetainingCardCandidateIndexStore", () => {
  it("keeps the previous immutable generation after building the next", async () => {
    const inner = new ControlledIndexStore();
    const retaining = new RetainingCardCandidateIndexStore(inner);
    const first = request("snapshot-1", card("cv_1"));
    const second = request("snapshot-2", card("cv_2"));

    await retaining.acquire(first);
    await retaining.acquire(second);
    await retaining.acquire(first);

    expect(inner.calls).toBe(2);
  });
});

function request(
  catalogSnapshotVersion: string,
  approved: ApprovedCard,
): CardCandidateIndexRequest {
  return {
    entries: [
      {
        cardId: approved.cardId,
        cardVersionId: approved.versionId,
        text: {
          schema: "card-selection-text-v2",
          description: approved.meaning.description,
          representativeQuestions: [],
          aliases: [],
          keywords: [],
          scopes: [],
        },
        payload: approved.meaning.description,
        selectionTextDigest: `sha256:${"a".repeat(64)}`,
        units: approved.meaning.description.length,
      },
    ],
    catalogSnapshotVersion,
    profile: DETERMINISTIC_CARD_SELECTION_PROFILE,
    embedding,
  };
}
