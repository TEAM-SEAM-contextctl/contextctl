import { openIngestionDatabase } from "@contextctl/ingestion-indexing";
import type { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_SECURITY_DOMAIN,
  DEFAULT_STATE_NAMESPACE_ID,
} from "../../src/main.js";
import { resolveCardMeaningBackend } from "../../src/cli/meaning-generator.js";
import { resolveContextctlPaths } from "../../src/cli/paths.js";
import {
  cliRuntimeOptions,
  buildCliRuntime,
  EmbeddingAssetsUnavailableError,
  resolveCliEmbeddingRuntime,
} from "../../src/cli/runtime.js";
import { resolveVectorBackend } from "../../src/vector-backend.js";
import {
  CARD_EMBEDDING_API_KEY_VARIABLE,
  CARD_EMBEDDING_ENDPOINT_VARIABLE,
  CARD_EMBEDDING_MODE_VARIABLE,
  CARD_EMBEDDING_PROFILE_VARIABLE,
  DOCUMENT_EMBEDDING_API_KEY_VARIABLE,
  DOCUMENT_EMBEDDING_ENDPOINT_VARIABLE,
  DOCUMENT_EMBEDDING_MODE_VARIABLE,
  DOCUMENT_EMBEDDING_PROFILE_VARIABLE,
  readActiveEmbeddingProfiles,
  readEmbeddingCompositionConfiguration,
} from "../../src/embedding/configuration.js";
import {
  remoteCardProfile,
  remoteDocumentProfile,
} from "../embedding/fakes.js";

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
const temporaryDirectories: string[] = [];

afterEach(() => {
  while (databases.length > 0) {
    databases.pop()?.close();
  }
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true });
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
  const configuredEnvironment = {
    CONTEXTCTL_QDRANT_URL: "http://localhost:6333",
    ...environment,
  };
  const paths = resolveContextctlPaths(
    configuredEnvironment,
    "/tmp/contextctl-test-cwd",
  );
  const configuration = readEmbeddingCompositionConfiguration(
    configuredEnvironment,
    DEFAULT_SECURITY_DOMAIN,
  );
  const profiles = readActiveEmbeddingProfiles(
    configuredEnvironment,
    configuration,
  );
  return {
    paths,
    options: cliRuntimeOptions({
      environment: configuredEnvironment,
      paths,
      sourceConfigurations: { "source.payment": { path: "/tmp/payment.md" } },
      ingestionDatabase: ingestionDatabase(),
      // The revision directory, as `buildCliRuntime` resolves it from the
      // pointer. Passing `paths.embeddingAssetDirectory` here would restate the
      // bug these options exist to prevent.
      embeddingRuntime: {
        configuration,
        profiles,
        artifactDirectory: "/tmp/contextctl-test-assets/revisions/abc",
        requiredBindings: {
          documentProfiles: [profiles.document],
          cardProfile: profiles.card,
          requirements: [],
          needsLocalAssets: true,
        },
      },
      vectorBackend: resolveVectorBackend(configuredEnvironment),
      meaningBackend: resolveCardMeaningBackend({
        environment: configuredEnvironment,
        onFallback: () => {},
      }),
    }),
  };
}

describe("CLI runtime options", () => {
  it("refuses missing active assets before creating state databases", async () => {
    const home = mkdtempSync(join(tmpdir(), "contextctl-local-preflight-"));
    temporaryDirectories.push(home);
    const environment = {
      CONTEXTCTL_HOME: home,
      CONTEXTCTL_QDRANT_URL: "http://localhost:6333",
    };
    const paths = resolveContextctlPaths(environment, home);

    await expect(
      buildCliRuntime({
        environment,
        workingDirectory: home,
        diagnostics: () => {},
      }),
    ).rejects.toBeInstanceOf(EmbeddingAssetsUnavailableError);
    expect(existsSync(paths.registryDatabase)).toBe(false);
    expect(existsSync(paths.ingestionDatabase)).toBe(false);
  });

  it("resolves remote/remote without reading a local asset pointer", async () => {
    const home = mkdtempSync(join(tmpdir(), "contextctl-remote-runtime-"));
    temporaryDirectories.push(home);
    const environment = {
      CONTEXTCTL_HOME: home,
      [DOCUMENT_EMBEDDING_MODE_VARIABLE]: "remote",
      [DOCUMENT_EMBEDDING_ENDPOINT_VARIABLE]:
        "https://documents.example/v1/embeddings",
      [DOCUMENT_EMBEDDING_API_KEY_VARIABLE]: "document-secret",
      [DOCUMENT_EMBEDDING_PROFILE_VARIABLE]: JSON.stringify(
        remoteDocumentProfile(),
      ),
      [CARD_EMBEDDING_MODE_VARIABLE]: "remote",
      [CARD_EMBEDDING_ENDPOINT_VARIABLE]:
        "https://cards.example/v1/embeddings",
      [CARD_EMBEDDING_API_KEY_VARIABLE]: "card-secret",
      [CARD_EMBEDDING_PROFILE_VARIABLE]: JSON.stringify(remoteCardProfile()),
    };
    const paths = resolveContextctlPaths(environment, home);
    const database = openIngestionDatabase({
      location: paths.ingestionDatabase,
      stateNamespaceId: DEFAULT_STATE_NAMESPACE_ID,
      securityDomain: DEFAULT_SECURITY_DOMAIN,
    });
    databases.push(database);

    const resolved = await resolveCliEmbeddingRuntime({
      environment,
      paths,
      ingestionDatabase: database,
    });

    expect(resolved.configuration.document.mode).toBe("remote");
    expect(resolved.configuration.card.mode).toBe("remote");
    expect(resolved.artifactDirectory).toBeUndefined();
  });

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

  it("passes the pinned production profiles and resolved asset revision", () => {
    const { paths, options } = build({});

    expect(options.embeddingProfile?.id).toBe(
      "document-granite-97m-multilingual-r2-fp32-v1",
    );
    expect(options.cardSelectionProfile?.id).toBe(
      "card-granite-97m-multilingual-r2-fp32-v1",
    );
    // The resolved revision directory, never the managed root. The adapter reads
    // its manifest directly out of whatever it is handed, so the root would send
    // it one level too high — which is exactly how a passing `doctor` and a
    // failing `ingest` coexisted.
    expect(options.embeddingArtifactDirectory).toBe(
      "/tmp/contextctl-test-assets/revisions/abc",
    );
    expect(options.embeddingArtifactDirectory).not.toBe(
      paths.embeddingAssetDirectory,
    );
  });

  it("carries the configured vector backend into the graph", () => {
    const { options } = build({
      CONTEXTCTL_QDRANT_URL: "http://localhost:7444",
    });

    expect(options.vectorIndex).toBeDefined();
    expect(() => resolveVectorBackend({})).toThrow(
      "CONTEXTCTL_QDRANT_URL이 필요합니다",
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

  it("carries the access policy into the graph through one resolver", () => {
    // Both composition paths — the CLI runtime behind `query` and the served
    // process behind MCP and HTTP — obtain their options here, so the policy
    // they run under is read in exactly one place.
    expect(build({}).options.policy).toEqual({
      usage: "retrieval",
      sensitiveAccess: "deny",
    });
    expect(build({ CONTEXTCTL_SENSITIVE_ACCESS: "allow" }).options.policy).toEqual({
      usage: "retrieval",
      sensitiveAccess: "allow",
    });
    expect(() => build({ CONTEXTCTL_SENSITIVE_ACCESS: "maybe" })).toThrow(
      "CONTEXTCTL_SENSITIVE_ACCESS 는 deny 또는 allow 만 받는다",
    );
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
