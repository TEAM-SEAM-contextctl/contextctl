import type {
  CardCandidateIndex,
  CardCandidateIndexRequest,
  CardCandidateIndexStore,
  CardEmbeddingPort,
} from "@contextctl/selection-delivery";
import { DETERMINISTIC_CARD_SELECTION_PROFILE } from "@contextctl/selection-delivery";
import { describe, expect, it } from "vitest";

import { AdmissionLane } from "../../src/runtime/admission.js";
import { LaneBoundCardCandidateIndexStore } from "../../src/runtime/lane-bound-card-candidate-index.js";

describe("LaneBoundCardCandidateIndexStore embedding priority", () => {
  it("replaces only the build request provider with the background view", async () => {
    const queryEmbedding: CardEmbeddingPort = {
      embed: async () => [],
    };
    const backgroundEmbedding: CardEmbeddingPort = {
      embed: async () => [],
    };
    let observed: CardEmbeddingPort | undefined;
    const marker = new Error("observed");
    const inner: CardCandidateIndexStore = {
      acquire: async (
        request: CardCandidateIndexRequest,
      ): Promise<CardCandidateIndex> => {
        observed = request.embedding;
        throw marker;
      },
    };
    const store = new LaneBoundCardCandidateIndexStore(
      inner,
      new AdmissionLane("selection_assets", {
        concurrency: 1,
        queueDepth: 1,
      }),
      backgroundEmbedding,
    );

    await expect(
      store.acquire({
        entries: [],
        catalogSnapshotVersion: "snapshot",
        profile: DETERMINISTIC_CARD_SELECTION_PROFILE,
        embedding: queryEmbedding,
      }),
    ).rejects.toBe(marker);

    expect(observed).toBe(backgroundEmbedding);
  });
});
