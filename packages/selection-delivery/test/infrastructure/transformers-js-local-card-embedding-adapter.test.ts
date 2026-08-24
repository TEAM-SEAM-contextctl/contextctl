import { describe, expect, it, vi } from "vitest";

import {
  CardEmbeddingFault,
  type CardEmbeddingRequest,
} from "../../src/ports/card-embedding.js";
import {
  TransformersJsLocalCardEmbeddingAdapter,
  type LocalCardEmbeddingInferenceResource,
} from "../../src/infrastructure/transformers-js-local-card-embedding-adapter.js";
import { TEST_PRODUCTION_CARD_PROFILE } from "../fixtures/card-embedding.fixture.js";

const profile = TEST_PRODUCTION_CARD_PROFILE;
if (profile.execution.kind !== "local") {
  throw new Error("local Card adapter fixture must pin a local execution");
}
const localExecution = profile.execution;

function resource(
  overrides: Partial<LocalCardEmbeddingInferenceResource> = {},
): LocalCardEmbeddingInferenceResource {
  return {
    execution: localExecution,
    modelMaxTokens: 32_768,
    tokenCount: () => 2,
    embed: async (texts) => ({
      dimensions: [texts.length, profile.dimensions],
      data: texts.flatMap((_, index) =>
        index % 2 === 0 ? [1, 0, 0, 0] : [0, 1, 0, 0],
      ),
    }),
    ...overrides,
  };
}

function request(
  inputs: readonly { readonly key: string; readonly text: string }[] = [
    { key: "card_a", text: "배송 조회" },
    { key: "card_b", text: "반품 접수" },
  ],
  signal?: AbortSignal,
): CardEmbeddingRequest {
  return {
    profile,
    inputs,
    ...(signal === undefined ? {} : { signal }),
  };
}

describe("TransformersJsLocalCardEmbeddingAdapter", () => {
  it("owns Card profile validation while delegating only physical inference", async () => {
    const inference = resource();
    const adapter = new TransformersJsLocalCardEmbeddingAdapter({
      inferenceResource: inference,
      profile,
    });

    await expect(adapter.embed(request())).resolves.toEqual([
      { key: "card_a", vector: [1, 0, 0, 0] },
      { key: "card_b", vector: [0, 1, 0, 0] },
    ]);
    expect(adapter.providerKind).toBe("local");
    expect(adapter.profile).toEqual(profile);
    expect(adapter.usesInferenceResource(inference)).toBe(true);
  });

  it("refuses a remote profile and a physical resource for another execution", () => {
    expect(
      () =>
        new TransformersJsLocalCardEmbeddingAdapter({
          inferenceResource: resource(),
          profile: {
            ...profile,
            pooling: "provider_defined",
            execution: {
              kind: "remote",
              adapter: "openai-compatible",
              adapterVersion: "1",
              model: profile.model,
            },
          },
        }),
    ).toThrow(/local profile/);
    expect(
      () =>
        new TransformersJsLocalCardEmbeddingAdapter({
          inferenceResource: resource({
            execution: { ...localExecution, artifactRevision: "other" },
          }),
          profile,
        }),
    ).toThrow(/does not match/);
  });

  it("checks the tokenizer limit without silently truncating", async () => {
    const tokenCount = vi.fn(async () => 33);
    const adapter = new TransformersJsLocalCardEmbeddingAdapter({
      inferenceResource: resource({ modelMaxTokens: 32, tokenCount }),
      profile,
    });

    await expect(
      adapter.embed(request([{ key: "query", text: "긴 질의" }])),
    ).rejects.toMatchObject({
      code: "input_limit_exceeded",
      retriable: false,
    });
    expect(tokenCount).toHaveBeenCalledWith("긴 질의");
  });

  it("refuses malformed requests and more than one catalog before inference", async () => {
    const embed = vi.fn(resource().embed);
    const adapter = new TransformersJsLocalCardEmbeddingAdapter({
      inferenceResource: resource({ embed }),
      profile,
      maxBatchSize: 2,
    });

    await expect(
      adapter.embed(
        request([
          { key: "same", text: "one" },
          { key: "same", text: "two" },
        ]),
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      adapter.embed(request([{ key: "blank", text: "  " }])),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      adapter.embed(
        request([
          ...Array.from({ length: 10_001 }, (_, index) => ({
            key: `card_${String(index)}`,
            text: "x",
          })),
        ]),
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(embed).not.toHaveBeenCalled();
  });

  it("checks and embeds a catalog in bounded physical batches", async () => {
    const tokenCounts = vi.fn(async (texts: readonly string[]) =>
      texts.map(() => 2),
    );
    const embed = vi.fn(resource().embed);
    const adapter = new TransformersJsLocalCardEmbeddingAdapter({
      inferenceResource: resource({ tokenCounts, embed }),
      profile,
      maxBatchSize: 2,
    });
    const inputs = Array.from({ length: 5 }, (_, index) => ({
      key: `card_${String(index)}`,
      text: `text_${String(index)}`,
    }));

    await expect(adapter.embed(request(inputs))).resolves.toHaveLength(5);
    expect(tokenCounts.mock.calls.map(([texts]) => texts)).toEqual([
      ["text_0", "text_1"],
      ["text_2", "text_3"],
      ["text_4"],
    ]);
    expect(embed.mock.calls.map(([texts]) => texts)).toEqual([
      ["text_0", "text_1"],
      ["text_2", "text_3"],
      ["text_4"],
    ]);
  });

  it("accepts the complete 10,000-Card catalog ceiling", async () => {
    const tokenCounts = vi.fn(async (texts: readonly string[]) =>
      texts.map(() => 2),
    );
    const embed = vi.fn(resource().embed);
    const adapter = new TransformersJsLocalCardEmbeddingAdapter({
      inferenceResource: resource({ tokenCounts, embed }),
      profile,
      maxBatchSize: 2_048,
    });
    const inputs = Array.from({ length: 10_000 }, (_, index) => ({
      key: `card_${String(index)}`,
      text: `text_${String(index)}`,
    }));

    await expect(adapter.embed(request(inputs))).resolves.toHaveLength(10_000);
    expect(tokenCounts).toHaveBeenCalledTimes(5);
    expect(embed).toHaveBeenCalledTimes(5);
  });

  it.each([
    {
      dimensions: [1, 3],
      data: [1, 0, 0],
      name: "wrong width",
    },
    {
      dimensions: [1, 4],
      data: [1, 1, 0, 0],
      name: "not normalized",
    },
    {
      dimensions: [1, 4],
      data: [1, Number.NaN, 0, 0],
      name: "non-finite",
    },
  ])("refuses an invalid inference tensor ($name)", async ({ dimensions, data }) => {
    const adapter = new TransformersJsLocalCardEmbeddingAdapter({
      inferenceResource: resource({
        embed: async () => ({ dimensions, data }),
      }),
      profile,
    });

    await expect(
      adapter.embed(request([{ key: "query", text: "배송" }])),
    ).rejects.toMatchObject({ code: "invalid_response", retriable: false });
  });

  it("translates a physical provider fault without leaking its message", async () => {
    const adapter = new TransformersJsLocalCardEmbeddingAdapter({
      inferenceResource: resource({
        embed: async () => {
          throw Object.assign(new Error("native detail containing Card text"), {
            code: "provider_unavailable",
            retriable: true,
          });
        },
      }),
      profile,
    });

    const failure = await adapter
      .embed(request([{ key: "query", text: "비밀 질의" }]))
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(CardEmbeddingFault);
    expect(failure).toMatchObject({
      code: "provider_unavailable",
      retriable: true,
    });
    expect(String(failure)).not.toContain("비밀 질의");
    expect(String(failure)).not.toContain("native detail");
  });

  it("stops waiting when the caller aborts", async () => {
    const controller = new AbortController();
    const adapter = new TransformersJsLocalCardEmbeddingAdapter({
      inferenceResource: resource({
        embed: async () => await new Promise(() => undefined),
      }),
      profile,
    });
    const pending = adapter.embed(
      request([{ key: "query", text: "배송" }], controller.signal),
    );
    controller.abort(new Error("cancelled"));

    await expect(pending).rejects.toThrow("cancelled");
  });
});
