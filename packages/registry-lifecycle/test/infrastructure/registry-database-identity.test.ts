import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  openRegistryDatabase,
  REGISTRY_DATABASE_APPLICATION_ID,
} from "../../src/infrastructure/sqlite/registry-database.js";

/**
 * The Registry opener refuses files that are not its own.
 *
 * The failure this prevents is silent: `CREATE TABLE IF NOT EXISTS` on a
 * misconfigured `CONTEXTCTL_REGISTRY_DATABASE` would add Registry's tables into
 * another domain's file, and two domains' states would share one database with
 * no error anywhere. Every refusal case therefore also asserts the file was
 * left untouched — refusing after writing would be the same accident with a
 * message attached.
 */

const INGESTION_APPLICATION_ID = 0x4354584c;

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function databaseFile(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "contextctl-identity-"));
  directories.push(directory);
  return join(directory, name);
}

function applicationIdOf(location: string): number {
  const database = new DatabaseSync(location);
  const row = database.prepare("PRAGMA application_id").get() as {
    application_id: number;
  };
  database.close();
  return row.application_id;
}

function objectNamesOf(location: string): readonly string[] {
  const database = new DatabaseSync(location);
  const rows = database
    .prepare(
      "SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string }[];
  database.close();
  return rows.map((row) => row.name);
}

describe("registry database ownership", () => {
  it("stamps a new file with Registry's application id", async () => {
    const location = await databaseFile("registry.db");

    openRegistryDatabase(location).close();

    expect(applicationIdOf(location)).toBe(REGISTRY_DATABASE_APPLICATION_ID);
  });

  it("reopens its own file", async () => {
    const location = await databaseFile("registry.db");
    openRegistryDatabase(location).close();

    const reopened = openRegistryDatabase(location);
    const cards = reopened
      .prepare("SELECT COUNT(*) AS total FROM cards")
      .get() as { total: number };
    reopened.close();

    expect(cards.total).toBe(0);
  });

  it("claims a registry file from before the mark existed", async () => {
    // A legacy registry.db: Registry tables, application_id 0. `cards` has been
    // part of every Registry schema, so its presence is the fingerprint.
    const location = await databaseFile("registry.db");
    const legacy = new DatabaseSync(location);
    legacy.exec(
      "CREATE TABLE cards (card_id TEXT PRIMARY KEY, description TEXT NOT NULL, representative_questions TEXT NOT NULL, aliases TEXT NOT NULL, keywords TEXT NOT NULL, sensitive INTEGER NOT NULL, allowed_usage TEXT NOT NULL, current_version_id TEXT)",
    );
    legacy.close();

    openRegistryDatabase(location).close();

    expect(applicationIdOf(location)).toBe(REGISTRY_DATABASE_APPLICATION_ID);
  });

  it("refuses a file marked by another application, writing nothing", async () => {
    // ingestion.db as the operator would actually mispoint to it: marked with
    // Ingestion's id and holding its own tables.
    const location = await databaseFile("ingestion.db");
    const foreign = new DatabaseSync(location);
    foreign.exec("CREATE TABLE publications (publication_id TEXT PRIMARY KEY)");
    foreign.exec(`PRAGMA application_id = ${String(INGESTION_APPLICATION_ID)}`);
    foreign.close();
    const before = objectNamesOf(location);

    expect(() => openRegistryDatabase(location)).toThrowError(
      expect.objectContaining({
        name: "RegistryDatabaseIdentityError",
        code: "identity_mismatch",
      }),
    );

    expect(objectNamesOf(location)).toEqual(before);
    expect(applicationIdOf(location)).toBe(INGESTION_APPLICATION_ID);
  });

  it("refuses an unmarked file holding some other schema, writing nothing", async () => {
    // An ingestion.db from before Ingestion stamped its files: application_id
    // is 0, so only the schema can say whose it is — and it is not Registry's.
    const location = await databaseFile("old-ingestion.db");
    const foreign = new DatabaseSync(location);
    foreign.exec("CREATE TABLE publications (publication_id TEXT PRIMARY KEY)");
    foreign.close();
    const before = objectNamesOf(location);

    expect(() => openRegistryDatabase(location)).toThrowError(
      expect.objectContaining({
        name: "RegistryDatabaseIdentityError",
        code: "foreign_schema",
      }),
    );

    expect(objectNamesOf(location)).toEqual(before);
    expect(applicationIdOf(location)).toBe(0);
  });

  it("still opens :memory:", () => {
    const database = openRegistryDatabase(":memory:");
    const cards = database
      .prepare("SELECT COUNT(*) AS total FROM cards")
      .get() as { total: number };
    database.close();

    expect(cards.total).toBe(0);
  });
});
