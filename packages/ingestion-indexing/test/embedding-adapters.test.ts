import { describe, expect, it } from "vitest";

import {
  DeterministicEmbeddingAdapter,
  EmbeddingProviderFault,
  OpenAiCompatibleEmbeddingAdapter,
  type EmbeddingProfile,
  type EmbeddingProviderRequest,
} from "../src/index.js";

const profile: EmbeddingProfile = {
  id: "adapter-test",
  version: "1.0.0",
  model: "embedding-model-v1",
  dimensions: 3,
  distance: "cosine",
  maxInputTokens: 480,
  textMeasureProfileVersion: "unicode-estimate-v1",
};

describe("Deterministic embedding adapter", () => {
  it("returns stable finite vectors with the configured dimensions", async () => {
    const adapter = new DeterministicEmbeddingAdapter();
    const request = createRequest();

    const first = await adapter.embed(request);
    const second = await adapter.embed(request);

    expect(second).toEqual(first);
    expect(first.map((output) => output.key)).toEqual(["crv_aaaa", "crv_bbbb"]);
    expect(first.every((output) => output.vector.length === 3)).toBe(true);
    expect(first.flatMap((output) => output.vector).every(Number.isFinite)).toBe(
      true,
    );
    expect(first[0]?.vector).not.toEqual(first[1]?.vector);
  });
});

describe("OpenAI-compatible embedding adapter", () => {
  it("sends only model and input text and restores provider index order", async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(input), ...(init === undefined ? {} : { init }) };
      return Response.json({
        data: [
          { index: 1, embedding: [0.4, 0.5, 0.6] },
          { index: 0, embedding: [0.1, 0.2, 0.3] },
        ],
      });
    };
    const adapter = new OpenAiCompatibleEmbeddingAdapter({
      endpoint: "https://embedding.example.test/v1/embeddings",
      headers: { Authorization: "Bearer test-secret" },
      fetch: fetch as typeof globalThis.fetch,
    });

    const result = await adapter.embed(createRequest());

    expect(captured?.url).toBe("https://embedding.example.test/v1/embeddings");
    expect(JSON.parse(String(captured?.init?.body))).toEqual({
      model: "embedding-model-v1",
      input: ["alpha", "beta"],
    });
    expect(new Headers(captured?.init?.headers).get("authorization")).toBe(
      "Bearer test-secret",
    );
    expect(captured?.init?.redirect).toBe("error");
    expect(result).toEqual([
      { key: "crv_aaaa", vector: [0.1, 0.2, 0.3] },
      { key: "crv_bbbb", vector: [0.4, 0.5, 0.6] },
    ]);
  });

  it("classifies retryable HTTP failures without exposing response or credentials", async () => {
    const adapter = new OpenAiCompatibleEmbeddingAdapter({
      endpoint: "https://embedding.example.test/v1/embeddings",
      headers: { "x-api-key": "test-secret" },
      fetch: (async () =>
        new Response("provider detail containing test-secret", {
          status: 429,
        })) as typeof globalThis.fetch,
    });

    const error = await adapter
      .embed(createRequest())
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EmbeddingProviderFault);
    expect(error).toMatchObject({ code: "rate_limited", retriable: true });
    expect(String(error)).not.toContain("test-secret");
    expect(String(error)).not.toContain("provider detail");
  });

  it("rejects malformed responses and unsafe endpoint or header configuration", async () => {
    const adapter = new OpenAiCompatibleEmbeddingAdapter({
      endpoint: "https://embedding.example.test/v1/embeddings",
      fetch: (async () =>
        Response.json({
          data: [{ index: 0, embedding: [1] }],
        })) as typeof globalThis.fetch,
    });

    await expect(adapter.embed(createRequest())).rejects.toMatchObject({
      code: "invalid_response",
      retriable: false,
    });
    expect(
      () =>
        new OpenAiCompatibleEmbeddingAdapter({
          endpoint: "https://user:secret@embedding.example.test/v1/embeddings",
        }),
    ).toThrow(TypeError);
    expect(
      () =>
        new OpenAiCompatibleEmbeddingAdapter({
          endpoint: "http://embedding.example.test/v1/embeddings",
        }),
    ).toThrow(TypeError);
    expect(
      () =>
        new OpenAiCompatibleEmbeddingAdapter({
          endpoint: "http://127.0.0.1:8000/v1/embeddings",
        }),
    ).not.toThrow();
    expect(
      () =>
        new OpenAiCompatibleEmbeddingAdapter({
          endpoint: "https://embedding.example.test/v1/embeddings",
          headers: { Host: "other.example.test" },
        }),
    ).toThrow(TypeError);
  });
});

function createRequest(): EmbeddingProviderRequest {
  return {
    profile,
    inputs: [
      { key: "crv_aaaa", text: "alpha" },
      { key: "crv_bbbb", text: "beta" },
    ],
    signal: new AbortController().signal,
  };
}
