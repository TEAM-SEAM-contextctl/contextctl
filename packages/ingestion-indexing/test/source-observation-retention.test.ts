import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  InMemorySourceObservationStore,
  SourceObservationRetention,
  SqliteIngestionPublicationStore,
  SqliteSourceObservationStore,
  buildEmptyMarkdownPublication,
  createSourceObservation,
  openIngestionDatabase,
  type SourceObservation,
  type SourceObservationStore,
} from "../src/index.js";
import { createDocumentFixture } from "./fixtures/document-fixture.js";
import { rootId } from "./fixtures/root-id-fixture.js";

const databases: DatabaseSync[] = [];
const NOW = "2026-08-18T00:00:00.000Z";

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe.each(["memory", "sqlite"] as const)(
  "%s Source Observation store",
  (kind) => {
    it("stores immutable snapshots and deduplicates repeated canonical content", async () => {
      const store = createStore(kind);
      const original = observation(1, "2026-08-10T00:00:00.000Z");

      const first = await store.commit({ observation: original });
      const mutable = original.payload as { capturedAt: string; value: string };
      mutable.value = "mutated-after-commit";
      const repeated = await store.commit({
        observation: {
          ...observation(1, "2026-08-11T00:00:00.000Z"),
          id: rootId("obs", "retry-with-same-content"),
        },
      });

      expect(first.status).toBe("stored");
      expect(repeated.status).toBe("existing");
      expect(repeated.observation.capturedAt).toBe(
        "2026-08-10T00:00:00.000Z",
      );
      expect(repeated.observation.id).toBe(first.observation.id);
      expect(repeated.observation.payload).toEqual({
        capturedAt: "2026-08-10T00:00:00.000Z",
        value: "content-1",
      });
      await expect(store.count()).resolves.toBe(1);
      await expect(
        store.latestForSource(rootId("src", "observation-test")),
      ).resolves.toEqual(
        repeated.observation,
      );
    });

    it("never reclaims current, comparison, or actively leased snapshots", async () => {
      const store = createStore(kind);
      const comparison = observation(1, "2026-08-08T00:00:00.000Z");
      const leased = observation(2, "2026-08-09T00:00:00.000Z");
      const reclaimable = observation(3, "2026-08-10T00:00:00.000Z");
      const current = observation(4, "2026-08-11T00:00:00.000Z");
      await store.commit({ observation: comparison });
      await store.markComparisonBaseline({
        sourceId: comparison.sourceId,
        observationId: comparison.id,
      });
      await store.commit({
        observation: leased,
        retentionLease: {
          leaseId: "lease_processingtest",
          observationId: leased.id,
          acquiredAt: "2026-08-09T00:00:00.000Z",
          expiresAt: "2026-08-20T00:00:00.000Z",
        },
      });
      await store.commit({ observation: reclaimable });
      await store.commit({ observation: current });

      await expect(
        store.deleteIfUnprotected(comparison.id, NOW),
      ).resolves.toBe("protected");
      await expect(store.deleteIfUnprotected(leased.id, NOW)).resolves.toBe(
        "protected",
      );
      await expect(store.deleteIfUnprotected(current.id, NOW)).resolves.toBe(
        "protected",
      );

      const retention = new SourceObservationRetention({
        observations: store,
        policy: {
          minimumSnapshotsPerSource: 1,
          retentionPeriodMs: 24 * 60 * 60 * 1_000,
          batchSize: 10,
        },
        clock: () => NOW,
      });
      const first = await retention.execute();

      expect(first).toMatchObject({
        examined: 1,
        deleted: 1,
        protected: 0,
        remainingSnapshots: 3,
      });
      expect(first.items).toEqual([
        {
          observationId: reclaimable.id,
          sourceId: reclaimable.sourceId,
          outcome: "deleted",
        },
      ]);

      await store.releaseRetentionLease("lease_processingtest", leased.id);
      const second = await retention.execute();
      expect(second).toMatchObject({
        examined: 1,
        deleted: 1,
        remainingSnapshots: 2,
      });
      await expect(store.find(comparison.id)).resolves.toBeDefined();
      await expect(store.find(current.id)).resolves.toBeDefined();
    });

    it("treats an expired processing lease as reclaimable", async () => {
      const store = createStore(kind);
      const expired = observation(1, "2026-08-08T00:00:00.000Z");
      const current = observation(2, "2026-08-10T00:00:00.000Z");
      await store.commit({
        observation: expired,
        retentionLease: {
          leaseId: "lease_expiredtest",
          observationId: expired.id,
          acquiredAt: "2026-08-08T00:00:00.000Z",
          expiresAt: "2026-08-09T00:00:00.000Z",
        },
      });
      await store.commit({ observation: current });

      await expect(store.deleteIfUnprotected(expired.id, NOW)).resolves.toBe(
        "deleted",
      );
      await expect(store.latestForSource(current.sourceId)).resolves.toEqual(
        current,
      );
    });

    it("uses compare-and-swap when advancing the comparison baseline", async () => {
      const store = createStore(kind);
      const first = observation(1, "2026-08-08T00:00:00.000Z");
      const second = observation(2, "2026-08-09T00:00:00.000Z");
      await store.commit({ observation: first });
      await store.commit({ observation: second });
      await store.markComparisonBaseline({
        sourceId: first.sourceId,
        observationId: first.id,
      });

      await expect(
        store.markComparisonBaseline({
          sourceId: second.sourceId,
          observationId: second.id,
        }),
      ).rejects.toMatchObject({ code: "observation_store_conflict" });
      await expect(store.comparisonForSource(first.sourceId)).resolves.toEqual(
        first,
      );
      await expect(
        store.markComparisonBaseline({
          sourceId: second.sourceId,
          observationId: second.id,
          expectedObservationId: first.id,
        }),
      ).resolves.toBeUndefined();
    });
  },
);

it("fails closed when a durable Observation record is corrupted", async () => {
  const database = openTestDatabase();
  const store = new SqliteSourceObservationStore(database);
  const stored = observation(1, "2026-08-10T00:00:00.000Z");
  await store.commit({ observation: stored });
  database
    .prepare(
      `UPDATE source_observations SET fingerprint = ?
       WHERE observation_id = ?`,
    )
    .run("sha256:corrupt", stored.id);

  await expect(store.find(stored.id)).rejects.toMatchObject({
    code: "observation_store_conflict",
  });
});

it("protects Observations needed by pending and current Publications", async () => {
  const database = openTestDatabase();
  const observations = new SqliteSourceObservationStore(database);
  const publications = new SqliteIngestionPublicationStore(database);
  const firstObservation = observation(1, "2026-08-08T00:00:00.000Z");
  const secondObservation = observation(2, "2026-08-09T00:00:00.000Z");
  await observations.commit({ observation: firstObservation });
  await observations.commit({ observation: secondObservation });

  const firstPublication = buildEmptyMarkdownPublication({
    publicationId: rootId("pub", "retention-first"),
    document: {
      ...createDocumentFixture(),
      sourceId: firstObservation.sourceId,
      observationId: firstObservation.id,
    },
    producedAt: "2026-08-10T00:00:00.000Z",
  });
  await publications.prepareRecoveryIntent(firstPublication);

  await expect(
    observations.findRetentionCandidates({
      retainLatestCount: 1,
      capturedBefore: NOW,
      now: NOW,
      limit: 10,
    }),
  ).resolves.toEqual([]);
  await expect(
    observations.deleteIfUnprotected(firstObservation.id, NOW),
  ).resolves.toBe("protected");

  await publications.commitReady(firstPublication);
  await expect(
    observations.deleteIfUnprotected(firstObservation.id, NOW),
  ).resolves.toBe("protected");

  const secondPublication = buildEmptyMarkdownPublication({
    publicationId: rootId("pub", "retention-second"),
    document: {
      ...createDocumentFixture(),
      sourceId: secondObservation.sourceId,
      observationId: secondObservation.id,
    },
    producedAt: "2026-08-11T00:00:00.000Z",
    previous: firstPublication,
  });
  await publications.prepareRecoveryIntent(secondPublication);
  await publications.commitReady(secondPublication);

  await expect(
    observations.deleteIfUnprotected(firstObservation.id, NOW),
  ).resolves.toBe("deleted");
});

function createStore(kind: "memory" | "sqlite"): SourceObservationStore {
  return kind === "memory"
    ? new InMemorySourceObservationStore()
    : new SqliteSourceObservationStore(openTestDatabase());
}

function openTestDatabase(): DatabaseSync {
  const database = openIngestionDatabase({
    location: ":memory:",
    stateNamespaceId: "state_observationtest",
    securityDomain: "tenant-a",
  });
  databases.push(database);
  return database;
}

function observation(ordinal: number, capturedAt: string): SourceObservation {
  const hex = ordinal.toString(16).padStart(64, "0");
  return createSourceObservation({
    id: rootId("obs", ordinal),
    sourceId: rootId("src", "observation-test"),
    capturedAt,
    contentDigest: `sha256:${hex}`,
    payload: { capturedAt, value: `content-${String(ordinal)}` },
  });
}
