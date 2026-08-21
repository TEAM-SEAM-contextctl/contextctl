import { describe, expect, it } from "vitest";

import {
  DeterministicEmbeddingAdapter,
  EmbeddingProviderFault,
  OpenAiCompatibleEmbeddingAdapter,
  assertProductionEmbeddingProvider,
  DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
  type EmbeddingProfile,
  type EmbeddingProviderRequest,
  type DocumentRetrievalEmbeddingProfile,
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
        model: productionProfile.model,
        data: [
          { index: 1, embedding: [0, 1, 0] },
          { index: 0, embedding: [1, 0, 0] },
        ],
      });
    };
    const adapter = new OpenAiCompatibleEmbeddingAdapter({
      endpoint: "https://embedding.example.test/v1/embeddings",
      profile: productionProfile,
      headers: { Authorization: "Bearer test-secret" },
      fetch: fetch as typeof globalThis.fetch,
    });

    const result = await adapter.embed(createProductionRequest());

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
      { key: "crv_aaaa", vector: [1, 0, 0] },
      { key: "crv_bbbb", vector: [0, 1, 0] },
    ]);
  });

  it("classifies retryable HTTP failures without exposing response or credentials", async () => {
    const adapter = new OpenAiCompatibleEmbeddingAdapter({
      endpoint: "https://embedding.example.test/v1/embeddings",
      profile: productionProfile,
      headers: { "x-api-key": "test-secret" },
      fetch: (async () =>
        new Response("provider detail containing test-secret", {
          status: 429,
        })) as typeof globalThis.fetch,
    });

    const error = await adapter
      .embed(createProductionRequest())
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EmbeddingProviderFault);
    expect(error).toMatchObject({ code: "rate_limited", retriable: true });
    expect(String(error)).not.toContain("test-secret");
    expect(String(error)).not.toContain("provider detail");
    expect(String(error)).not.toContain("alpha");
    expect(String(error)).not.toContain("beta");
  });

  it("rejects malformed responses and unsafe endpoint or header configuration", async () => {
    const adapter = new OpenAiCompatibleEmbeddingAdapter({
      endpoint: "https://embedding.example.test/v1/embeddings",
      profile: productionProfile,
      fetch: (async () =>
        Response.json({
          model: productionProfile.model,
          data: [{ index: 0, embedding: [1] }],
        })) as typeof globalThis.fetch,
    });

    await expect(
      adapter.embed(createProductionRequest()),
    ).rejects.toMatchObject({
      code: "invalid_response",
      retriable: false,
    });
    expect(
      () =>
        new OpenAiCompatibleEmbeddingAdapter({
          endpoint: "https://user:secret@embedding.example.test/v1/embeddings",
          profile: productionProfile,
        }),
    ).toThrow(TypeError);
    expect(
      () =>
        new OpenAiCompatibleEmbeddingAdapter({
          endpoint: "http://embedding.example.test/v1/embeddings",
          profile: productionProfile,
        }),
    ).toThrow(TypeError);
    expect(
      () =>
        new OpenAiCompatibleEmbeddingAdapter({
          endpoint: "http://127.0.0.1:8000/v1/embeddings",
          profile: productionProfile,
        }),
    ).not.toThrow();
    expect(
      () =>
        new OpenAiCompatibleEmbeddingAdapter({
          endpoint: "https://embedding.example.test/v1/embeddings",
          profile: productionProfile,
          headers: { Host: "other.example.test" },
        }),
    ).toThrow(TypeError);
    expect(
      () =>
        new OpenAiCompatibleEmbeddingAdapter({
          endpoint: "https://embedding.example.test/v1/embeddings",
          profile: productionProfile,
          maxBatchSize: 0,
        }),
    ).toThrow(TypeError);
  });

  it.each([
    [[1, 1, 1], "unnormalized"],
    [[0, 0, 0], "zero"],
  ] as const)("rejects invalid L2 vectors declared by the production profile", async (vector, _kind) => {
    const adapter = new OpenAiCompatibleEmbeddingAdapter({
      endpoint: "https://embedding.example.test/v1/embeddings",
      profile: productionProfile,
      fetch: (async () =>
        Response.json({
          model: productionProfile.model,
          data: [{ index: 0, embedding: vector }],
        })) as typeof globalThis.fetch,
    });

    await expect(
      adapter.embed({
        profile: productionProfile,
        inputs: [{ key: "crv_aaaa", text: "alpha" }],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "invalid_response", retriable: false });
  });

  it("binds one exact remote profile before making a request", async () => {
    let calls = 0;
    const adapter = new OpenAiCompatibleEmbeddingAdapter({
      endpoint: "https://embedding.example.test/v1/embeddings",
      profile: productionProfile,
      fetch: (async () => {
        calls += 1;
        return Response.json({ model: productionProfile.model, data: [] });
      }) as typeof globalThis.fetch,
    });

    expect(() =>
      assertProductionEmbeddingProvider(productionProfile, adapter),
    ).not.toThrow();
    await expect(
      adapter.embed({
        ...createProductionRequest(),
        profile: { ...productionProfile, version: "other" },
      }),
    ).rejects.toMatchObject({ code: "invalid_request", retriable: false });
    expect(calls).toBe(0);
    expect(
      () =>
        new OpenAiCompatibleEmbeddingAdapter({
          endpoint: "https://embedding.example.test/v1/embeddings",
          profile: DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
        }),
    ).toThrow(/remote profile/);
  });

  it("bounds remote requests and responses before retaining provider payloads", async () => {
    let calls = 0;
    const adapter = new OpenAiCompatibleEmbeddingAdapter({
      endpoint: "https://embedding.example.test/v1/embeddings",
      profile: productionProfile,
      fetch: (async () => {
        calls += 1;
        return new Response("{}", {
          status: 200,
          headers: { "content-length": String(17 * 1024 * 1024) },
        });
      }) as typeof globalThis.fetch,
    });

    await expect(
      adapter.embed({
        profile: productionProfile,
        inputs: [
          { key: "duplicate", text: "alpha" },
          { key: "duplicate", text: "beta" },
        ],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "invalid_request", retriable: false });
    expect(calls).toBe(0);
    await expect(
      adapter.embed({
        profile: productionProfile,
        inputs: [{ key: "query", text: "bounded response" }],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "invalid_response", retriable: false });
    expect(calls).toBe(1);
  });

  it("classifies response-stream interruption without exposing its cause", async () => {
    const adapter = new OpenAiCompatibleEmbeddingAdapter({
      endpoint: "https://embedding.example.test/v1/embeddings",
      profile: productionProfile,
      fetch: (async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("transport detail test-secret"));
            },
          }),
          { status: 200 },
        )) as typeof globalThis.fetch,
    });

    const error = await adapter
      .embed({
        profile: productionProfile,
        inputs: [{ key: "query", text: "private query" }],
        signal: new AbortController().signal,
      })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "provider_unavailable",
      retriable: true,
    });
    expect(String(error)).not.toContain("test-secret");
    expect(String(error)).not.toContain("private query");
  });
});

const productionProfile: DocumentRetrievalEmbeddingProfile = {
  ...profile,
  modelRevision: "revision-1",
  execution: {
    kind: "remote",
    adapter: "openai-compatible",
    adapterVersion: "1.0.0",
    model: profile.model,
  },
  pooling: "provider_defined",
  normalization: "l2",
  documentInputTransformVersion: "identity-v1",
  queryInputTransformVersion: "identity-v1",
  modelMaxTokens: 512,
  admissionLimit: {
    textMeasureProfileVersion: profile.textMeasureProfileVersion,
    maxUnits: profile.maxInputTokens,
  },
};

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

function createProductionRequest(): EmbeddingProviderRequest {
  return { ...createRequest(), profile: productionProfile };
}
