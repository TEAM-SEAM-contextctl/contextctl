import { describe, expect, it } from "vitest";

import {
  createRemoteCardSelectionProfile,
  type CardSelectionEmbeddingProfile,
} from "../../src/domain/card-selection-profile.js";
import { OpenAiCompatibleCardEmbeddingAdapter } from "../../src/infrastructure/openai-compatible-card-embedding-adapter.js";
import {
  assertCardEmbeddingProviderBinding,
  CardEmbeddingFault,
  type CardEmbeddingRequest,
} from "../../src/ports/card-embedding.js";
import { TEST_PRODUCTION_CARD_PROFILE } from "../fixtures/card-embedding.fixture.js";

/**
 * Mirrors Indexing's remote adapter tests case for case. The two adapters are
 * deliberately separate implementations of one set of rules, so the tests are
 * the place that says the rules are the same.
 */

const ENDPOINT = "https://embedding.example.test/v1/embeddings";

const remoteProfile: CardSelectionEmbeddingProfile = createRemoteCardSelectionProfile({
  id: "card-remote-test-v1",
  version: "1",
  model: "card-embedding-model-2026-08-21",
  modelRevision: "rev_remote_0001",
  dimensions: 3,
  adapterVersion: "1.0.0",
});

function request(
  inputs: readonly { key: string; text: string }[] = [
    { key: "cardv_aaaa", text: "alpha" },
    { key: "cardv_bbbb", text: "beta" },
  ],
  signal: AbortSignal = new AbortController().signal,
): CardEmbeddingRequest {
  return { profile: remoteProfile, inputs, signal };
}

function adapterWith(
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  options: Partial<ConstructorParameters<typeof OpenAiCompatibleCardEmbeddingAdapter>[0]> = {},
): OpenAiCompatibleCardEmbeddingAdapter {
  return new OpenAiCompatibleCardEmbeddingAdapter({
    endpoint: ENDPOINT,
    profile: remoteProfile,
    fetch: fetch as typeof globalThis.fetch,
    ...options,
  });
}

describe("OpenAiCompatibleCardEmbeddingAdapter", () => {
  it("sends only the model and the texts, to the endpoint as given, and restores provider index order", async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    const adapter = adapterWith(
      async (input, init) => {
        captured = { url: String(input), ...(init === undefined ? {} : { init }) };
        return Response.json({
          model: remoteProfile.model,
          data: [
            { index: 1, embedding: [0, 1, 0] },
            { index: 0, embedding: [1, 0, 0] },
          ],
        });
      },
      { headers: { Authorization: "Bearer test-secret" } },
    );

    const result = await adapter.embed(request());

    // The whole URL, untouched: no path is appended to what the operator gave.
    expect(captured?.url).toBe(ENDPOINT);
    expect(JSON.parse(String(captured?.init?.body))).toEqual({
      model: "card-embedding-model-2026-08-21",
      input: ["alpha", "beta"],
    });
    expect(new Headers(captured?.init?.headers).get("authorization")).toBe("Bearer test-secret");
    expect(captured?.init?.redirect).toBe("error");
    expect(result).toEqual([
      { key: "cardv_aaaa", vector: [1, 0, 0] },
      { key: "cardv_bbbb", vector: [0, 1, 0] },
    ]);
  });

  it("states the remote profile it serves and is bindable to it alone", () => {
    const adapter = adapterWith(async () => Response.json({ model: remoteProfile.model, data: [] }));

    expect(adapter.providerKind).toBe("remote");
    expect(adapter.profile).toEqual(remoteProfile);
    expect(() => assertCardEmbeddingProviderBinding(remoteProfile, adapter)).not.toThrow();
    expect(() =>
      assertCardEmbeddingProviderBinding({ ...remoteProfile, version: "other" }, adapter),
    ).toThrow(/does not match/);
    // A local production profile refuses a remote provider on kind.
    expect(() =>
      assertCardEmbeddingProviderBinding(TEST_PRODUCTION_CARD_PROFILE, adapter),
    ).toThrow(/requires a local provider/);
  });

  it("refuses a request under another profile before making a call", async () => {
    let calls = 0;
    const adapter = adapterWith(async () => {
      calls += 1;
      return Response.json({ model: remoteProfile.model, data: [] });
    });

    await expect(
      adapter.embed({ ...request(), profile: { ...remoteProfile, version: "other" } }),
    ).rejects.toMatchObject({ code: "invalid_request", retriable: false });
    expect(calls).toBe(0);
  });

  it("refuses to be built over a local profile", () => {
    expect(
      () =>
        new OpenAiCompatibleCardEmbeddingAdapter({
          endpoint: ENDPOINT,
          profile: TEST_PRODUCTION_CARD_PROFILE,
        }),
    ).toThrow(/remote profile/);
  });

  it("classifies HTTP failures by status without exposing the response or the credential", async () => {
    const cases = [
      [401, "authentication_failed", false],
      [403, "authentication_failed", false],
      [429, "rate_limited", true],
      [408, "provider_unavailable", true],
      [503, "provider_unavailable", true],
      [400, "invalid_request", false],
    ] as const;
    for (const [status, code, retriable] of cases) {
      const adapter = adapterWith(
        async () => new Response("provider detail containing test-secret", { status }),
        { headers: { "x-api-key": "test-secret" } },
      );

      const error = await adapter.embed(request()).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(CardEmbeddingFault);
      expect(error).toMatchObject({ code, retriable });
      expect(String(error)).not.toContain("test-secret");
      expect(String(error)).not.toContain("provider detail");
      expect(String(error)).not.toContain("alpha");
    }
  });

  it("reports a transport failure as a retriable unavailability", async () => {
    const adapter = adapterWith(async () => {
      throw new Error("ECONNREFUSED test-secret");
    });

    const error = await adapter.embed(request()).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "provider_unavailable", retriable: true });
    expect(String(error)).not.toContain("test-secret");
  });

  it("rejects a vector of the wrong width", async () => {
    const adapter = adapterWith(async () =>
      Response.json({ model: remoteProfile.model, data: [{ index: 0, embedding: [1] }] }),
    );

    await expect(
      adapter.embed(request([{ key: "cardv_aaaa", text: "alpha" }])),
    ).rejects.toMatchObject({ code: "invalid_response", retriable: false });
  });

  it.each([
    [[1, 1, 1], "unnormalized"],
    [[0, 0, 0], "zero"],
    [[1, Number.NaN, 0], "non-finite"],
  ] as const)("rejects a vector the profile's L2 normalization excludes (%s)", async (vector, _kind) => {
    const adapter = adapterWith(async () =>
      Response.json({ model: remoteProfile.model, data: [{ index: 0, embedding: [...vector] }] }),
    );

    await expect(
      adapter.embed(request([{ key: "cardv_aaaa", text: "alpha" }])),
    ).rejects.toMatchObject({ code: "invalid_response", retriable: false });
  });

  it("rejects an answer that names a model other than the one pinned", async () => {
    const adapter = adapterWith(async () =>
      Response.json({ model: "card-embedding-model-latest", data: [{ index: 0, embedding: [1, 0, 0] }] }),
    );

    await expect(
      adapter.embed(request([{ key: "cardv_aaaa", text: "alpha" }])),
    ).rejects.toMatchObject({ code: "invalid_response", retriable: false });
  });

  it("rejects an answer that does not cover every input exactly once", async () => {
    const missing = adapterWith(async () =>
      Response.json({ model: remoteProfile.model, data: [{ index: 0, embedding: [1, 0, 0] }] }),
    );
    const duplicated = adapterWith(async () =>
      Response.json({
        model: remoteProfile.model,
        data: [
          { index: 0, embedding: [1, 0, 0] },
          { index: 0, embedding: [0, 1, 0] },
        ],
      }),
    );

    await expect(missing.embed(request())).rejects.toMatchObject({ code: "invalid_response" });
    await expect(duplicated.embed(request())).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("refuses unsafe endpoint and header configuration", () => {
    const build = (endpoint: string, headers?: Record<string, string>) => () =>
      new OpenAiCompatibleCardEmbeddingAdapter({
        endpoint,
        profile: remoteProfile,
        ...(headers === undefined ? {} : { headers }),
      });

    expect(build("https://user:secret@embedding.example.test/v1/embeddings")).toThrow(TypeError);
    expect(build("http://embedding.example.test/v1/embeddings")).toThrow(TypeError);
    expect(build("not a url")).toThrow(TypeError);
    expect(build("ftp://embedding.example.test/embeddings")).toThrow(TypeError);
    expect(build("http://127.0.0.1:8000/v1/embeddings")).not.toThrow();
    expect(build("http://localhost:8000/custom/path")).not.toThrow();
    expect(build(ENDPOINT, { Host: "other.example.test" })).toThrow(TypeError);
    expect(build(ENDPOINT, { "Content-Length": "1" })).toThrow(TypeError);
    expect(build(ENDPOINT, { "x-a": "line\r\nbreak" })).toThrow(TypeError);
    expect(build(ENDPOINT, { "X-Api-Key": "a", "x-api-key": "b" })).toThrow(TypeError);
    expect(
      () => new OpenAiCompatibleCardEmbeddingAdapter({ endpoint: ENDPOINT, profile: remoteProfile, maxBatchSize: 0 }),
    ).toThrow(TypeError);
    expect(
      () => new OpenAiCompatibleCardEmbeddingAdapter({ endpoint: ENDPOINT, profile: remoteProfile, maxBatchSize: 4_096 }),
    ).toThrow(TypeError);
  });

  it("refuses a duplicated key, a blank key, an empty text and an oversized batch before any byte leaves", async () => {
    let calls = 0;
    const adapter = adapterWith(
      async () => {
        calls += 1;
        return Response.json({ model: remoteProfile.model, data: [] });
      },
      { maxBatchSize: 2 },
    );

    for (const inputs of [
      [{ key: "dup", text: "alpha" }, { key: "dup", text: "beta" }],
      [{ key: "  ", text: "alpha" }],
      [{ key: "k", text: "   " }],
      [{ key: "a", text: "x" }, { key: "b", text: "y" }, { key: "c", text: "z" }],
    ]) {
      await expect(adapter.embed(request(inputs))).rejects.toMatchObject({
        code: "invalid_request",
        retriable: false,
      });
    }
    expect(calls).toBe(0);
  });

  it("answers an empty batch without a call", async () => {
    let calls = 0;
    const adapter = adapterWith(async () => {
      calls += 1;
      return Response.json({ model: remoteProfile.model, data: [] });
    });

    await expect(adapter.embed(request([]))).resolves.toEqual([]);
    expect(calls).toBe(0);
  });

  it("refuses a request body over 2 MiB as an input limit, not a provider fault", async () => {
    let calls = 0;
    const adapter = adapterWith(async () => {
      calls += 1;
      return Response.json({ model: remoteProfile.model, data: [] });
    });

    await expect(
      adapter.embed(request([{ key: "big", text: "가".repeat(800_000) }])),
    ).rejects.toMatchObject({ code: "input_limit_exceeded", retriable: false });
    expect(calls).toBe(0);
  });

  it("bounds the response by its declared length and by what actually arrives", async () => {
    const declared = adapterWith(
      async () =>
        new Response("{}", { status: 200, headers: { "content-length": String(17 * 1024 * 1024) } }),
    );
    await expect(adapter1(declared)).rejects.toMatchObject({ code: "invalid_response", retriable: false });

    const oversized = adapterWith(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              const chunk = new Uint8Array(1024 * 1024);
              for (let index = 0; index < 17; index += 1) controller.enqueue(chunk);
              controller.close();
            },
          }),
          { status: 200 },
        ),
    );
    await expect(adapter1(oversized)).rejects.toMatchObject({ code: "invalid_response", retriable: false });

    function adapter1(adapter: OpenAiCompatibleCardEmbeddingAdapter) {
      return adapter.embed(request([{ key: "query", text: "bounded response" }]));
    }
  });

  it("rejects a body that is not valid UTF-8 or not JSON", async () => {
    const invalidUtf8 = adapterWith(
      async () => new Response(new Uint8Array([0xff, 0xfe, 0x7b, 0x7d]), { status: 200 }),
    );
    const notJson = adapterWith(async () => new Response("not json", { status: 200 }));

    await expect(invalidUtf8.embed(request())).rejects.toMatchObject({ code: "invalid_response" });
    await expect(notJson.embed(request())).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("classifies a response-stream interruption as retriable without exposing its cause", async () => {
    const adapter = adapterWith(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("transport detail test-secret"));
            },
          }),
          { status: 200 },
        ),
    );

    const error = await adapter
      .embed(request([{ key: "query", text: "private query" }]))
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "provider_unavailable", retriable: true });
    expect(String(error)).not.toContain("test-secret");
    expect(String(error)).not.toContain("private query");
  });

  it("lets an abort travel as itself rather than as a provider fault", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const adapter = adapterWith(async (_input, init) => {
      controller.abort(reason);
      throw init?.signal?.reason ?? new Error("aborted");
    });

    await expect(adapter.embed(request(undefined, controller.signal))).rejects.toBe(reason);
  });

  it("answers a request that carries no signal", async () => {
    const adapter = adapterWith(async () =>
      Response.json({ model: remoteProfile.model, data: [{ index: 0, embedding: [1, 0, 0] }] }),
    );

    await expect(
      adapter.embed({ profile: remoteProfile, inputs: [{ key: "cardv_aaaa", text: "alpha" }] }),
    ).resolves.toEqual([{ key: "cardv_aaaa", vector: [1, 0, 0] }]);
  });
});
