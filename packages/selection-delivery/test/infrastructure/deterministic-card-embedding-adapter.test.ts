import { describe, expect, it } from "vitest";

import { cosineSimilarity } from "../../src/domain/card-candidate-index.js";
import {
  assertCardEmbeddingProviderKind,
  DeterministicCardEmbeddingAdapter,
} from "../../src/infrastructure/deterministic-card-embedding-adapter.js";
import { CardEmbeddingFault } from "../../src/ports/card-embedding.js";
import { TEST_CARD_PROFILE } from "../fixtures/card-embedding.fixture.js";

const adapter = new DeterministicCardEmbeddingAdapter();

function embed(texts: readonly string[]) {
  return adapter.embed({
    profile: TEST_CARD_PROFILE,
    inputs: texts.map((text, index) => ({ key: `k${index}`, text })),
  });
}

describe("DeterministicCardEmbeddingAdapter", () => {
  it("answers in the width the profile declares", async () => {
    const [output] = await embed(["연차 규정"]);

    expect(output?.vector).toHaveLength(TEST_CARD_PROFILE.dimensions);
  });

  it("returns unit vectors, as the profile's l2 normalization requires", async () => {
    const [output] = await embed(["연차 규정"]);
    const magnitude = Math.sqrt(
      (output?.vector ?? []).reduce((sum, part) => sum + part * part, 0),
    );

    expect(magnitude).toBeCloseTo(1, 10);
  });

  it("gives the same text the same vector on every call", async () => {
    const [first] = await embed(["연차 규정"]);
    const [second] = await embed(["연차 규정"]);

    expect(second?.vector).toEqual(first?.vector);
  });

  it("echoes the caller's keys rather than relying on position", async () => {
    const outputs = await embed(["a", "b"]);

    expect(outputs.map((output) => output.key)).toEqual(["k0", "k1"]);
  });

  it("separates two vector families that share a text", async () => {
    const [here] = await embed(["연차 규정"]);
    const [elsewhere] = await adapter.embed({
      profile: { ...TEST_CARD_PROFILE, id: "card-other-v1" },
      inputs: [{ key: "k0", text: "연차 규정" }],
    });

    expect(elsewhere?.vector).not.toEqual(here?.vector);
  });

  /**
   * The limit of what this adapter can prove, stated as a test.
   *
   * Two paraphrases land as far apart as two unrelated sentences, because the
   * vectors are a hash. It shows that the hybrid path *runs*; a test about what
   * the hybrid path *finds* has to state its own synonymy.
   */
  it("models no synonymy whatsoever", async () => {
    const [left] = await embed(["연차"]);
    const [right] = await embed(["휴가"]);

    expect(
      Math.abs(cosineSimilarity(left?.vector ?? [], right?.vector ?? [])),
    ).toBeLessThan(0.9);
  });

  it("refuses an empty text rather than answering with no direction", async () => {
    // A zero vector scores 0 against every Card, which reads as "unrelated"
    // rather than as "we were handed nothing".
    await expect(embed(["   "])).rejects.toThrow(CardEmbeddingFault);
  });

  it("honours an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      adapter.embed({
        profile: TEST_CARD_PROFILE,
        inputs: [{ key: "k0", text: "x" }],
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });

  it("is a test provider, and says so", () => {
    expect(adapter.providerKind).toBe("test");
    expect(() =>
      assertCardEmbeddingProviderKind(TEST_CARD_PROFILE, adapter, "local"),
    ).toThrow(TypeError);
    expect(() =>
      assertCardEmbeddingProviderKind(TEST_CARD_PROFILE, adapter, "test"),
    ).not.toThrow();
  });
});
