import { describe, expect, it } from "vitest";

import {
  emptyResultDiagnosis,
  ingestVolatilityWarning,
  resolveVectorBackend,
  type VectorBackend,
} from "../../src/cli/vector-backend.js";

/**
 * A resolved Qdrant backend, for the diagnosis tests that need one.
 *
 * Loopback so `assertSafeEndpoint` accepts it. No `client` is supplied and none
 * is needed: the adapter's constructor builds a `QdrantClient` without touching
 * the network, so constructing one asserts the configuration was accepted
 * without asserting anything about a server. No test here calls a method on it.
 */
function qdrantBackend(): VectorBackend {
  return resolveVectorBackend({
    CONTEXTCTL_QDRANT_URL: "http://localhost:6333",
  });
}

describe("resolveVectorBackend", () => {
  it("falls back to the in-memory adapter when no endpoint is configured", () => {
    const backend = resolveVectorBackend({});

    expect(backend.kind).toBe("in_memory");
    expect(backend.endpoint).toBeUndefined();
  });

  it("treats a blank endpoint as unset, the way a shell means it", () => {
    // `CONTEXTCTL_QDRANT_URL=` is how an operator unsets a variable for one
    // command, so it must not be read as an endpoint named "".
    expect(resolveVectorBackend({ CONTEXTCTL_QDRANT_URL: "" }).kind).toBe(
      "in_memory",
    );
    expect(resolveVectorBackend({ CONTEXTCTL_QDRANT_URL: "   " }).kind).toBe(
      "in_memory",
    );
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

  it("never lets the API key reach anything an operator is shown", () => {
    const secret = "secret-value";
    const backend = resolveVectorBackend({
      CONTEXTCTL_QDRANT_URL: "https://vectors.example.com",
      CONTEXTCTL_QDRANT_API_KEY: secret,
    });

    // The credential is configuration the adapter needs and diagnostics never
    // do, so every string this module can hand a caller is checked, not just the
    // endpoint: a diagnosis line that interpolated the backend would leak it
    // into stderr and from there into whatever an operator pastes into an issue.
    expect(backend.endpoint).toBe("https://vectors.example.com/");
    expect(backend.endpoint).not.toContain(secret);
    expect(ingestVolatilityWarning(backend) ?? "").not.toContain(secret);
    for (const approvedCardCount of [0, 3]) {
      expect(
        emptyResultDiagnosis({ backend, approvedCardCount, itemCount: 0 }) ?? "",
      ).not.toContain(secret);
    }
    // The zero-card case above is a real string rather than `undefined`, so the
    // assertions are not vacuous for at least one of the two.
    expect(
      emptyResultDiagnosis({ backend, approvedCardCount: 0, itemCount: 0 }),
    ).toBeTypeOf("string");
  });
});

describe("ingestVolatilityWarning", () => {
  it("warns when the index just written dies with the process", () => {
    const warning = ingestVolatilityWarning(resolveVectorBackend({}));

    expect(warning).toBeTypeOf("string");
    expect(warning).toContain("CONTEXTCTL_QDRANT_URL");
  });

  it("stays quiet for a durable backend", () => {
    expect(ingestVolatilityWarning(qdrantBackend())).toBeUndefined();
  });

  /**
   * The advice has to be advice that works.
   *
   * "Set the variable and ingest again" was the instruction here, and following
   * it does nothing: the second ingest reports `unchanged` and skips indexing,
   * because the observation checkpoint tracks the document and nothing checks
   * whether an index exists. An operator who followed it was left with approved
   * Cards and no vectors — the state this warning exists to prevent.
   */
  it("does not tell an operator to re-ingest an unchanged document", () => {
    const warning = ingestVolatilityWarning(resolveVectorBackend({}));

    // The correction, stated as the property rather than as a fixed sentence:
    // whatever the wording, it must say that a second ingest is skipped.
    expect(warning).toContain("unchanged");
  });

  it("names the recovery that actually rebuilds the index", () => {
    const warning = ingestVolatilityWarning(resolveVectorBackend({})) ?? "";

    // `contextctl paths` rather than a filename, because the store can be moved
    // with CONTEXTCTL_INGESTION_DATABASE.
    expect(warning).toContain("contextctl paths");
    // And the fact that makes it runnable: an operator who believes they are
    // about to lose their approvals will not do it.
    expect(warning).toContain("승인한 Card");
  });

  it("gives the same recovery when a query finds an empty index", () => {
    // The two messages used to carry the same wrong instruction in two places.
    const diagnosis =
      emptyResultDiagnosis({
        backend: resolveVectorBackend({}),
        approvedCardCount: 3,
        itemCount: 0,
      }) ?? "";

    expect(diagnosis).toContain("contextctl paths");
    expect(diagnosis).toContain("unchanged");
  });
});

describe("emptyResultDiagnosis", () => {
  const inMemory = resolveVectorBackend({});

  it("says nothing about a query that returned items", () => {
    expect(
      emptyResultDiagnosis({
        backend: inMemory,
        approvedCardCount: 3,
        itemCount: 2,
      }),
    ).toBeUndefined();
  });

  it("names the volatile index when approved Cards exist but nothing matched", () => {
    const diagnosis = emptyResultDiagnosis({
      backend: inMemory,
      approvedCardCount: 3,
      itemCount: 0,
    });

    expect(diagnosis).toBeTypeOf("string");
    // The count is quoted back so the operator can tell "the catalog is empty"
    // apart from "the catalog is fine and the index is not".
    expect(diagnosis).toContain("3");
  });

  it("points at approval when the catalog itself is empty", () => {
    const diagnosis = emptyResultDiagnosis({
      backend: inMemory,
      approvedCardCount: 0,
      itemCount: 0,
    });

    expect(diagnosis).toBeTypeOf("string");
    expect(diagnosis).toContain("approve");
  });

  it("refuses to guess when a durable backend legitimately matched nothing", () => {
    expect(
      emptyResultDiagnosis({
        backend: qdrantBackend(),
        approvedCardCount: 3,
        itemCount: 0,
      }),
    ).toBeUndefined();
  });
});
