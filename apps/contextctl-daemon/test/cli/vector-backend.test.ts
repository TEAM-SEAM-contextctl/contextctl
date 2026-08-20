import { describe, expect, it } from "vitest";

import {
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
