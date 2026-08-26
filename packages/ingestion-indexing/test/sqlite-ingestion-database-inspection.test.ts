import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  INGESTION_DATABASE_SCHEMA_VERSION,
  inspectIngestionDatabase,
  openIngestionDatabase,
} from "../src/infrastructure/sqlite-ingestion-database.js";

const directories: string[] = [];
const identity = {
  stateNamespaceId: "state_test",
  securityDomain: "test",
} as const;

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "contextctl-ingestion-inspect-"));
  directories.push(directory);
  return join(directory, "ingestion.db");
}

describe("inspectIngestionDatabase", () => {
  it("reports a missing file without creating it", async () => {
    const location = await databasePath();

    expect(inspectIngestionDatabase({ location, ...identity })).toEqual({
      status: "missing",
    });
    await expect(stat(location)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("validates a compatible read-only file without changing it or sidecars", async () => {
    const location = await databasePath();
    openIngestionDatabase({ location, ...identity }).close();
    const directory = dirname(location);
    const beforeBytes = await readFile(location);
    const beforeStat = await stat(location);
    const beforeFiles = await readdir(directory);
    await chmod(location, 0o444);

    expect(inspectIngestionDatabase({ location, ...identity })).toEqual({
      status: "compatible",
      schemaVersion: INGESTION_DATABASE_SCHEMA_VERSION,
    });

    expect(await readFile(location)).toEqual(beforeBytes);
    expect((await stat(location)).mtimeMs).toBe(beforeStat.mtimeMs);
    expect(await readdir(directory)).toEqual(beforeFiles);
  });

  it("reads committed schema metadata while a WAL writer is open", async () => {
    const location = await databasePath();
    const writer = openIngestionDatabase({ location, ...identity });
    try {
      const beforeFiles = await readdir(dirname(location));
      expect(inspectIngestionDatabase({ location, ...identity })).toEqual({
        status: "compatible",
        schemaVersion: INGESTION_DATABASE_SCHEMA_VERSION,
      });
      expect(await readdir(dirname(location))).toEqual(beforeFiles);
    } finally {
      writer.close();
    }
  });

  it("reports identity mismatch before any write", async () => {
    const location = await databasePath();
    openIngestionDatabase({ location, ...identity }).close();
    const before = await readFile(location);

    expect(
      inspectIngestionDatabase({
        location,
        stateNamespaceId: "state_other",
        securityDomain: "other",
      }),
    ).toEqual({ status: "incompatible", code: "identity_mismatch" });
    expect(await readFile(location)).toEqual(before);
  });

  it("distinguishes an older schema from an unreadable database", async () => {
    const location = await databasePath();
    openIngestionDatabase({ location, ...identity }).close();
    const older = new DatabaseSync(location);
    older.exec(
      `PRAGMA user_version = ${String(INGESTION_DATABASE_SCHEMA_VERSION - 1)}`,
    );
    older.close();
    const beforeOlderInspection = await readFile(location);

    expect(inspectIngestionDatabase({ location, ...identity })).toEqual({
      status: "incompatible",
      code: "schema_older",
    });
    expect(await readFile(location)).toEqual(beforeOlderInspection);

    const corruptLocation = await databasePath();
    await writeFile(corruptLocation, "not a sqlite database");
    expect(
      inspectIngestionDatabase({ location: corruptLocation, ...identity }),
    ).toEqual(expect.objectContaining({ status: "unreadable" }));
  });
});
