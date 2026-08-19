import { openIngestionDatabase } from "@contextctl/ingestion-indexing";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_SECURITY_DOMAIN,
  DEFAULT_STATE_NAMESPACE_ID,
} from "../../src/main.js";
import { resolveCardMeaningBackend } from "../../src/cli/meaning-generator.js";
import { resolveContextctlPaths } from "../../src/cli/paths.js";
import { cliRuntimeOptions } from "../../src/cli/runtime.js";
import { resolveVectorBackend } from "../../src/cli/vector-backend.js";

/**
 * What the CLI composition decides, asserted without assembling it.
 *
 * `buildCliRuntime` opens two databases and selects the pinned granite profile,
 * so exercising it here would make this suite depend on 390MB of installed
 * weights. `cliRuntimeOptions` exists to be the part that can be checked
 * instead: it is where every durability decision is made, and a decision that
 * silently reverted to an in-memory store is exactly the failure that produces
 * no error until a demo.
 */

const databases: DatabaseSync[] = [];

afterEach(() => {
  while (databases.length > 0) {
    databases.pop()?.close();
  }
});

function ingestionDatabase(): DatabaseSync {
  const database = openIngestionDatabase({
    location: ":memory:",
    stateNamespaceId: DEFAULT_STATE_NAMESPACE_ID,
    securityDomain: DEFAULT_SECURITY_DOMAIN,
  });
  databases.push(database);
  return database;
}

function build(environment: Readonly<Partial<Record<string, string>>>) {
  const paths = resolveContextctlPaths(environment, "/tmp/contextctl-test-cwd");
  return {
    paths,
    options: cliRuntimeOptions({
      paths,
      sourceConfigurations: { "source.payment": { path: "/tmp/payment.md" } },
      ingestionDatabase: ingestionDatabase(),
      vectorBackend: resolveVectorBackend(environment),
      meaningBackend: resolveCardMeaningBackend({
        environment,
        onFallback: () => {},
      }),
    }),
  };
}

describe("CLI runtime options", () => {
  it("points Registry at a file rather than at :memory:", () => {
    const { paths, options } = build({ CONTEXTCTL_HOME: "/tmp/contextctl-home" });

    // The whole reason the CLI exists as several processes: a Card approved by
    // one command has to still be approved when the next one starts.
    expect(options.registryDatabaseLocation).toBe(paths.registryDatabase);
    expect(options.registryDatabaseLocation).not.toBe(":memory:");
    expect(options.registryDatabaseLocation).toBe(
      "/tmp/contextctl-home/registry.db",
    );
  });

  it("supplies all five Ingestion stores or none", () => {
    const { options } = build({});

    // Asserted as a set rather than one by one: four durable stores and one
    // in-memory is the composition that claims Publications it can no longer
    // resolve a Scope for.
    expect(options.ingestionStores).toBeDefined();
    expect(Object.keys(options.ingestionStores ?? {}).sort()).toEqual([
      "checkpoints",
      "indexPublications",
      "observations",
      "publications",
      "stagingAttempts",
    ]);
    for (const store of Object.values(options.ingestionStores ?? {})) {
      expect(store).toBeDefined();
    }
  });

  it("selects the pinned production profile by omitting it", () => {
    const { paths, options } = build({});

    // Stating no profile is what selects granite, and granite is what makes
    // `hybrid` selection real. A profile named here would be the CLI quietly
    // choosing deterministic vectors.
    expect(options.embeddingProfile).toBeUndefined();
    expect(options.embeddingArtifactDirectory).toBe(paths.embeddingAssetDirectory);
  });

  it("carries the configured vector backend into the graph", () => {
    const withoutQdrant = build({});
    const withQdrant = build({ CONTEXTCTL_QDRANT_URL: "http://localhost:6333" });

    expect(withoutQdrant.options.vectorIndex).toBeDefined();
    expect(withQdrant.options.vectorIndex).toBeDefined();
    // Two different backends must not resolve to the same instance, or the
    // Qdrant setting would be decorative.
    expect(withQdrant.options.vectorIndex).not.toBe(
      withoutQdrant.options.vectorIndex,
    );
  });

  it("carries the selected meaning generator into the graph", () => {
    const deterministic = build({});
    const llm = build({
      CONTEXTCTL_CARD_MEANING_BASE_URL: "https://endpoint.example.com",
      CONTEXTCTL_CARD_MEANING_MODEL: "some-model",
      CONTEXTCTL_CARD_MEANING_API_KEY: "sk-not-a-real-key",
    });

    expect(deterministic.options.meanings).toBeDefined();
    expect(llm.options.meanings).toBeDefined();
    expect(llm.options.meanings).not.toBe(deterministic.options.meanings);
  });

  it("passes the registered Sources through unchanged", () => {
    const { options } = build({});

    // Field for field rather than by shape: Ingestion resolves configuration by
    // exact `configReference`, so a key this layer rewrote would produce a
    // Source that cannot be published under the name it was registered with.
    expect(options.sourceConfigurations).toEqual({
      "source.payment": { path: "/tmp/payment.md" },
    });
  });
});
