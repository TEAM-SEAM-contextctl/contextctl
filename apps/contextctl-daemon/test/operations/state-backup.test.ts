import { DatabaseSync } from "node:sqlite";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openIngestionDatabase } from "@contextctl/ingestion-indexing";

import {
  createStateBackup,
  readStateBackupManifest,
  restoreStateBackup,
  StateBackupError,
  type StateBackupQdrantArtifact,
  type VectorSnapshotArchive,
  type VectorSnapshotRestoreLease,
} from "../../src/operations/state-backup.js";

const identity = {
  stateNamespaceId: "state_backup_test",
  securityDomain: "backup-test",
};
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("state backup coordinator", () => {
  it("backs up a write-frozen state and restores it into a new home", async () => {
    const fixture = await stateFixture();
    const vectors = new RecordingVectorArchive();

    const manifest = await createStateBackup({
      destination: fixture.backup,
      identity,
      paths: fixture.paths,
      vectors,
      now: () => new Date("2026-08-24T00:00:00.000Z"),
    });

    expect(manifest).toMatchObject({
      formatVersion: 1,
      createdAt: "2026-08-24T00:00:00.000Z",
      stateNamespaceId: identity.stateNamespaceId,
      securityDomain: identity.securityDomain,
      consistencyProtocol: "sqlite-write-freeze-qdrant-snapshot-v1",
      sqlite: [
        { role: "ingestion", path: "sqlite/ingestion.db" },
        { role: "registry", path: "sqlite/registry.db" },
      ],
      sources: { path: "sources.json" },
    });
    expect(vectors.createdTargets).toEqual([]);
    expect(await readStateBackupManifest(fixture.backup)).toEqual(manifest);

    await restoreStateBackup({
      source: fixture.backup,
      destinationHome: fixture.restore,
      expectedIdentity: identity,
      vectors,
    });

    const restoredIngestion = new DatabaseSync(
      join(fixture.restore, "ingestion.db"),
      { readOnly: true },
    );
    const restoredRegistry = new DatabaseSync(
      join(fixture.restore, "registry.db"),
      { readOnly: true },
    );
    try {
      expect(
        restoredIngestion
          .prepare("SELECT state_namespace_id FROM ingestion_metadata")
          .get(),
      ).toEqual({ state_namespace_id: identity.stateNamespaceId });
      expect(
        restoredRegistry
          .prepare("SELECT security_domain FROM registry_metadata")
          .get(),
      ).toEqual({ security_domain: identity.securityDomain });
      expect(
        restoredRegistry.prepare("SELECT label FROM backup_probe").get(),
      ).toEqual({ label: "approved-state" });
    } finally {
      restoredIngestion.close();
      restoredRegistry.close();
    }
    expect(await readFile(join(fixture.restore, "sources.json"), "utf8"))
      .toBe('{"schemaVersion":1,"sources":{}}\n');
  });

  it("rejects a different deployment identity before restoring anything", async () => {
    const fixture = await stateFixture();
    const vectors = new RecordingVectorArchive();
    await createStateBackup({
      destination: fixture.backup,
      identity,
      paths: fixture.paths,
      vectors,
    });

    await expect(
      restoreStateBackup({
        source: fixture.backup,
        destinationHome: fixture.restore,
        expectedIdentity: {
          stateNamespaceId: "state_other",
          securityDomain: identity.securityDomain,
        },
        vectors,
      }),
    ).rejects.toMatchObject<Partial<StateBackupError>>({
      code: "restore_identity_mismatch",
    });
    expect(vectors.restoreCalls).toBe(0);
  });

  it("detects a changed database before creating Qdrant state", async () => {
    const fixture = await stateFixture();
    const vectors = new RecordingVectorArchive();
    await createStateBackup({
      destination: fixture.backup,
      identity,
      paths: fixture.paths,
      vectors,
    });
    await writeFile(
      join(fixture.backup, "sqlite", "ingestion.db"),
      "tampered",
      "utf8",
    );

    await expect(
      restoreStateBackup({
        source: fixture.backup,
        destinationHome: fixture.restore,
        expectedIdentity: identity,
        vectors,
      }),
    ).rejects.toMatchObject<Partial<StateBackupError>>({
      code: "restore_integrity_failed",
    });
    expect(vectors.restoreCalls).toBe(0);
  });

  it("never overwrites an existing backup or restore destination", async () => {
    const fixture = await stateFixture();
    const vectors = new RecordingVectorArchive();
    await writeFile(fixture.backup, "occupied", "utf8");
    await expect(
      createStateBackup({
        destination: fixture.backup,
        identity,
        paths: fixture.paths,
        vectors,
      }),
    ).rejects.toMatchObject<Partial<StateBackupError>>({
      code: "backup_destination_exists",
    });

    await rm(fixture.backup, { force: true });
    await createStateBackup({
      destination: fixture.backup,
      identity,
      paths: fixture.paths,
      vectors,
    });
    await writeFile(fixture.restore, "occupied", "utf8");
    await expect(
      restoreStateBackup({
        source: fixture.backup,
        destinationHome: fixture.restore,
        expectedIdentity: identity,
        vectors,
      }),
    ).rejects.toMatchObject<Partial<StateBackupError>>({
      code: "restore_destination_exists",
    });
  });

  it("refuses a headerless Registry store instead of assigning the configured identity", async () => {
    const fixture = await stateFixture();
    const registry = new DatabaseSync(fixture.paths.registryDatabase);
    registry.exec("DROP TABLE registry_metadata");
    registry.close();

    await expect(
      createStateBackup({
        destination: fixture.backup,
        identity,
        paths: fixture.paths,
        vectors: new RecordingVectorArchive(),
      }),
    ).rejects.toMatchObject<Partial<StateBackupError>>({
      code: "backup_state_corrupt",
    });
  });
});

class RecordingVectorArchive implements VectorSnapshotArchive {
  createdTargets: readonly { readonly collectionName: string }[] = [];
  restoreCalls = 0;

  async create(input: {
    readonly targets: readonly { readonly collectionName: string }[];
    readonly directory: string;
  }): Promise<readonly StateBackupQdrantArtifact[]> {
    void input.directory;
    this.createdTargets = input.targets;
    return [];
  }

  async restore(): Promise<VectorSnapshotRestoreLease> {
    this.restoreCalls += 1;
    return { rollback: async () => undefined };
  }
}

async function stateFixture(): Promise<{
  readonly backup: string;
  readonly restore: string;
  readonly paths: {
    readonly ingestionDatabase: string;
    readonly registryDatabase: string;
    readonly sourcesFile: string;
  };
}> {
  const directory = await mkdtemp(join(tmpdir(), "contextctl-backup-test-"));
  directories.push(directory);
  const ingestionDatabase = join(directory, "ingestion.db");
  const registryDatabase = join(directory, "registry.db");
  const sourcesFile = join(directory, "sources.json");
  openIngestionDatabase({ location: ingestionDatabase, ...identity }).close();

  const registry = new DatabaseSync(registryDatabase);
  registry.exec(`
    PRAGMA user_version = 1;
    CREATE TABLE registry_metadata (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      state_namespace_id TEXT NOT NULL,
      security_domain TEXT NOT NULL
    );
    INSERT INTO registry_metadata (
      singleton, state_namespace_id, security_domain
    ) VALUES (1, '${identity.stateNamespaceId}', '${identity.securityDomain}');
    CREATE TABLE backup_probe (label TEXT NOT NULL);
    INSERT INTO backup_probe (label) VALUES ('approved-state');
  `);
  registry.close();
  await writeFile(sourcesFile, '{"schemaVersion":1,"sources":{}}\n', {
    encoding: "utf8",
    mode: 0o600,
  });
  return {
    backup: join(directory, "backup"),
    restore: join(directory, "restored-home"),
    paths: { ingestionDatabase, registryDatabase, sourcesFile },
  };
}
