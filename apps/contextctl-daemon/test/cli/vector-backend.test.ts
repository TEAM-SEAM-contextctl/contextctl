import { describe, expect, it } from "vitest";

import {
  probeQdrantReadiness,
  resolveVectorBackend,
  VectorBackendConfigurationError,
} from "../../src/vector-backend.js";

describe("resolveVectorBackend", () => {
  it("requires a Qdrant endpoint instead of silently selecting volatile storage", () => {
    for (const environment of [
      {},
      { CONTEXTCTL_QDRANT_URL: "" },
      { CONTEXTCTL_QDRANT_URL: "   " },
    ]) {
      expect(() => resolveVectorBackend(environment)).toThrow(
        VectorBackendConfigurationError,
      );
      try {
        resolveVectorBackend(environment);
      } catch (error) {
        expect(error).toMatchObject({ code: "qdrant_endpoint_required" });
        expect(error).toMatchObject({
          message: expect.stringContaining("CONTEXTCTL_QDRANT_URL"),
        });
      }
    }
  });

  it("accepts loopback HTTP", () => {
    for (const url of ["http://localhost:6333", "http://127.0.0.1:6333"]) {
      const backend = resolveVectorBackend({ CONTEXTCTL_QDRANT_URL: url });
      expect(backend.kind).toBe("qdrant");
      expect(backend.endpoint).toContain(new URL(url).host);
    }
  });

  it("accepts HTTPS for a remote host", () => {
    const backend = resolveVectorBackend({
      CONTEXTCTL_QDRANT_URL: "https://vectors.example.com",
    });

    expect(backend.kind).toBe("qdrant");
    expect(backend.endpoint).toBe("https://vectors.example.com/");
  });

  it("rejects plaintext HTTP to a non-loopback host", () => {
    expect(() =>
      resolveVectorBackend({
        CONTEXTCTL_QDRANT_URL: "http://example.com:6333",
      }),
    ).toThrow(TypeError);
  });

  it("rejects an endpoint carrying userinfo", () => {
    expect(() =>
      resolveVectorBackend({
        CONTEXTCTL_QDRANT_URL: "https://user:pw@vectors.example.com",
      }),
    ).toThrow(TypeError);
  });

  it("rejects a value that is not a URL at all", () => {
    expect(() =>
      resolveVectorBackend({ CONTEXTCTL_QDRANT_URL: "not-a-url" }),
    ).toThrow();
  });

  it("rejects a timeout that is not a positive safe integer", () => {
    for (const timeout of ["abc", "0", "-1", "1.5"]) {
      expect(() =>
        resolveVectorBackend({
          CONTEXTCTL_QDRANT_URL: "http://localhost:6333",
          CONTEXTCTL_QDRANT_TIMEOUT_MS: timeout,
        }),
      ).toThrow(TypeError);
    }
  });

  it("accepts a positive integer timeout", () => {
    const backend = resolveVectorBackend({
      CONTEXTCTL_QDRANT_URL: "http://localhost:6333",
      CONTEXTCTL_QDRANT_TIMEOUT_MS: "5000",
    });

    expect(backend.kind).toBe("qdrant");
  });

  it("never exposes the API key through diagnostic metadata", () => {
    const secret = "secret-value";
    const backend = resolveVectorBackend({
      CONTEXTCTL_QDRANT_URL: "https://vectors.example.com",
      CONTEXTCTL_QDRANT_API_KEY: secret,
    });

    expect(backend.endpoint).toBe("https://vectors.example.com/");
    expect(backend.endpoint).not.toContain(secret);
  });
});

describe("probeQdrantReadiness", () => {
  it("uses one authenticated read-only request and validates Qdrant's response", async () => {
    const calls: {
      readonly url: string;
      readonly init: RequestInit | undefined;
    }[] = [];
    const clock = [100, 112];
    const result = await probeQdrantReadiness(
      {
        CONTEXTCTL_QDRANT_URL: "https://vectors.example.com/qdrant",
        CONTEXTCTL_QDRANT_API_KEY: "secret-value",
      },
      {
        fetch: async (input, init) => {
          calls.push({ url: String(input), init });
          return qdrantCollectionsResponse();
        },
        now: () => clock.shift() ?? 112,
      },
    );

    expect(result).toEqual({
      status: "reachable",
      endpoint: "https://vectors.example.com/qdrant",
      elapsedMs: 12,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://vectors.example.com/qdrant/collections");
    expect(calls[0]?.init?.method).toBe("GET");
    expect(calls[0]?.init?.headers).toEqual({ "api-key": "secret-value" });
    expect(JSON.stringify(result)).not.toContain("secret-value");
  });

  it.each([
    [401, "unauthorized"],
    [403, "unauthorized"],
    [500, "invalid_response"],
  ] as const)("classifies HTTP %i without returning a response body", async (status, code) => {
    const result = await probeQdrantReadiness(
      { CONTEXTCTL_QDRANT_URL: "https://vectors.example.com" },
      { fetch: async () => new Response("private upstream detail", { status }) },
    );

    expect(result).toEqual({
      status: "unreachable",
      endpoint: "https://vectors.example.com/",
      code,
    });
    expect(JSON.stringify(result)).not.toContain("private upstream detail");
  });

  it("rejects a successful non-Qdrant response", async () => {
    const result = await probeQdrantReadiness(
      { CONTEXTCTL_QDRANT_URL: "https://vectors.example.com" },
      { fetch: async () => new Response('{"ok":true}') },
    );

    expect(result).toMatchObject({
      status: "unreachable",
      code: "invalid_response",
    });
  });

  it("bounds the collection-list response instead of buffering without limit", async () => {
    const result = await probeQdrantReadiness(
      { CONTEXTCTL_QDRANT_URL: "https://vectors.example.com" },
      { fetch: async () => new Response("x".repeat(1024 * 1024 + 1)) },
    );

    expect(result).toMatchObject({
      status: "unreachable",
      code: "invalid_response",
    });
  });

  it("bounds a hanging probe and reports the timeout", async () => {
    const result = await probeQdrantReadiness(
      { CONTEXTCTL_QDRANT_URL: "https://vectors.example.com" },
      {
        timeoutMs: 10,
        fetch: (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(init.signal?.reason),
              { once: true },
            );
          }),
      },
    );

    expect(result).toMatchObject({ status: "unreachable", code: "timeout" });
  });

  it("distinguishes a refused connection from an unknown transport failure", async () => {
    const refused = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" }),
    });
    const result = await probeQdrantReadiness(
      { CONTEXTCTL_QDRANT_URL: "http://127.0.0.1:6333" },
      { fetch: async () => Promise.reject(refused) },
    );

    expect(result).toMatchObject({
      status: "unreachable",
      code: "connection_refused",
    });
  });
});

function qdrantCollectionsResponse(): Response {
  return new Response(
    JSON.stringify({ result: { collections: [] }, status: "ok", time: 0 }),
    { headers: { "content-type": "application/json" } },
  );
}
