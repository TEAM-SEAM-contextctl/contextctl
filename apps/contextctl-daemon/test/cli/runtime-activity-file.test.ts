import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createRuntimeActivityPublisher,
  readRuntimeActivity,
} from "../../src/cli/runtime-activity-file.js";
import type { RuntimeActivity } from "../../src/cli/status.js";

const temporaryDirectories: string[] = [];
const stateIdentity = {
  stateNamespaceId: "state_activity_test",
  securityDomain: "activity-test",
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("runtime activity directory", () => {
  it("publishes only the fixed counts schema with owner-only permissions", async () => {
    const directory = await activityDirectory();
    const publisher = createRuntimeActivityPublisher({
      directory,
      stateIdentity,
      now: () => 1_000,
    });
    const withSecrets = {
      ...activity(),
      query: "where is the credential?",
      depths: activity().depths.map((depth) => ({
        ...depth,
        credential: "lane-secret",
      })),
      embedding: {
        ...activity().embedding,
        apiKey: "embedding-secret",
      },
    } as RuntimeActivity;

    await publisher.start(() => withSecrets);
    const file = await soleActivityFile(directory);
    expect(
      await readRuntimeActivity({ directory, stateIdentity, now: () => 1_500 }),
    ).toEqual(activity());
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const document = await readFile(file, "utf8");
    expect(document).not.toContain("query");
    expect(document).not.toContain("credential");
    expect(document).not.toContain("apiKey");
    await expect(
      readRuntimeActivity({
        directory,
        stateIdentity: {
          stateNamespaceId: "state_other",
          securityDomain: "activity-test",
        },
        now: () => 1_500,
      }),
    ).resolves.toBeUndefined();

    const unexpectedField = JSON.parse(document) as {
      activity: Record<string, unknown>;
    };
    unexpectedField.activity["query"] = "must be rejected";
    await writeFile(file, JSON.stringify(unexpectedField));
    await expect(
      readRuntimeActivity({ directory, stateIdentity, now: () => 1_500 }),
    ).resolves.toBeUndefined();

    await publisher.close();
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("aggregates concurrent publishers and each close removes only its own file", async () => {
    const directory = await activityDirectory();
    const first = createRuntimeActivityPublisher({
      directory,
      stateIdentity,
      now: () => 1_000,
    });
    const secondActivity = activity({
      lifecycle: "draining",
      profileVersion: "daemon-runtime-profile-v2",
      resolveActive: 5,
      rssBytes: 256 * 1024 * 1024,
      embeddingProfileVersion: "embedding-runtime-scheduler-v2",
      eventLoopLagMs: 30,
    });
    const second = createRuntimeActivityPublisher({
      directory,
      stateIdentity,
      now: () => 1_000,
    });
    await first.start(activity);
    await second.start(() => secondActivity);

    expect(
      (await readdir(directory)).filter((name) => name.endsWith(".json")),
    ).toHaveLength(2);
    const aggregate = await readRuntimeActivity({
      directory,
      stateIdentity,
      now: () => 1_500,
    });
    expect(aggregate).toMatchObject({
      lifecycle: "accepting",
      profileVersion: "mixed",
      embedding: {
        profileVersion: "mixed",
        active: 2,
        eventLoopLagMs: 30,
        rssBytes: 768 * 1024 * 1024,
      },
    });
    expect(
      aggregate?.depths.find((depth) => depth.lane === "resolve")?.active,
    ).toBe(7);

    await first.close();
    expect(
      (await readdir(directory)).filter((name) => name.endsWith(".json")),
    ).toHaveLength(1);
    await expect(
      readRuntimeActivity({ directory, stateIdentity, now: () => 1_500 }),
    ).resolves.toEqual(secondActivity);
    await second.close();
  });

  it("does not present a stale process snapshot as live activity", async () => {
    const directory = await activityDirectory();
    const publisher = createRuntimeActivityPublisher({
      directory,
      stateIdentity,
      now: () => 1_000,
    });
    await publisher.start(activity);

    await expect(
      readRuntimeActivity({
        directory,
        stateIdentity,
        now: () => 10_000,
        maxAgeMs: 4_000,
      }),
    ).resolves.toBeUndefined();
    await publisher.close();
  });

  it("does not let accumulated stale process files hide live activity", async () => {
    const directory = await activityDirectory();
    const stalePublisherCount = 129;
    const stalePublishers = Array.from({ length: stalePublisherCount }, () =>
      createRuntimeActivityPublisher({
        directory,
        stateIdentity,
        now: () => 1_000,
      }),
    );
    await Promise.all(
      stalePublishers.map((publisher) => publisher.start(activity)),
    );

    const live = createRuntimeActivityPublisher({
      directory,
      stateIdentity,
      now: () => 10_000,
    });
    const liveActivity = activity({ resolveActive: 7 });
    await live.start(() => liveActivity);

    await expect(
      readRuntimeActivity({
        directory,
        stateIdentity,
        now: () => 10_000,
        maxAgeMs: 4_000,
      }),
    ).resolves.toEqual(liveActivity);

    await Promise.all(stalePublishers.map((publisher) => publisher.close()));
    await live.close();
  });

  it("ignores malformed or oversized local state instead of breaking status", async () => {
    const directory = await activityDirectory();
    const malformed = join(directory, "00000000-0000-4000-8000-000000000001.json");
    await writeFile(malformed, '{"schemaVersion":1,"activity":{"query":"secret"}}');

    await expect(
      readRuntimeActivity({ directory, stateIdentity }),
    ).resolves.toBeUndefined();

    await writeFile(malformed, "x".repeat(64 * 1024 + 1));
    await expect(
      readRuntimeActivity({ directory, stateIdentity }),
    ).resolves.toBeUndefined();
  });

  it("does not leave a temporary file when the supplied activity is invalid", async () => {
    const directory = await activityDirectory();
    const publisher = createRuntimeActivityPublisher({ directory, stateIdentity });
    const invalid = {
      ...activity(),
      embedding: { ...activity().embedding, rssBytes: BigInt(1) },
    } as unknown as RuntimeActivity;

    await expect(publisher.start(() => invalid)).rejects.toThrow(
      "runtime activity contains an invalid count or state",
    );
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    await publisher.close();
  });
});

async function activityDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "contextctl-activity-"));
  temporaryDirectories.push(root);
  const directory = join(root, "runtime-activity");
  await mkdir(directory);
  return directory;
}

async function soleActivityFile(directory: string): Promise<string> {
  const files = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  expect(files).toHaveLength(1);
  const file = files[0];
  if (file === undefined) throw new Error("activity publisher created no file");
  return join(directory, file);
}

function activity(overrides?: {
  readonly lifecycle?: RuntimeActivity["lifecycle"];
  readonly profileVersion?: string;
  readonly resolveActive?: number;
  readonly rssBytes?: number;
  readonly embeddingProfileVersion?: string;
  readonly eventLoopLagMs?: number;
}): RuntimeActivity {
  return {
    lifecycle: overrides?.lifecycle ?? "accepting",
    profileVersion: overrides?.profileVersion ?? "daemon-runtime-profile-v1",
    depths: [
      {
        lane: "resolve",
        active: overrides?.resolveActive ?? 2,
        queued: 3,
        concurrency: 8,
        queueDepth: 32,
      },
      {
        lane: "registry_consume",
        active: 0,
        queued: 0,
        concurrency: 1,
        queueDepth: 8,
      },
      {
        lane: "selection_assets",
        active: 0,
        queued: 0,
        concurrency: 1,
        queueDepth: 1,
      },
      {
        lane: "ingestion",
        active: 1,
        queued: 0,
        concurrency: 1,
        queueDepth: 4,
      },
    ],
    embedding: {
      profileVersion:
        overrides?.embeddingProfileVersion ?? "embedding-runtime-scheduler-v1",
      accepting: true,
      active: 1,
      resolveStarts: 8,
      backgroundStarts: 3,
      resolveReservations: 2,
      resolveQueued: 1,
      backgroundQueued: 0,
      eventLoopLagMs: overrides?.eventLoopLagMs ?? 12,
      eventLoopState: "normal",
      rssBytes: overrides?.rssBytes ?? 512 * 1024 * 1024,
      rssLimitBytes: 1_536 * 1024 * 1024,
      memoryState: "normal",
      backgroundStartsSuppressed: false,
    },
  };
}
