import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import type {
  PublicationReady,
  PublishedDocumentIndexRefV2 as PublishedDocumentIndexRef,
  PublishedDocumentScopeV2 as PublishedDocumentScope,
} from "@contextctl/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
  DeterministicEmbeddingAdapter,
  INGESTION_DATABASE_SCHEMA_VERSION,
  InMemoryIndexPublicationStoreV2 as InMemoryIndexPublicationStore,
  InMemoryPublicationReadyNotifier,
  InMemoryVectorIndexAdapter,
  IndexCatalogFault,
  IngestionDatabaseSchemaError,
  MAX_MANAGED_SEARCH_BATCH_TARGETS,
  ManagedDocumentSearch,
  PublicationReadyReconciler,
  SqliteIndexPublicationStore,
  SqliteIngestionPublicationStore,
  SqliteMarkdownPublicationCheckpointStore,
  StaticQueryEmbeddingProviderRegistry,
  StaticVectorIndexConnectorRegistry,
  UuidSourceIdGenerator,
  createLocalMarkdownPublicationRuntime,
  openIngestionDatabase,
  type EmbeddingPort,
  type EmbeddingProviderRequest,
  type IndexPublicationStoreV2 as IndexPublicationStore,
  type PublicationReadyNotifier,
  type PublishedIndexVersionV2 as PublishedIndexVersion,
  type PublishMarkdownSourceCommand,
  type VectorIndexPort,
} from "../src/index.js";
import { createIndexManifestFixture } from "./fixtures/document-fixture.js";

const STRUCTURE_FIXTURE = fileURLToPath(
  new URL("./fixtures/markdown/structure.md", import.meta.url),
);
const NOW = "2026-08-14T00:00:00.000Z";
const STATE_NAMESPACE_ID = "state_test";
const profile = {
  id: "durable-index-test",
  version: "1.0.0",
  model: "durable-index-test-v1",
  dimensions: 8,
  distance: "cosine" as const,
  maxInputTokens: 480,
  textMeasureProfileVersion: "unicode-estimate-v1",
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("durable Index control plane", () => {
  it("generates collision-resistant Source IDs for durable compositions", () => {
    const generator = new UuidSourceIdGenerator({
      randomUuid: () => "01890f5c-7b1a-7cc3-8a2f-123456789abc",
    });

    expect(generator.nextSourceId()).toBe(
      "src_01890f5c-7b1a-7cc3-8a2f-123456789abc",
    );
    expect(
      () =>
        new UuidSourceIdGenerator({ randomUuid: () => "not-a-uuid" })
          .nextSourceId(),
    ).toThrow(TypeError);
  });

  it("versions the control-plane schema and rejects newer or malformed databases", async () => {
    const directory = await mkdtemp(join(tmpdir(), "contextctl-schema-"));
    temporaryDirectories.push(directory);
    const healthyPath = join(directory, "healthy.sqlite");
    const healthy = openTestDatabase(healthyPath);
    expect(
      healthy.prepare("PRAGMA user_version").get(),
    ).toEqual({ user_version: INGESTION_DATABASE_SCHEMA_VERSION });
    healthy.close();
    expect(() =>
      openIngestionDatabase({
        location: healthyPath,
        stateNamespaceId: "state_other",
        securityDomain: "tenant-a",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<IngestionDatabaseSchemaError>>({
        code: "identity_mismatch",
      }),
    );
    expect(() =>
      openIngestionDatabase({
        location: healthyPath,
        stateNamespaceId: STATE_NAMESPACE_ID,
        securityDomain: "tenant-b",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<IngestionDatabaseSchemaError>>({
        code: "identity_mismatch",
      }),
    );

    const newerPath = join(directory, "newer.sqlite");
    const newer = new DatabaseSync(newerPath);
    newer.exec(
      `PRAGMA user_version = ${String(
        INGESTION_DATABASE_SCHEMA_VERSION + 1,
      )}`,
    );
    newer.close();
    expect(() => openTestDatabase(newerPath)).toThrowError(
      expect.objectContaining<Partial<IngestionDatabaseSchemaError>>({
        code: "schema_newer",
      }),
    );

    const malformedPath = join(directory, "malformed.sqlite");
    const malformed = new DatabaseSync(malformedPath);
    malformed.exec(`
      CREATE TABLE index_versions (document_index_id TEXT PRIMARY KEY);
      PRAGMA user_version = ${String(INGESTION_DATABASE_SCHEMA_VERSION)};
    `);
    malformed.close();
    expect(() => openTestDatabase(malformedPath)).toThrowError(
      expect.objectContaining<Partial<IngestionDatabaseSchemaError>>({
        code: "schema_invalid",
      }),
    );

    const legacyPath = join(directory, "legacy-with-state.sqlite");
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec(`
      CREATE TABLE index_versions (
        document_index_id TEXT NOT NULL,
        index_version TEXT NOT NULL,
        payload_schema_version INTEGER NOT NULL,
        publication_json TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        published_at TEXT NOT NULL,
        PRIMARY KEY (document_index_id, index_version)
      );
      INSERT INTO index_versions VALUES (
        'didx_legacy', 'idxv_aaaa', 2, '{}', 'legacy', '${NOW}'
      );
      PRAGMA user_version = 1;
    `);
    legacy.close();
    expect(() => openTestDatabase(legacyPath)).toThrowError(
      expect.objectContaining<Partial<IngestionDatabaseSchemaError>>({
        code: "schema_invalid",
      }),
    );
  });

  it.each(["memory", "sqlite"] as const)(
    "preserves immutable versions and an idempotent current pointer in %s",
    async (adapter) => {
      const database =
        adapter === "sqlite" ? openTestDatabase(":memory:") : undefined;
      const store: IndexPublicationStore =
        database === undefined
          ? new InMemoryIndexPublicationStore()
          : new SqliteIndexPublicationStore(database);
      const initial = publishedVersion("aaaa", NOW);
      const latest = publishedVersion("bbbb", "2026-08-14T01:00:00.000Z");

      expect(await store.commitCurrent(initial)).toMatchObject({
        status: "published",
      });
      expect(await store.commitCurrent(initial)).toMatchObject({
        status: "already_published",
      });
      expect(await store.commitCurrent(latest)).toMatchObject({
        status: "published",
      });
      expect(
        await store.findVersion({
          documentIndexId: initial.manifest.documentIndexId,
          indexVersion: initial.manifest.indexVersion,
        }),
      ).toEqual(initial);
      expect(await store.current(initial.manifest.documentIndexId)).toEqual(
        latest,
      );
      await expect(
        store.commitCurrent({
          ...initial,
          binding: { ...initial.binding, securityDomain: "" },
        }),
      ).rejects.toMatchObject({ name: "IndexPublicationStoreConflict" });
      database?.close();
    },
  );

  it("round-trips the complete production embedding profile through durable catalog state", async () => {
    const database = openTestDatabase(":memory:");
    const store = new SqliteIndexPublicationStore(database);
    const publication = publishedVersion("aaaa", NOW);
    const productionPublication: PublishedIndexVersion = {
      ...publication,
      manifest: {
        ...publication.manifest,
        embeddingProfile: DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
      },
    };

    await store.commitCurrent(productionPublication);
    const restored = await store.findVersion({
      documentIndexId: productionPublication.manifest.documentIndexId,
      indexVersion: productionPublication.manifest.indexVersion,
    });

    expect(restored?.manifest.embeddingProfile).toEqual(
      DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
    );
    database.close();
  });

  it("recreates the Markdown composition and searches the same durable version and Scope", async () => {
    const fixture = await createTemporaryFixture();
    const vectorIndex = new RecordingVectorIndex(
      new InMemoryVectorIndexAdapter(),
    );
    const embeddings = new RecordingEmbeddingPort(
      new DeterministicEmbeddingAdapter(),
    );
    const firstDatabase = openTestDatabase(fixture.databasePath);
    const first = createDurableRuntime(
      fixture.markdownPath,
      firstDatabase,
      vectorIndex,
      embeddings,
    );

    const published = await first.workflow.publish(command());
    const publication = requiredValue(published.publication);
    const retryUnit = publication.knowledgeUnits.find((unit) =>
      unit.facts.some(
        (fact) => fact.name === "section.label" && fact.value === "재시도",
      ),
    );
    const scope = requiredManagedScope(retryUnit?.publishedScopes[0]);
    const callsAfterPublish = embeddings.requests.length;
    firstDatabase.close();

    const secondDatabase = openTestDatabase(fixture.databasePath);
    const second = createDurableRuntime(
      fixture.markdownPath,
      secondDatabase,
      vectorIndex,
      embeddings,
    );
    const repeated = await second.workflow.publish(command());
    const hits = await second.search.search({
      queryText: "결제 재시도 절차",
      securityDomain: "tenant-a",
      scopeRef: scopeRef(scope),
      limit: 5,
    });

    expect(repeated.status).toBe("unchanged");
    expect(repeated.publication?.publicationId).toBe(publication.publicationId);
    expect(hits.some((hit) => hit.text.includes("재시도"))).toBe(true);
    expect(embeddings.requests).toHaveLength(callsAfterPublish + 1);
    expect(vectorIndex.rehydrateCalls).toBe(1);
    expect(
      await second.indexPublications.findVersion({
        documentIndexId: scope.documentIndex.documentIndexId,
        indexVersion: scope.documentIndex.indexVersion,
      }),
    ).toBeDefined();
    secondDatabase.close();
  });

  it("restores the indexing snapshot and incrementally re-indexes after restart", async () => {
    const fixture = await createTemporaryFixture();
    const vectorIndex = new RecordingVectorIndex(
      new InMemoryVectorIndexAdapter(),
    );
    const embeddings = new RecordingEmbeddingPort(
      new DeterministicEmbeddingAdapter(),
    );
    const firstDatabase = openTestDatabase(fixture.databasePath);
    const first = createDurableRuntime(
      fixture.markdownPath,
      firstDatabase,
      vectorIndex,
      embeddings,
    );

    const baseline = await first.workflow.publish(command());
    const requestsAfterBaseline = embeddings.requests.length;
    firstDatabase.close();
    const markdown = await readFile(fixture.markdownPath, "utf8");
    await writeFile(
      fixture.markdownPath,
      markdown.replace(
        "재시도를 실행합니다.",
        "재시도를 최대 세 번 실행합니다.",
      ),
      "utf8",
    );

    const secondDatabase = openTestDatabase(fixture.databasePath);
    const second = createDurableRuntime(
      fixture.markdownPath,
      secondDatabase,
      vectorIndex,
      embeddings,
    );
    const updated = await second.workflow.publish(command());
    const checkpoint = await second.checkpoints.findBySourceId(
      baseline.sourceId,
    );
    const incrementalInputCount = embeddings.requests
      .slice(requestsAfterBaseline)
      .reduce((count, request) => count + request.inputs.length, 0);

    expect(updated.status).toBe("published");
    expect(updated.indexVersion).not.toBe(baseline.indexVersion);
    expect(checkpoint?.indexingSnapshot).toBeDefined();
    expect(incrementalInputCount).toBeGreaterThan(0);
    expect(incrementalInputCount).toBeLessThan(
      checkpoint?.indexingSnapshot?.chunks.length ?? 0,
    );
    expect(vectorIndex.rehydrateCalls).toBeGreaterThan(0);
    secondDatabase.close();
  });

  it("rolls back a new version when the atomic current transition fails", async () => {
    const database = openTestDatabase(":memory:");
    const store = new SqliteIndexPublicationStore(database);
    const initial = publishedVersion("aaaa", NOW);
    const interrupted = publishedVersion(
      "bbbb",
      "2026-08-14T01:00:00.000Z",
    );
    await store.commitCurrent(initial);
    database.exec(`
      CREATE TRIGGER reject_current_transition
      BEFORE UPDATE ON current_index_versions
      BEGIN
        SELECT RAISE(ABORT, 'simulated current failure');
      END;
    `);

    await expect(store.commitCurrent(interrupted)).rejects.toBeInstanceOf(
      IndexCatalogFault,
    );
    expect(await store.current(initial.manifest.documentIndexId)).toEqual(
      initial,
    );
    expect(
      await store.findVersion({
        documentIndexId: interrupted.manifest.documentIndexId,
        indexVersion: interrupted.manifest.indexVersion,
      }),
    ).toBeUndefined();
    database.close();
  });

  it("shares query embedding and binding rehydration per request while isolating target failures", async () => {
    const fixture = await createTemporaryFixture();
    const database = openTestDatabase(fixture.databasePath);
    const vectorIndex = new RecordingVectorIndex(
      new InMemoryVectorIndexAdapter(),
    );
    const embeddings = new RecordingEmbeddingPort(
      new DeterministicEmbeddingAdapter(),
    );
    const runtime = createDurableRuntime(
      fixture.markdownPath,
      database,
      vectorIndex,
      embeddings,
    );
    const result = await runtime.workflow.publish(command());
    const publication = requiredValue(result.publication);
    const scopes = publication.knowledgeUnits.map((unit) =>
      requiredManagedScope(unit.publishedScopes[0]),
    );
    const callsBeforeSearch = embeddings.requests.length;
    const rehydratesBeforeSearch = vectorIndex.rehydrateCalls;

    const items = await runtime.search.searchBatch({
      queryText: "결제 재시도",
      securityDomain: "tenant-a",
      targets: [
        target("document", scopes[0]!),
        target("section", scopes[1]!),
        target("missing", { ...scopes[1]!, scopeId: "scope_missing" }),
      ],
    });

    expect(items.map((item) => [item.targetKey, item.status])).toEqual([
      ["document", "fulfilled"],
      ["section", "fulfilled"],
      ["missing", "failed"],
    ]);
    expect(items[2]).toMatchObject({
      failure: { code: "scope_not_published", retriable: false },
    });
    expect(embeddings.requests).toHaveLength(callsBeforeSearch + 1);
    expect(vectorIndex.rehydrateCalls).toBe(rehydratesBeforeSearch + 1);
    expect(vectorIndex.searchCalls).toBe(2);
    database.close();
  });

  it("bounds batch size, query input, and concurrent target searches", async () => {
    const fixture = await createTemporaryFixture();
    const database = openTestDatabase(fixture.databasePath);
    const vectorIndex = new RecordingVectorIndex(
      new InMemoryVectorIndexAdapter(),
      5,
    );
    const embeddings = new RecordingEmbeddingPort(
      new DeterministicEmbeddingAdapter(),
    );
    const runtime = createDurableRuntime(
      fixture.markdownPath,
      database,
      vectorIndex,
      embeddings,
    );
    const published = await runtime.workflow.publish(command());
    const scope = requiredManagedScope(
      requiredValue(published.publication).knowledgeUnits[0]?.publishedScopes[0],
    );
    const managedSearch = new ManagedDocumentSearch({
      embeddingProviders: providerRegistry(embeddings),
      vectorIndexes: new StaticVectorIndexConnectorRegistry([
        { connectorId: "vector.local", vectorIndex },
      ]),
      publications: runtime.indexPublications,
      maxConcurrency: 3,
    });

    const items = await managedSearch.searchBatch({
      queryText: "결제 재시도",
      securityDomain: "tenant-a",
      targets: Array.from({ length: 12 }, (_, index) =>
        target(`bounded-${String(index)}`, scope),
      ),
    });
    expect(items.every((item) => item.status === "fulfilled")).toBe(true);
    expect(vectorIndex.maxConcurrentSearches).toBe(3);

    await expect(
      managedSearch.searchBatch({
        queryText: "bounded batch",
        securityDomain: "tenant-a",
        targets: Array.from(
          { length: MAX_MANAGED_SEARCH_BATCH_TARGETS + 1 },
          (_, index) => target(`overflow-${String(index)}`, scope),
        ),
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });

    const callsBeforeOversizedQuery = embeddings.requests.length;
    const oversized = await managedSearch.searchBatch({
      queryText: "a".repeat(profile.maxInputTokens * 4 + 1),
      securityDomain: "tenant-a",
      targets: [target("oversized-query", scope)],
    });
    expect(oversized[0]).toMatchObject({
      status: "failed",
      failure: {
        code: "query_input_limit_exceeded",
        retriable: false,
      },
    });
    expect(embeddings.requests).toHaveLength(callsBeforeOversizedQuery);
    database.close();
  });

  it("never shares a query vector across security domains", async () => {
    const vectorIndex = new RecordingVectorIndex(
      new InMemoryVectorIndexAdapter(),
    );
    const tenantA = await vectorIndex.prepare({
      stateNamespaceId: STATE_NAMESPACE_ID,
      securityDomain: "tenant-a",
      embeddingProfile: profile,
      payloadSchemaVersion: 2,
    });
    const tenantB = await vectorIndex.prepare({
      stateNamespaceId: STATE_NAMESPACE_ID,
      securityDomain: "tenant-b",
      embeddingProfile: profile,
      payloadSchemaVersion: 2,
    });
    const publicationA = domainPublishedVersion(
      "alpha",
      "tenant-a",
      tenantA.accessHandle,
    );
    const publicationB = domainPublishedVersion(
      "bravo",
      "tenant-b",
      tenantB.accessHandle,
    );
    const catalog = new InMemoryIndexPublicationStore();
    await catalog.commitCurrent(publicationA);
    await catalog.commitCurrent(publicationB);
    const tenantAEmbeddings = new RecordingEmbeddingPort(
      new DeterministicEmbeddingAdapter(),
    );
    const tenantBEmbeddings = new RecordingEmbeddingPort(
      new DeterministicEmbeddingAdapter(),
    );
    const managedSearch = new ManagedDocumentSearch({
      embeddingProviders: new StaticQueryEmbeddingProviderRegistry([
        {
          securityDomain: "tenant-a",
          embeddingProfile: profile,
          providerId: "provider.tenant-a",
          provider: tenantAEmbeddings,
        },
        {
          securityDomain: "tenant-b",
          embeddingProfile: profile,
          providerId: "provider.tenant-b",
          provider: tenantBEmbeddings,
        },
      ]),
      vectorIndexes: new StaticVectorIndexConnectorRegistry([
        { connectorId: "vector.main", vectorIndex },
      ]),
      publications: catalog,
    });

    const results = (
      await Promise.all([
        managedSearch.searchBatch({
          queryText: "shared query text",
          securityDomain: "tenant-a",
          targets: [target("tenant-a", publicationA.scopes[0]!)],
        }),
        managedSearch.searchBatch({
          queryText: "shared query text",
          securityDomain: "tenant-b",
          targets: [
            {
              targetKey: "tenant-b",
              scopeRef: scopeRef(publicationB.scopes[0]!),
              limit: 5,
            },
          ],
        }),
      ])
    ).flat();

    expect(results.every((item) => item.status === "fulfilled")).toBe(true);
    expect(tenantAEmbeddings.requests).toHaveLength(1);
    expect(tenantBEmbeddings.requests).toHaveLength(1);
    expect(vectorIndex.rehydrateCalls).toBe(2);
    expect(
      () =>
        new StaticQueryEmbeddingProviderRegistry([
          {
            securityDomain: "tenant-a",
            embeddingProfile: profile,
            providerId: "provider.shared-credential",
            provider: tenantAEmbeddings,
          },
          {
            securityDomain: "tenant-b",
            embeddingProfile: profile,
            providerId: "provider.shared-credential",
            provider: tenantBEmbeddings,
          },
        ]),
    ).toThrow(/crosses security domains/);
    expect(
      () =>
        new StaticQueryEmbeddingProviderRegistry([
          {
            securityDomain: "tenant-a",
            embeddingProfile: profile,
            providerId: "provider.tenant-a-second",
            provider: tenantAEmbeddings,
          },
          {
            securityDomain: "tenant-b",
            embeddingProfile: profile,
            providerId: "provider.tenant-b-second",
            provider: tenantAEmbeddings,
          },
        ]),
    ).toThrow(/instance crosses security domains/);
  });

  it("fails closed for a disallowed provider, missing binding, and corrupt catalog record", async () => {
    const fixture = await createTemporaryFixture();
    const database = openTestDatabase(fixture.databasePath);
    const vectorIndex = new RecordingVectorIndex(
      new InMemoryVectorIndexAdapter(),
    );
    const embeddings = new RecordingEmbeddingPort(
      new DeterministicEmbeddingAdapter(),
    );
    const runtime = createDurableRuntime(
      fixture.markdownPath,
      database,
      vectorIndex,
      embeddings,
    );
    const result = await runtime.workflow.publish(command());
    const scope = requiredManagedScope(
      requiredValue(result.publication).knowledgeUnits[0]?.publishedScopes[0],
    );

    const providerDenied = new ManagedDocumentSearch({
      embeddingProviders: new StaticQueryEmbeddingProviderRegistry([]),
      vectorIndexes: new StaticVectorIndexConnectorRegistry([
        { connectorId: "vector.local", vectorIndex },
      ]),
      publications: runtime.indexPublications,
    });
    await expect(search(providerDenied, scope)).rejects.toMatchObject({
      code: "embedding_provider_not_allowed",
    });

    const bindingMissing = new ManagedDocumentSearch({
      embeddingProviders: providerRegistry(embeddings),
      vectorIndexes: new StaticVectorIndexConnectorRegistry([]),
      publications: runtime.indexPublications,
    });
    await expect(search(bindingMissing, scope)).rejects.toMatchObject({
      code: "index_binding_unavailable",
    });

    const missingPhysicalBinding = domainPublishedVersion(
      "alpha",
      "tenant-a",
      "memory:v1:missing",
    );
    const isolatedCatalog = new InMemoryIndexPublicationStore();
    await isolatedCatalog.commitCurrent(missingPhysicalBinding);
    const bindingUnavailable = new ManagedDocumentSearch({
      embeddingProviders: providerRegistry(embeddings),
      vectorIndexes: new StaticVectorIndexConnectorRegistry([
        { connectorId: "vector.main", vectorIndex },
      ]),
      publications: isolatedCatalog,
    });
    await expect(
      search(bindingUnavailable, missingPhysicalBinding.scopes[0]!),
    ).rejects.toMatchObject({ code: "index_binding_unavailable" });

    database
      .prepare(
        `UPDATE index_versions SET publication_json = '{}'
         WHERE document_index_id = ? AND index_version = ?`,
      )
      .run(scope.documentIndex.documentIndexId, scope.documentIndex.indexVersion);
    await expect(search(runtime.search, scope)).rejects.toMatchObject({
      code: "index_catalog_corrupt",
    });
    expect(vectorIndex.searchCalls).toBe(0);
    database.close();
  });

  it("rejects a payload v1 catalog target and serves its v2 replacement", async () => {
    const fixture = await createTemporaryFixture();
    const database = openTestDatabase(fixture.databasePath);
    const vectorIndex = new RecordingVectorIndex(
      new InMemoryVectorIndexAdapter(),
    );
    const embeddings = new RecordingEmbeddingPort(
      new DeterministicEmbeddingAdapter(),
    );
    const runtime = createDurableRuntime(
      fixture.markdownPath,
      database,
      vectorIndex,
      embeddings,
    );
    const result = await runtime.workflow.publish(command());
    const v2Scope = requiredManagedScope(
      requiredValue(result.publication).knowledgeUnits[0]?.publishedScopes[0],
    );
    const row = database
      .prepare(
        `SELECT publication_json FROM index_versions
         WHERE document_index_id = ? AND index_version = ?`,
      )
      .get(
        v2Scope.documentIndex.documentIndexId,
        v2Scope.documentIndex.indexVersion,
      ) as { readonly publication_json: string };
    const v1 = JSON.parse(row.publication_json) as Record<string, unknown>;
    const v1Scope = downgradeToV1(v1);
    database
      .prepare(
        `INSERT INTO index_versions (
           document_index_id, index_version, payload_schema_version,
           publication_json, fingerprint, published_at
         ) VALUES (?, ?, 1, ?, 'legacy-v1', ?)`,
      )
      .run(
        v1Scope.documentIndex.documentIndexId,
        v1Scope.documentIndex.indexVersion,
        JSON.stringify(v1),
        NOW,
      );
    database
      .prepare(
        `INSERT INTO published_scope_catalog (
           scope_id, scope_version, document_index_id, index_version,
           scope_json, publication_fingerprint
         ) VALUES (?, ?, ?, ?, ?, 'legacy-v1')`,
      )
      .run(
        v1Scope.scopeId,
        v1Scope.scopeVersion,
        v1Scope.documentIndex.documentIndexId,
        v1Scope.documentIndex.indexVersion,
        JSON.stringify(v1Scope),
      );

    await expect(search(runtime.search, v1Scope)).rejects.toMatchObject({
      code: "index_schema_unsupported",
    });
    await expect(search(runtime.search, v2Scope)).resolves.not.toEqual([]);
    database.close();
  });

  it("rediscovers and delivers a committed ready notification after restart", async () => {
    const fixture = await createTemporaryFixture();
    const vectorIndex = new InMemoryVectorIndexAdapter();
    const firstDatabase = openTestDatabase(fixture.databasePath);
    const first = createDurableRuntime(
      fixture.markdownPath,
      firstDatabase,
      vectorIndex,
      new DeterministicEmbeddingAdapter(),
      new AlwaysFailNotifier(),
    );

    await expect(first.workflow.publish(command())).rejects.toMatchObject({
      stage: "ready_notification",
      diagnosticCode: "notification_unavailable",
    });
    const pending = await first.publications.pendingReady();
    expect(pending).toHaveLength(1);
    firstDatabase.close();

    const secondDatabase = openTestDatabase(fixture.databasePath);
    const publications = new SqliteIngestionPublicationStore(secondDatabase);
    const notifier = new InMemoryPublicationReadyNotifier();
    const reconciled = await new PublicationReadyReconciler({
      publications,
      notifier,
    }).reconcile();

    expect(reconciled).toEqual([
      { publicationId: pending[0]!.publicationId, status: "delivered" },
    ]);
    expect(notifier.notifications).toEqual(pending);
    expect(await publications.pendingReady()).toEqual([]);
    expect(await publications.find(pending[0]!.publicationId)).toBeDefined();
    secondDatabase.close();
  });
});

function createDurableRuntime(
  markdownPath: string,
  database: DatabaseSync,
  vectorIndex: VectorIndexPort,
  embeddingProvider: EmbeddingPort,
  readyNotifier?: PublicationReadyNotifier,
) {
  return createLocalMarkdownPublicationRuntime({
    configurations: { "source.fixture": { path: markdownPath } },
    embeddingProfile: profile,
    embeddingProvider,
    vectorIndex,
    connectorId: "vector.local",
    stateNamespaceId: STATE_NAMESPACE_ID,
    securityDomain: "tenant-a",
    checkpoints: new SqliteMarkdownPublicationCheckpointStore(database),
    publications: new SqliteIngestionPublicationStore(database),
    indexPublications: new SqliteIndexPublicationStore(database),
    sourceIds: new UuidSourceIdGenerator(),
    ...(readyNotifier === undefined ? {} : { readyNotifier }),
    clock: () => NOW,
  });
}

async function createTemporaryFixture(): Promise<{
  readonly databasePath: string;
  readonly markdownPath: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "contextctl-durable-index-"));
  temporaryDirectories.push(directory);
  const markdownPath = join(directory, "source.md");
  await copyFile(STRUCTURE_FIXTURE, markdownPath);
  return { databasePath: join(directory, "ingestion.sqlite"), markdownPath };
}

function command(): PublishMarkdownSourceCommand {
  return {
    source: {
      sourceType: "markdown",
      displayName: "Durable Markdown fixture",
      configReference: "source.fixture",
      polling: { enabled: false },
    },
    connectorId: "vector.local",
    securityDomain: "tenant-a",
  };
}

function target(
  targetKey: string,
  scope: PublishedDocumentScope,
) {
  return { targetKey, scopeRef: scopeRef(scope), limit: 5 };
}

function search(
  managedSearch: ManagedDocumentSearch,
  scope: PublishedDocumentScope,
) {
  return managedSearch.search({
    queryText: "결제 재시도",
    securityDomain: "tenant-a",
    scopeRef: scopeRef(scope),
    limit: 5,
  });
}

function providerRegistry(provider: EmbeddingPort) {
  return new StaticQueryEmbeddingProviderRegistry([
    {
      securityDomain: "tenant-a",
      embeddingProfile: profile,
      providerId: "provider.durable-test",
      provider,
    },
  ]);
}

function publishedVersion(
  revision: "aaaa" | "bbbb",
  publishedAt: string,
): PublishedIndexVersion {
  const manifest = {
    ...createIndexManifestFixture(),
    indexVersion: `idxv_${revision}`,
    scopeRevisions: [
      {
        scopeId: "scope_payment_failures",
        scopeVersion: `scpv_${revision}`,
      },
    ],
    publishedAt,
  };
  const documentIndex: PublishedDocumentIndexRef = {
    documentIndexId: manifest.documentIndexId,
    sourceId: manifest.sourceId,
    documentId: manifest.documentId,
    indexVersion: manifest.indexVersion,
  };
  return {
    manifest: {
      ...manifest,
      stateNamespaceId: STATE_NAMESPACE_ID,
      securityDomain: "tenant-a",
    },
    documentIndex,
    scopes: [
      {
        scopeId: "scope_payment_failures",
        scopeVersion: `scpv_${revision}`,
        kind: "managed_document",
        documentIndex,
        selector: { kind: "document" },
      },
    ],
    binding: {
      stateNamespaceId: STATE_NAMESPACE_ID,
      documentIndexId: manifest.documentIndexId,
      indexVersion: manifest.indexVersion,
      connectorId: "vector.main",
      accessHandle: "memory:v1:durable-fixture",
      securityDomain: "tenant-a",
    },
  };
}

function domainPublishedVersion(
  suffix: "alpha" | "bravo",
  securityDomain: string,
  accessHandle: string,
): PublishedIndexVersion {
  const manifest = {
    ...createIndexManifestFixture(),
    documentIndexId: `didx_${suffix}`,
    sourceId: `src_${suffix}`,
    observationId: `obs_${suffix}`,
    documentId: `doc_${suffix}`,
    embeddingProfile: profile,
    scopeRevisions: [
      { scopeId: `scope_${suffix}`, scopeVersion: "scpv_aaaa" },
    ],
    publishedAt: NOW,
  };
  const documentIndex: PublishedDocumentIndexRef = {
    documentIndexId: manifest.documentIndexId,
    sourceId: manifest.sourceId,
    documentId: manifest.documentId,
    indexVersion: manifest.indexVersion,
  };
  return {
    manifest: { ...manifest, stateNamespaceId: STATE_NAMESPACE_ID, securityDomain },
    documentIndex,
    scopes: [
      {
        scopeId: `scope_${suffix}`,
        scopeVersion: "scpv_aaaa",
        kind: "managed_document",
        documentIndex,
        selector: { kind: "document" },
      },
    ],
    binding: {
      stateNamespaceId: STATE_NAMESPACE_ID,
      documentIndexId: manifest.documentIndexId,
      indexVersion: manifest.indexVersion,
      connectorId: "vector.main",
      accessHandle,
      securityDomain,
    },
  };
}

function scopeRef(scope: PublishedDocumentScope) {
  return { scopeId: scope.scopeId, scopeVersion: scope.scopeVersion };
}

function openTestDatabase(location: string): DatabaseSync {
  return openIngestionDatabase({
    location,
    stateNamespaceId: STATE_NAMESPACE_ID,
    securityDomain: "tenant-a",
  });
}

function downgradeToV1(
  publication: Record<string, unknown>,
): PublishedDocumentScope {
  const manifest = publication.manifest as Record<string, unknown>;
  const documentIndex = publication.documentIndex as Record<string, unknown>;
  const scopes = publication.scopes as Array<Record<string, unknown>>;
  const v1Version = "idxv_vvvv";
  const v1ScopeVersion = "scpv_vvvv";
  manifest.payloadSchemaVersion = 1;
  manifest.indexVersion = v1Version;
  manifest.scopeRevisions = [
    { scopeId: scopes[0]!.scopeId, scopeVersion: v1ScopeVersion },
  ];
  documentIndex.indexVersion = v1Version;
  scopes[0]!.scopeVersion = v1ScopeVersion;
  scopes[0]!.documentIndex = structuredClone(documentIndex);
  return structuredClone(scopes[0]) as PublishedDocumentScope;
}

function requiredManagedScope(
  value: unknown,
): PublishedDocumentScope {
  if (
    value === undefined ||
    value === null ||
    typeof value !== "object" ||
    !("kind" in value) ||
    value.kind !== "managed_document"
  ) {
    throw new Error("managed document Scope is missing");
  }
  return value as PublishedDocumentScope;
}

function requiredValue<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("required fixture value is missing");
  return value;
}

class RecordingEmbeddingPort implements EmbeddingPort {
  readonly requests: EmbeddingProviderRequest[] = [];

  constructor(private readonly delegate: EmbeddingPort) {}

  async embed(request: EmbeddingProviderRequest) {
    this.requests.push(request);
    return this.delegate.embed(request);
  }
}

class RecordingVectorIndex implements VectorIndexPort {
  rehydrateCalls = 0;
  searchCalls = 0;
  activeSearches = 0;
  maxConcurrentSearches = 0;

  constructor(
    private readonly delegate: VectorIndexPort,
    private readonly searchDelayMs = 0,
  ) {}

  prepare: VectorIndexPort["prepare"] = (input) => this.delegate.prepare(input);
  upsertRecords: VectorIndexPort["upsertRecords"] = (input) =>
    this.delegate.upsertRecords(input);
  listVersionRecords: VectorIndexPort["listVersionRecords"] = (input) =>
    this.delegate.listVersionRecords(input);
  readVersionVectors: VectorIndexPort["readVersionVectors"] = (input) =>
    this.delegate.readVersionVectors(input);
  retainVersion: VectorIndexPort["retainVersion"] = (input) =>
    this.delegate.retainVersion(input);
  releaseRetentionLease: VectorIndexPort["releaseRetentionLease"] = (input) =>
    this.delegate.releaseRetentionLease(input);
  deleteVersion: VectorIndexPort["deleteVersion"] = (input) =>
    this.delegate.deleteVersion(input);

  async rehydrate(input: Parameters<VectorIndexPort["rehydrate"]>[0]) {
    this.rehydrateCalls += 1;
    return this.delegate.rehydrate(input);
  }

  async search(input: Parameters<VectorIndexPort["search"]>[0]) {
    this.searchCalls += 1;
    this.activeSearches += 1;
    this.maxConcurrentSearches = Math.max(
      this.maxConcurrentSearches,
      this.activeSearches,
    );
    try {
      if (this.searchDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.searchDelayMs));
      }
      return await this.delegate.search(input);
    } finally {
      this.activeSearches -= 1;
    }
  }
}

class AlwaysFailNotifier implements PublicationReadyNotifier {
  async notify(_notification: PublicationReady): Promise<void> {
    throw new NotificationUnavailable();
  }
}

class NotificationUnavailable extends Error {
  readonly code = "notification_unavailable";
}
