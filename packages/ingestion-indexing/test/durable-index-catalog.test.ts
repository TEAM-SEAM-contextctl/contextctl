import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import type {
  PublicationReady,
  PublishedDocumentIndexRef,
  PublishedDocumentScope,
} from "@contextctl/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
  DeterministicEmbeddingAdapter,
  INGESTION_DATABASE_APPLICATION_ID,
  INGESTION_DATABASE_SCHEMA_VERSION,
  InMemoryIndexPublicationStore,
  InMemoryPublicationReadyNotifier,
  InMemoryVectorIndexAdapter,
  IndexCatalogFault,
  IngestionDatabaseSchemaError,
  MAX_MANAGED_SEARCH_BATCH_TARGETS,
  ManagedDocumentSearch,
  PublicationReadyReconciler,
  SqliteIndexPublicationStore,
  SqliteIndexStagingAttemptStore,
  SqliteIngestionPublicationStore,
  SqliteMarkdownPublicationCheckpointStore,
  SqliteSourceObservationStore,
  StaticQueryEmbeddingProviderRegistry,
  StaticVectorIndexConnectorRegistry,
  UuidSourceIdGenerator,
  UuidV7RootIdGenerator,
  createLocalMarkdownPublicationRuntime,
  createSourceObservation,
  openIngestionDatabase,
  type EmbeddingPort,
  type EmbeddingProviderRequest,
  type IndexPublicationStore,
  type IngestionPublicationStore,
  type PublicationReadyNotifier,
  type PublishedIndexVersion,
  type PublishMarkdownSourceCommand,
  type StructuralIdGenerator,
  type VectorIndexPort,
} from "../src/index.js";
import { createIndexManifestFixture } from "./fixtures/document-fixture.js";
import { rootId, structuralId } from "./fixtures/root-id-fixture.js";

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
      now: () => Number.parseInt("01890f5c7b1a", 16),
      random: () => Uint8Array.from([12, 195, 10, 47, 18, 52, 86, 120, 154, 188]),
    });

    expect(generator.nextSourceId()).toBe(
      "src_01890f5c-7b1a-7cc3-8a2f-123456789abc",
    );
    expect(
      () =>
        new UuidSourceIdGenerator({ random: () => new Uint8Array(0) })
          .nextSourceId(),
    ).toThrow(RangeError);
  });

  it("versions the control-plane schema and rejects newer or malformed databases", async () => {
    const directory = await mkdtemp(join(tmpdir(), "contextctl-schema-"));
    temporaryDirectories.push(directory);
    const healthyPath = join(directory, "healthy.sqlite");
    const healthy = openTestDatabase(healthyPath);
    expect(
      healthy.prepare("PRAGMA user_version").get(),
    ).toEqual({ user_version: INGESTION_DATABASE_SCHEMA_VERSION });
    expect(healthy.prepare("PRAGMA application_id").get()).toEqual({
      application_id: INGESTION_DATABASE_APPLICATION_ID,
    });
    expect(healthy.prepare("PRAGMA journal_mode").get()).toEqual({
      journal_mode: "wal",
    });
    expect(healthy.prepare("PRAGMA synchronous").get()).toEqual({
      synchronous: 2,
    });
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

    const unownedPath = join(directory, "unowned.sqlite");
    const unowned = new DatabaseSync(unownedPath);
    unowned.exec(`
      CREATE TABLE foreign_data (secret TEXT NOT NULL);
      INSERT INTO foreign_data VALUES ('preserve-me');
    `);
    unowned.close();
    expect(() => openTestDatabase(unownedPath)).toThrowError(
      expect.objectContaining<Partial<IngestionDatabaseSchemaError>>({
        code: "schema_invalid",
      }),
    );
    const unchanged = new DatabaseSync(unownedPath);
    expect(unchanged.prepare("SELECT secret FROM foreign_data").get()).toEqual({
      secret: "preserve-me",
    });
    expect(unchanged.prepare("PRAGMA user_version").get()).toEqual({
      user_version: 0,
    });
    expect(
      unchanged
        .prepare(
          `SELECT name FROM sqlite_schema
           WHERE type = 'table' AND name = 'ingestion_metadata'`,
        )
        .get(),
    ).toBeUndefined();
    unchanged.close();
  });

  it("fails closed on pre-UUIDv7 durable identities without advancing schema", async () => {
    const directory = await mkdtemp(join(tmpdir(), "contextctl-legacy-id-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "legacy.sqlite");
    const database = openTestDatabase(databasePath);
    database
      .prepare(
        `INSERT INTO markdown_publication_checkpoints (
           source_id, target_key, source_type, document_id, checkpoint_json
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "src_legacy",
        "file:/legacy.md",
        "markdown",
        "doc_legacy",
        "{}",
      );
    database.exec("PRAGMA user_version = 6");
    database.close();

    expect(() => openTestDatabase(databasePath)).toThrowError(
      expect.objectContaining({ code: "identity_format_unsupported" }),
    );
    const inspection = new DatabaseSync(databasePath);
    expect(inspection.prepare("PRAGMA user_version").get()).toEqual({
      user_version: 6,
    });
    expect(
      inspection
        .prepare("SELECT source_id FROM markdown_publication_checkpoints")
        .get(),
    ).toEqual({ source_id: "src_legacy" });
    inspection.close();
  });

  it("rejects schema v7 state containing legacy structural identities", async () => {
    const directory = await mkdtemp(join(tmpdir(), "contextctl-legacy-structure-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "legacy-structure.sqlite");
    const database = openTestDatabase(databasePath);
    const sourceId = rootId("src", "legacy-structure");
    const documentId = rootId("doc", "legacy-structure");
    const observationId = rootId("obs", "legacy-structure");
    database
      .prepare(
        `INSERT INTO markdown_publication_checkpoints (
           source_id, target_key, source_type, document_id, checkpoint_json
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        sourceId,
        "file:/legacy-structure.md",
        "markdown",
        documentId,
        JSON.stringify({
          source: {
            id: sourceId,
            targetKey: "file:/legacy-structure.md",
            sourceType: "markdown",
          },
          documentId,
          pendingIndexingSnapshot: {
            document: {
              sourceId,
              documentId,
              observationId,
              blocks: [{ id: "blk_content-derived" }],
            },
          },
        }),
      );
    database.exec("PRAGMA user_version = 7");
    database.close();

    expect(() => openTestDatabase(databasePath)).toThrowError(
      expect.objectContaining({ code: "identity_format_unsupported" }),
    );
    const inspection = new DatabaseSync(databasePath);
    expect(inspection.prepare("PRAGMA user_version").get()).toEqual({
      user_version: 7,
    });
    inspection.close();
  });

  it("does not treat external payload keys as control-plane identities", async () => {
    const directory = await mkdtemp(join(tmpdir(), "contextctl-payload-id-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "payload.sqlite");
    const database = openTestDatabase(databasePath);
    const observations = new SqliteSourceObservationStore(database);
    const observation = createSourceObservation({
      id: rootId("obs", "external-payload"),
      sourceId: rootId("src", "external-payload"),
      capturedAt: NOW,
      contentDigest: `sha256:${"e".repeat(64)}`,
      payload: {
        sourceId: "customer-owned-source-key",
        documentId: 42,
      },
    });
    await observations.commit({ observation });
    database.close();

    const reopened = openTestDatabase(databasePath);
    await expect(
      new SqliteSourceObservationStore(reopened).find(observation.id),
    ).resolves.toEqual(observation);
    reopened.close();
  });

  it("migrates schema v2 and preserves failed staging ownership across restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "contextctl-staging-state-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "ingestion.sqlite");
    const initialized = openTestDatabase(databasePath);
    initialized.close();

    const v2 = new DatabaseSync(databasePath);
    downgradeReadyOutboxToV5(v2);
    v2.exec(`
      DROP INDEX index_staging_attempts_by_eligibility;
      DROP TABLE index_staging_attempts;
      PRAGMA user_version = 2;
    `);
    v2.close();

    const migrated = openTestDatabase(databasePath);
    expect(migrated.prepare("PRAGMA user_version").get()).toEqual({
      user_version: INGESTION_DATABASE_SCHEMA_VERSION,
    });
    const attempts = new SqliteIndexStagingAttemptStore(migrated);
    await attempts.acquirePublication({
      documentIndexId: "didx_payments",
      indexVersion: "idxv_aaaa",
      connectorId: "vector.local",
      accessHandle: "memory:v1:staging",
      attemptedAt: "2026-08-14T00:00:00.000Z",
      leaseId: "lease_durablepublisher",
      leaseExpiresAt: "2026-08-14T00:15:00.000Z",
    });
    await attempts.abandonPublication({
      documentIndexId: "didx_payments",
      indexVersion: "idxv_aaaa",
      leaseId: "lease_durablepublisher",
    });
    migrated.close();

    const restarted = openTestDatabase(databasePath);
    const restored = new SqliteIndexStagingAttemptStore(restarted);
    await expect(
      restored.find({
        documentIndexId: "didx_payments",
        indexVersion: "idxv_aaaa",
      }),
    ).resolves.toMatchObject({
      state: "pending",
      connectorId: "vector.local",
      accessHandle: "memory:v1:staging",
      firstAttemptedAt: "2026-08-14T00:00:00.000Z",
    });
    const claimed = await restored.claimCleanup({
      eligibleBefore: "2026-08-17T00:00:00.000Z",
      now: "2026-08-18T00:00:00.000Z",
      leaseId: "lease_durablecleanup",
      leaseExpiresAt: "2026-08-18T00:05:00.000Z",
      limit: 10,
    });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      state: "cleaning",
      ownerLeaseId: "lease_durablecleanup",
    });
    expect(
      await restored.releaseCleanup({
        documentIndexId: "didx_payments",
        indexVersion: "idxv_aaaa",
        leaseId: "lease_durablecleanup",
      }),
    ).toBe(true);
    restarted.close();
  });

  it("migrates schema v3 and preserves immutable observations across restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "contextctl-observation-state-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "ingestion.sqlite");
    const initialized = openTestDatabase(databasePath);
    initialized.close();

    const v3 = new DatabaseSync(databasePath);
    downgradeReadyOutboxToV5(v3);
    v3.exec(`
      DROP TABLE source_observation_retention_leases;
      DROP TABLE comparison_source_observations;
      DROP TABLE latest_source_observations;
      DROP TABLE source_observations;
      PRAGMA user_version = 3;
    `);
    v3.close();

    const migrated = openTestDatabase(databasePath);
    const observations = new SqliteSourceObservationStore(migrated);
    const observation = createSourceObservation({
      id: rootId("obs", "durable-observation"),
      sourceId: rootId("src", "durable-observation"),
      capturedAt: NOW,
      contentDigest: `sha256:${"a".repeat(64)}`,
      payload: { kind: "test", value: "durable" },
    });
    await observations.commit({ observation });
    await observations.markComparisonBaseline({
      sourceId: observation.sourceId,
      observationId: observation.id,
    });
    migrated.close();

    const restarted = openTestDatabase(databasePath);
    const restored = new SqliteSourceObservationStore(restarted);
    await expect(restored.find(observation.id)).resolves.toEqual(observation);
    await expect(
      restored.comparisonForSource(observation.sourceId),
    ).resolves.toEqual(observation);
    restarted.close();
  });

  it("migrates schema v4 and installs durable Publication recovery intents", async () => {
    const directory = await mkdtemp(join(tmpdir(), "contextctl-schema-v4-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "schema.sqlite");
    const current = openTestDatabase(databasePath);
    downgradeReadyOutboxToV5(current);
    current.exec(`
      DROP TABLE publication_recovery_intents;
      PRAGMA user_version = 4;
    `);
    current.close();

    const migrated = openTestDatabase(databasePath);
    expect(migrated.prepare("PRAGMA user_version").get()).toEqual({
      user_version: INGESTION_DATABASE_SCHEMA_VERSION,
    });
    expect(
      migrated
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name = 'publication_recovery_intents'`,
        )
        .get(),
    ).toEqual({ name: "publication_recovery_intents" });
    migrated.close();
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
    const firstCheckpoint = requiredValue(
      await first.checkpoints.findBySourceId(published.sourceId),
    );
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
    expect(repeated.sourceId).toBe(published.sourceId);
    expect(
      (await second.checkpoints.findBySourceId(repeated.sourceId))?.documentId,
    ).toBe(firstCheckpoint.documentId);
    expect(published.sourceId).toMatch(/^src_.+-7[0-9a-f]{3}-[89ab]/);
    expect(firstCheckpoint.documentId).toMatch(/^doc_.+-7[0-9a-f]{3}-[89ab]/);
    expect(published.observationId).toMatch(/^obs_.+-7[0-9a-f]{3}-[89ab]/);
    expect(publication.publicationId).toMatch(/^pub_.+-7[0-9a-f]{3}-[89ab]/);
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

  it("rehydrates pending structural identities before retrying after restart", async () => {
    const fixture = await createTemporaryFixture();
    const vectorIndex = new InMemoryVectorIndexAdapter();
    const firstStructuralIds = new RecordingStructuralIds("first");
    const firstDatabase = openTestDatabase(fixture.databasePath);
    const first = createDurableRuntime(
      fixture.markdownPath,
      firstDatabase,
      vectorIndex,
      new FailOnceEmbeddingPort(),
      undefined,
      undefined,
      firstStructuralIds,
    );

    const failed = await first.workflow
      .publish(command())
      .catch((caught: unknown) => caught);
    expect(failed).toMatchObject({
      stage: "index_update",
      diagnosticCode: "provider_failure",
    });
    const sourceId = first.events.events.find(
      (event) => event.sourceId !== undefined,
    )?.sourceId;
    expect(sourceId).toBeDefined();
    if (sourceId === undefined) throw new Error("registered Source is missing");
    const pending = requiredValue(
      (await first.checkpoints.findBySourceId(sourceId))
        ?.pendingIndexingSnapshot,
    );
    const pendingIdentities = indexingSnapshotIdentities(pending);
    expect(firstStructuralIds.issuedCount).toBeGreaterThan(0);
    firstDatabase.close();

    const retryStructuralIds = new RecordingStructuralIds("retry");
    const secondDatabase = openTestDatabase(fixture.databasePath);
    const second = createDurableRuntime(
      fixture.markdownPath,
      secondDatabase,
      vectorIndex,
      new DeterministicEmbeddingAdapter(),
      undefined,
      undefined,
      retryStructuralIds,
    );
    const recovered = await second.workflow.publish(command());
    const checkpoint = requiredValue(
      await second.checkpoints.findBySourceId(sourceId),
    );

    expect(recovered.status).toBe("published");
    expect(retryStructuralIds.issuedCount).toBe(0);
    expect(checkpoint.pendingIndexingSnapshot).toBeUndefined();
    expect(checkpoint.indexingSnapshot).toBeDefined();
    expect(indexingSnapshotIdentities(checkpoint.indexingSnapshot!)).toEqual(
      pendingIdentities,
    );
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
      compatibility: {
        stateNamespaceId: STATE_NAMESPACE_ID,
        securityDomain: "tenant-a",
        embeddingProfile: profile,
        payloadSchemaVersion: 2,
      },
      signal: new AbortController().signal,
    });
    const tenantB = await vectorIndex.prepare({
      compatibility: {
        stateNamespaceId: STATE_NAMESPACE_ID,
        securityDomain: "tenant-b",
        embeddingProfile: profile,
        payloadSchemaVersion: 2,
      },
      signal: new AbortController().signal,
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

    const published = await first.workflow.publish(command());
    const publicationId = published.publication!.publicationId;
    await expect(first.readyReconciler.reconcile()).resolves.toEqual([
      {
        publicationId,
        status: "failed",
        diagnosticCode: "notification_unavailable",
      },
    ]);
    firstDatabase.close();

    const secondDatabase = openTestDatabase(fixture.databasePath);
    const publications = new SqliteIngestionPublicationStore(secondDatabase);
    const notifier = new InMemoryPublicationReadyNotifier();
    const reconciled = await new PublicationReadyReconciler({
      publications,
      notifier,
    }).reconcile();

    expect(reconciled).toEqual([
      { publicationId, status: "delivered" },
    ]);
    expect(notifier.notifications).toEqual([
      { schemaVersion: 1, publicationId },
    ]);
    await expect(
      new PublicationReadyReconciler({ publications, notifier }).reconcile(),
    ).resolves.toEqual([]);
    expect(await publications.find(publicationId)).toBeDefined();
    secondDatabase.close();
  });

  it("recovers the frozen Publication after a Catalog-only commit before reading newer source content", async () => {
    const fixture = await createTemporaryFixture();
    const vectorIndex = new InMemoryVectorIndexAdapter();
    const firstDatabase = openTestDatabase(fixture.databasePath);
    const durablePublications = new SqliteIngestionPublicationStore(
      firstDatabase,
    );
    const first = createDurableRuntime(
      fixture.markdownPath,
      firstDatabase,
      vectorIndex,
      new DeterministicEmbeddingAdapter(),
      undefined,
      new FailOncePublicationCommitStore(durablePublications),
    );

    await expect(first.workflow.publish(command())).rejects.toMatchObject({
      stage: "ingestion_publication",
      diagnosticCode: "publication_store_unavailable",
    });
    const pendingRow = firstDatabase
      .prepare(
        `SELECT source_id FROM publication_recovery_intents
         WHERE committed = 0`,
      )
      .get() as { readonly source_id: string } | undefined;
    const pendingIntent = requiredValue(
      pendingRow === undefined
        ? undefined
        : await durablePublications.pendingRecoveryIntentForSource(
            pendingRow.source_id,
          ),
    );
    firstDatabase.close();

    const original = await readFile(fixture.markdownPath, "utf8");
    await writeFile(
      fixture.markdownPath,
      `${original}\n\n# Newly arrived\n\nThis content must wait for the next run.\n`,
      "utf8",
    );

    const secondDatabase = openTestDatabase(fixture.databasePath);
    const second = createDurableRuntime(
      fixture.markdownPath,
      secondDatabase,
      vectorIndex,
      new DeterministicEmbeddingAdapter(),
    );
    const recovered = await second.workflow.publish(command());

    expect(recovered.publication).toEqual(
      JSON.parse(pendingIntent.canonicalPayload),
    );
    expect(recovered.observationId).toBe(
      pendingIntent.publication.observationId,
    );
    expect(
      await second.publications.pendingRecoveryIntentForSource(
        pendingIntent.publication.sourceId,
      ),
    ).toBeUndefined();
    expect(
      await second.checkpoints.findBySourceId(
        pendingIntent.publication.sourceId,
      ),
    ).toMatchObject({ observationId: pendingIntent.publication.observationId });

    const advanced = await second.workflow.publish(command());
    expect(advanced.status).toBe("published");
    expect(advanced.publication?.previousPublicationId).toBe(
      pendingIntent.publication.publicationId,
    );
    expect(advanced.observationId).not.toBe(recovered.observationId);
    secondDatabase.close();
  });
});

function createDurableRuntime(
  markdownPath: string,
  database: DatabaseSync,
  vectorIndex: VectorIndexPort,
  embeddingProvider: EmbeddingPort,
  readyNotifier?: PublicationReadyNotifier,
  publications?: IngestionPublicationStore,
  structuralIds?: StructuralIdGenerator,
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
    publications:
      publications ?? new SqliteIngestionPublicationStore(database),
    observations: new SqliteSourceObservationStore(database),
    indexPublications: new SqliteIndexPublicationStore(database),
    stagingAttempts: new SqliteIndexStagingAttemptStore(database),
    ids: new UuidV7RootIdGenerator(),
    ...(structuralIds === undefined ? {} : { structuralIds }),
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
    sourceId: rootId("src", suffix),
    observationId: rootId("obs", suffix),
    documentId: rootId("doc", suffix),
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

function downgradeReadyOutboxToV5(database: DatabaseSync): void {
  database.exec(`
    ALTER TABLE latest_ingestion_publications
      RENAME TO latest_ingestion_publications_v6;
    ALTER TABLE ingestion_publications
      RENAME TO ingestion_publications_v6;
    DROP INDEX ingestion_publications_by_source;
    DROP INDEX publication_ready_by_eligibility;

    CREATE TABLE ingestion_publications (
      publication_id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      previous_publication_id TEXT,
      publication_json TEXT NOT NULL,
      produced_at TEXT NOT NULL,
      ready_notified INTEGER NOT NULL DEFAULT 0 CHECK (ready_notified IN (0, 1))
    );
    CREATE INDEX ingestion_publications_by_source
      ON ingestion_publications (source_id, produced_at, publication_id);
    INSERT INTO ingestion_publications (
      publication_id, source_id, previous_publication_id,
      publication_json, produced_at, ready_notified
    )
    SELECT publication_id, source_id, previous_publication_id,
           publication_json, produced_at,
           CASE ready_state WHEN 'delivered' THEN 1 ELSE 0 END
      FROM ingestion_publications_v6;

    CREATE TABLE latest_ingestion_publications (
      source_id TEXT PRIMARY KEY,
      publication_id TEXT NOT NULL REFERENCES ingestion_publications (publication_id)
    );
    INSERT INTO latest_ingestion_publications (source_id, publication_id)
      SELECT source_id, publication_id
        FROM latest_ingestion_publications_v6;

    DROP TABLE latest_ingestion_publications_v6;
    DROP TABLE ingestion_publications_v6;
  `);
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

class FailOnceEmbeddingPort implements EmbeddingPort {
  readonly #delegate = new DeterministicEmbeddingAdapter();
  #failed = false;

  embed(request: EmbeddingProviderRequest) {
    if (!this.#failed) {
      this.#failed = true;
      return Promise.reject(new Error("simulated embedding failure"));
    }
    return this.#delegate.embed(request);
  }
}

class RecordingStructuralIds implements StructuralIdGenerator {
  issuedCount = 0;

  constructor(private readonly seed: string) {}

  nextBlockId(): string {
    return this.#next("blk");
  }

  nextUnitId(): string {
    return this.#next("unit");
  }

  nextChunkId(): string {
    return this.#next("chk");
  }

  #next(prefix: "blk" | "chk" | "unit"): string {
    this.issuedCount += 1;
    return structuralId(
      prefix,
      `${this.seed}-${String(this.issuedCount)}`,
    );
  }
}

function indexingSnapshotIdentities(snapshot: {
  readonly document: { readonly blocks: readonly { readonly id: string }[] };
  readonly semanticUnits: readonly { readonly id: string }[];
  readonly chunks: readonly { readonly id: string }[];
}) {
  return {
    blocks: snapshot.document.blocks.map((block) => block.id),
    semanticUnits: snapshot.semanticUnits.map((unit) => unit.id),
    chunks: snapshot.chunks.map((chunk) => chunk.id),
  };
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

class FailOncePublicationCommitStore implements IngestionPublicationStore {
  #shouldFail = true;

  constructor(private readonly delegate: IngestionPublicationStore) {}

  prepareRecoveryIntent: IngestionPublicationStore["prepareRecoveryIntent"] =
    (publication) => this.delegate.prepareRecoveryIntent(publication);
  findRecoveryIntent: IngestionPublicationStore["findRecoveryIntent"] =
    (publicationId) => this.delegate.findRecoveryIntent(publicationId);
  pendingRecoveryIntentForSource: IngestionPublicationStore["pendingRecoveryIntentForSource"] =
    (sourceId) => this.delegate.pendingRecoveryIntentForSource(sourceId);

  async commitReady(
    publication: Parameters<IngestionPublicationStore["commitReady"]>[0],
  ) {
    if (this.#shouldFail) {
      this.#shouldFail = false;
      throw new SimulatedPublicationStoreUnavailable();
    }
    return this.delegate.commitReady(publication);
  }

  find: IngestionPublicationStore["find"] = (publicationId) =>
    this.delegate.find(publicationId);
  latestForSource: IngestionPublicationStore["latestForSource"] = (sourceId) =>
    this.delegate.latestForSource(sourceId);
  claimReadyBatch: IngestionPublicationStore["claimReadyBatch"] = (input) =>
    this.delegate.claimReadyBatch(input);
  completeReadyDelivery: IngestionPublicationStore["completeReadyDelivery"] =
    (input) => this.delegate.completeReadyDelivery(input);
  rescheduleReadyDelivery: IngestionPublicationStore["rescheduleReadyDelivery"] =
    (input) => this.delegate.rescheduleReadyDelivery(input);
}

class SimulatedPublicationStoreUnavailable extends Error {
  readonly code = "publication_store_unavailable";
}

class NotificationUnavailable extends Error {
  readonly code = "notification_unavailable";
}
