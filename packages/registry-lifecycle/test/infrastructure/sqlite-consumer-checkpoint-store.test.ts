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
      openRegistryDatabase({ location: ":memory:", stateNamespaceId: "state_local", securityDomain: "local" }),
      now,
    );

    expect(await store.hasProcessed("pub_initial")).toBe(false);
    await store.markProcessed({
      sourceId: "src_payments",
      publicationId: "pub_initial",
    });
    expect(await store.hasProcessed("pub_initial")).toBe(true);
  });

  it("tolerates marking the same publication twice", async () => {
    const store = new SqliteConsumerCheckpointStore(
      openRegistryDatabase({ location: ":memory:", stateNamespaceId: "state_local", securityDomain: "local" }),
      now,
    );

    const cursor = { sourceId: "src_payments", publicationId: "pub_initial" };
    await store.markProcessed(cursor);
    await store.markProcessed(cursor);

    expect(await store.hasProcessed("pub_initial")).toBe(true);
    // The cursor is a single row per Source, so a repeat leaves one position
    // rather than two rows claiming different places in the same chain.
    expect(await store.listCursors()).toEqual([cursor]);
  });

  it("keeps consumption idempotent across a restart", async () => {
    const location = await createDatabaseFile();
    const publication = createIngestionPublicationFixture();
    const ports = (checkpoints: SqliteConsumerCheckpointStore) => ({
      checkpoints,
      publications: { findById: async () => publication },
      meanings: {
        generate: async () => ({
          meaning: {
            description: "결제 실패 재시도 정책",
            representativeQuestions: ["결제가 실패하면 언제 재시도되나요?"],
            aliases: [],
            keywords: [],
          },
          origin: { generator: "deterministic" as const },
        }),
      },
      clock: { now },
      ids: { nextId: () => "cv_1" },
    });

    const first = openRegistryDatabase({ location, stateNamespaceId: "state_local", securityDomain: "local" });
    const firstCheckpoints = new SqliteConsumerCheckpointStore(first, now);
    const claimed = await claimPublication(
      ports(firstCheckpoints),
      publication.publicationId,
    );
    // The storing caller records consumption, so this test plays that part: the
    // durable record is what has to survive the restart, not the claim call.
    if (claimed.status === "claimed") {
      await firstCheckpoints.markProcessed(claimed.cursor);
    }
    first.close();

    // A fresh process opens the same file and receives the notification again.
    const second = openRegistryDatabase({ location, stateNamespaceId: "state_local", securityDomain: "local" });
    const replayed = await claimPublication(
      ports(new SqliteConsumerCheckpointStore(second, now)),
      publication.publicationId,
    );
    second.close();

    expect(claimed.status).toBe("claimed");
    expect(replayed).toEqual({
      status: "already_claimed",
      publicationId: publication.publicationId,
    });
  });
});
