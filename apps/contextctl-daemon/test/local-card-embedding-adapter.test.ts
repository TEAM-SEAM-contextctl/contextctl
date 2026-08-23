import {
  EmbeddingProviderFault,
  type EmbeddingPort,
  type EmbeddingProfile,
  type EmbeddingProviderOutput,
  type EmbeddingProviderRequest,
} from "@contextctl/ingestion-indexing";
import {
  CardEmbeddingFault,
  DEFAULT_CARD_ADMISSION_LIMITS,
  type CardSelectionProfile,
} from "@contextctl/selection-delivery";
import { describe, expect, it } from "vitest";

import { LocalCardEmbeddingAdapter } from "../src/adapters/local-card-embedding-adapter.js";

const SESSION_PROFILE: EmbeddingProfile = {
  id: "document-family-v1",
  version: "1",
  model: "granite",
  dimensions: 4,
  distance: "cosine",
  maxInputTokens: 480,
  textMeasureProfileVersion: "unicode-estimate-v1",
};

const CARD_PROFILE: CardSelectionProfile = {
  id: "card-family-v1",
  version: "1",
  model: "granite",
  dimensions: 4,
  distance: "cosine",
  normalization: "l2",
  selectionTextSchemaVersion: 2,
  admissionLimits: DEFAULT_CARD_ADMISSION_LIMITS,
};

/** Records what the session was asked for, and answers a fixed vector. */
class RecordingEmbeddingPort implements EmbeddingPort {
  readonly providerKind = "local" as const;
  readonly requests: EmbeddingProviderRequest[] = [];

  async embed(
    request: EmbeddingProviderRequest,
  ): Promise<readonly EmbeddingProviderOutput[]> {
    this.requests.push(request);
    return request.inputs.map((input) => ({
      key: input.key,
      vector: [1, 0, 0, 0],
    }));
  }
}

class ThrowingEmbeddingPort implements EmbeddingPort {
  readonly providerKind = "local" as const;
  constructor(private readonly cause: unknown) {}
  embed(): Promise<readonly EmbeddingProviderOutput[]> {
    return Promise.reject(this.cause);
  }
}

function adapterFor(provider: EmbeddingPort): LocalCardEmbeddingAdapter {
  return new LocalCardEmbeddingAdapter({
    provider,
    session: SESSION_PROFILE,
    card: CARD_PROFILE,
  });
}

describe("LocalCardEmbeddingAdapter", () => {
  it("declares itself a local provider", () => {
    expect(adapterFor(new RecordingEmbeddingPort()).providerKind).toBe("local");
  });

  /**
   * The one thing that is shared, stated as behaviour.
   *
   * The Card port does not construct a session, does not verify an artifact and
   * does not load ONNX; it hands its inputs to the provider the document path
   * already built. What it does *not* share is the profile: the request that
   * reaches the session carries the session's own profile, because that is the
   * only one the session will accept — while the caller asked, and the index is
   * keyed, under the Card profile.
   */
  it("delegates to the session under the session's own profile", async () => {
    const session = new RecordingEmbeddingPort();
    const outputs = await adapterFor(session).embed({
      profile: CARD_PROFILE,
      inputs: [{ key: "cardv_1", text: "연차 규정" }],
    });

    expect(outputs).toEqual([{ key: "cardv_1", vector: [1, 0, 0, 0] }]);
    expect(session.requests[0]?.profile).toBe(SESSION_PROFILE);
    expect(session.requests[0]?.inputs).toEqual([
      { key: "cardv_1", text: "연차 규정" },
    ]);
  });

  it("refuses a request for a vector space it does not serve", async () => {
    // Answering in the space it does serve would put two families' vectors in
    // one index, and nothing downstream could detect it.
    await expect(
      adapterFor(new RecordingEmbeddingPort()).embed({
        profile: { ...CARD_PROFILE, version: "2" },
        inputs: [{ key: "a", text: "x" }],
      }),
    ).rejects.toThrow(CardEmbeddingFault);
  });

  it("answers an empty batch without touching the session", async () => {
    const session = new RecordingEmbeddingPort();

    expect(
      await adapterFor(session).embed({ profile: CARD_PROFILE, inputs: [] }),
    ).toEqual([]);
    expect(session.requests).toEqual([]);
  });

  it("refuses to assemble when the two profiles disagree on width", () => {
    // One set of weights cannot produce vectors of two widths, so a
    // disagreement means the graph was assembled wrong and should not start.
    expect(
      () =>
        new LocalCardEmbeddingAdapter({
          provider: new RecordingEmbeddingPort(),
          session: SESSION_PROFILE,
          card: { ...CARD_PROFILE, dimensions: 384 },
        }),
    ).toThrow(TypeError);
  });

  it("restates the session's fault in this port's vocabulary", async () => {
    const adapter = adapterFor(
      new ThrowingEmbeddingPort(
        new EmbeddingProviderFault("embedding_artifact_unavailable", false),
      ),
    );

    await expect(
      adapter.embed({ profile: CARD_PROFILE, inputs: [{ key: "a", text: "x" }] }),
    ).rejects.toMatchObject({
      name: "CardEmbeddingFault",
      code: "embedding_artifact_unavailable",
      retriable: false,
    });
  });

  it("carries a remote fault across under its own name", async () => {
    // `rate_limited` and `authentication_failed` used to be folded into
    // `provider_unavailable` because no Card provider could be remote. The
    // port now admits one, so the codes travel as themselves and an operator
    // can tell a quota from an outage.
    for (const [code, retriable] of [
      ["rate_limited", true],
      ["authentication_failed", false],
    ] as const) {
      const adapter = adapterFor(
        new ThrowingEmbeddingPort(new EmbeddingProviderFault(code, retriable)),
      );

      await expect(
        adapter.embed({ profile: CARD_PROFILE, inputs: [{ key: "a", text: "x" }] }),
      ).rejects.toMatchObject({ name: "CardEmbeddingFault", code, retriable });
    }
  });

  it("states the Card profile it serves, for binding", () => {
    const adapter = adapterFor(new RecordingEmbeddingPort());

    expect(adapter.profile).toBe(CARD_PROFILE);
  });

  it("proves physical sharing only for the exact delegated provider", () => {
    const session = new RecordingEmbeddingPort();
    const anotherSession = new RecordingEmbeddingPort();
    const adapter = adapterFor(session);

    expect(adapter.usesProvider(session)).toBe(true);
    expect(adapter.usesProvider(anotherSession)).toBe(false);
  });

  it("reports an arbitrary exception as a retriable provider failure", async () => {
    const adapter = adapterFor(new ThrowingEmbeddingPort(new Error("boom")));

    await expect(
      adapter.embed({ profile: CARD_PROFILE, inputs: [{ key: "a", text: "x" }] }),
    ).rejects.toMatchObject({ code: "provider_unavailable", retriable: true });
  });

  it("lets an abort travel as itself rather than as a provider fault", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    controller.abort(reason);
    const adapter = adapterFor(new ThrowingEmbeddingPort(reason));

    await expect(
      adapter.embed({
        profile: CARD_PROFILE,
        inputs: [{ key: "a", text: "x" }],
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
  });
});
