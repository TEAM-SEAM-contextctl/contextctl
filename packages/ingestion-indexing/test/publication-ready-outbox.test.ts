import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  InMemoryIngestionPublicationStore,
  IngestionPublicationStoreConflict,
  SqliteIngestionPublicationStore,
  buildEmptyMarkdownPublication,
  openIngestionDatabase,
  type IngestionPublicationStore,
} from "../src/index.js";
import { createDocumentFixture } from "./fixtures/document-fixture.js";

const BASE_TIME = "2026-08-19T02:00:00.000Z";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe.each(["memory", "sqlite"] as const)(
  "PublicationReady outbox in %s",
  (adapter) => {
    it("claims bounded batches, isolates owners, and reclaims expired leases", async () => {
      const fixture = createStore(adapter);
      const publicationIds: string[] = [];
      for (let index = 0; index < 4; index += 1) {
        publicationIds.push(
          await commitReadyPublication(
            fixture.store,
            index,
            `2026-08-19T02:00:0${String(index)}.000Z`,
          ),
        );
      }

      const first = await fixture.store.claimReadyBatch({
        ownerId: "ready_owner_a",
        now: "2026-08-19T02:01:00.000Z",
        leaseDurationMs: 30_000,
        limit: 2,
      });
      expect(first.map((item) => item.publicationId)).toEqual(
        publicationIds.slice(0, 2),
      );
      expect(first.map((item) => item.attemptCount)).toEqual([1, 1]);

      const second = await fixture.store.claimReadyBatch({
        ownerId: "ready_owner_b",
        now: "2026-08-19T02:01:00.000Z",
        leaseDurationMs: 30_000,
        limit: 2,
      });
      expect(second.map((item) => item.publicationId)).toEqual(
        publicationIds.slice(2),
      );
      await expect(
        fixture.store.claimReadyBatch({
          ownerId: "ready_owner_c",
          now: "2026-08-19T02:01:00.000Z",
          leaseDurationMs: 30_000,
          limit: 2,
        }),
      ).resolves.toEqual([]);

      await fixture.store.completeReadyDelivery({
        publicationId: first[0]!.publicationId,
        ownerId: first[0]!.ownerId,
        deliveredAt: "2026-08-19T02:01:01.000Z",
      });
      await fixture.store.rescheduleReadyDelivery({
        publicationId: first[1]!.publicationId,
        ownerId: first[1]!.ownerId,
        nextAttemptAt: "2026-08-19T02:05:00.000Z",
        diagnosticCode: "notification_unavailable",
      });

      const reclaimed = await fixture.store.claimReadyBatch({
        ownerId: "ready_owner_c",
        now: "2026-08-19T02:02:00.000Z",
        leaseDurationMs: 30_000,
        limit: 4,
      });
      expect(reclaimed.map((item) => item.publicationId)).toEqual(
        publicationIds.slice(2),
      );
      expect(reclaimed.map((item) => item.attemptCount)).toEqual([2, 2]);

      const delayed = await fixture.store.claimReadyBatch({
        ownerId: "ready_owner_d",
        now: "2026-08-19T02:05:00.000Z",
        leaseDurationMs: 30_000,
        limit: 4,
      });
      expect(delayed.map((item) => item.publicationId)).toEqual(
        publicationIds.slice(1),
      );
      expect(delayed[0]?.attemptCount).toBe(2);
      fixture.close();
    });

    it("rejects invalid policy and a completion by the wrong owner", async () => {
      const fixture = createStore(adapter);
      const publicationId = await commitReadyPublication(
        fixture.store,
        10,
        BASE_TIME,
      );
      await expect(
        fixture.store.claimReadyBatch({
          ownerId: "ready_owner",
          now: "2026-08-19T02:01:00.000Z",
          leaseDurationMs: 30_000,
          limit: 101,
        }),
      ).rejects.toBeInstanceOf(IngestionPublicationStoreConflict);
      const [claimed] = await fixture.store.claimReadyBatch({
        ownerId: "ready_owner",
        now: "2026-08-19T02:01:00.000Z",
        leaseDurationMs: 30_000,
        limit: 1,
      });
      expect(claimed?.publicationId).toBe(publicationId);
      await expect(
        fixture.store.completeReadyDelivery({
          publicationId,
          ownerId: "ready_other",
          deliveredAt: "2026-08-19T02:01:01.000Z",
        }),
      ).rejects.toBeInstanceOf(IngestionPublicationStoreConflict);
      fixture.close();
    });
  },
);

it("restores an in-flight SQLite delivery only after its lease expires", async () => {
  const directory = await mkdtemp(join(tmpdir(), "contextctl-ready-outbox-"));
  temporaryDirectories.push(directory);
  const location = join(directory, "ingestion.sqlite");
  const firstDatabase = openDatabase(location);
  const firstStore = new SqliteIngestionPublicationStore(firstDatabase);
  const publicationId = await commitReadyPublication(
    firstStore,
    20,
    BASE_TIME,
  );
  const [firstClaim] = await firstStore.claimReadyBatch({
    ownerId: "ready_before_restart",
    now: "2026-08-19T02:01:00.000Z",
    leaseDurationMs: 60_000,
    limit: 1,
  });
  expect(firstClaim?.publicationId).toBe(publicationId);
  firstDatabase.close();

  const secondDatabase = openDatabase(location);
  const secondStore = new SqliteIngestionPublicationStore(secondDatabase);
  await expect(
    secondStore.claimReadyBatch({
      ownerId: "ready_after_restart",
      now: "2026-08-19T02:01:59.999Z",
      leaseDurationMs: 60_000,
      limit: 1,
    }),
  ).resolves.toEqual([]);
  const [reclaimed] = await secondStore.claimReadyBatch({
    ownerId: "ready_after_restart",
    now: "2026-08-19T02:02:00.000Z",
    leaseDurationMs: 60_000,
    limit: 1,
  });
  expect(reclaimed).toMatchObject({
    publicationId,
    ownerId: "ready_after_restart",
    attemptCount: 2,
  });
  secondDatabase.close();
});

function createStore(adapter: "memory" | "sqlite"): {
  readonly store: IngestionPublicationStore;
  close(): void;
} {
  if (adapter === "memory") {
    return {
      store: new InMemoryIngestionPublicationStore(),
      close: () => undefined,
    };
  }
  const database = openDatabase(":memory:");
  return {
    store: new SqliteIngestionPublicationStore(database),
    close: () => database.close(),
  };
}

function openDatabase(location: string): DatabaseSync {
  return openIngestionDatabase({
    location,
    stateNamespaceId: "state_ready_outbox",
    securityDomain: "tenant-a",
  });
}

async function commitReadyPublication(
  store: IngestionPublicationStore,
  index: number,
  producedAt: string,
): Promise<string> {
  const suffix = `ready${String(index)}`;
  const document = {
    ...createDocumentFixture(),
    sourceId: `src_${suffix}`,
    observationId: `obs_${suffix}`,
    documentId: `doc_${suffix}`,
  };
  const publication = buildEmptyMarkdownPublication({ document, producedAt });
  await store.prepareRecoveryIntent(publication);
  await store.commitReady(publication);
  return publication.publicationId;
}
