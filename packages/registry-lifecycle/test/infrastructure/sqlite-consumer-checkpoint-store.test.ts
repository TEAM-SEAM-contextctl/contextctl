import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { claimPublication } from "../../src/application/claim-publication.js";
import { openRegistryDatabase } from "../../src/infrastructure/sqlite/registry-database.js";
import { SqliteConsumerCheckpointStore } from "../../src/infrastructure/sqlite/sqlite-consumer-checkpoint-store.js";
import { createIngestionPublicationFixture } from "../fixtures/ingestion-publication.fixture.js";

const now = () => "2026-08-04T00:00:00.000Z";
const directories: string[] = [];

async function createDatabaseFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "contextctl-registry-"));
  directories.push(directory);
  return join(directory, "registry.sqlite");
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("SqliteConsumerCheckpointStore", () => {
  it("reports a publication as unprocessed until it is marked", async () => {
    const store = new SqliteConsumerCheckpointStore(
      openRegistryDatabase(":memory:"),
      now,
    );

    expect(await store.hasProcessed("pub_initial")).toBe(false);
    await store.markProcessed("pub_initial");
    expect(await store.hasProcessed("pub_initial")).toBe(true);
  });

  it("tolerates marking the same publication twice", async () => {
    const store = new SqliteConsumerCheckpointStore(
      openRegistryDatabase(":memory:"),
      now,
    );

    await store.markProcessed("pub_initial");
    await store.markProcessed("pub_initial");

    expect(await store.hasProcessed("pub_initial")).toBe(true);
  });

  it("keeps consumption idempotent across a restart", async () => {
    const location = await createDatabaseFile();
    const publication = createIngestionPublicationFixture();
    const ports = (checkpoints: SqliteConsumerCheckpointStore) => ({
      checkpoints,
      publications: { findById: async () => publication },
      meanings: {
        generate: async () => ({
          description: "결제 실패 재시도 정책",
          representativeQuestions: ["결제가 실패하면 언제 재시도되나요?"],
          aliases: [],
          keywords: [],
        }),
      },
      clock: { now },
      ids: { nextId: () => "cv_1" },
    });

    const first = openRegistryDatabase(location);
    const claimed = await claimPublication(
      ports(new SqliteConsumerCheckpointStore(first, now)),
      publication.publicationId,
    );
    first.close();

    // A fresh process opens the same file and receives the notification again.
    const second = openRegistryDatabase(location);
    const replayed = await claimPublication(
      ports(new SqliteConsumerCheckpointStore(second, now)),
      publication.publicationId,
    );
    second.close();

    expect(claimed.status).toBe("claimed");
    expect(replayed).toEqual({
      status: "already_claimed",
      publicationId: "pub_initial",
    });
  });
});
