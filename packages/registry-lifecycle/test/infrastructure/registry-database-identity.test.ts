import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  openRegistryDatabase,
  REGISTRY_DATABASE_APPLICATION_ID,
  REGISTRY_DATABASE_SCHEMA_VERSION,
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

function schemaVersionOf(location: string): number {
  const database = new DatabaseSync(location);
  const row = database.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  database.close();
  return row.user_version;
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

    openRegistryDatabase({ location, stateNamespaceId: "state_local", securityDomain: "local" }).close();

    expect(applicationIdOf(location)).toBe(REGISTRY_DATABASE_APPLICATION_ID);
  });

  it("reopens its own file", async () => {
    const location = await databaseFile("registry.db");
    openRegistryDatabase({ location, stateNamespaceId: "state_local", securityDomain: "local" }).close();

    const reopened = openRegistryDatabase({ location, stateNamespaceId: "state_local", securityDomain: "local" });
    const cards = reopened
      .prepare("SELECT COUNT(*) AS total FROM cards")
      .get() as { total: number };
    reopened.close();

    expect(cards.total).toBe(0);
  });

  it("refuses an unmarked file that already holds Cards, writing nothing", async () => {
    // The data looks like ours, and that is exactly why it is refused. Nothing
    // in an unmarked file says which installation wrote it, so adopting it
    // would mean absorbing state of unprovable origin — and Cards from another
    // security domain would then be served under this one.
    const location = await databaseFile("registry.db");
    const legacy = new DatabaseSync(location);
    legacy.exec(
      "CREATE TABLE cards (card_id TEXT PRIMARY KEY, description TEXT NOT NULL, representative_questions TEXT NOT NULL, aliases TEXT NOT NULL, keywords TEXT NOT NULL, sensitive INTEGER NOT NULL, allowed_usage TEXT NOT NULL, current_version_id TEXT)",
    );
    legacy.close();
    const before = objectNamesOf(location);

    expect(() =>
      openRegistryDatabase({
        location,
        stateNamespaceId: "state_local",
        securityDomain: "local",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "unidentified_schema" }),
    );

    expect(objectNamesOf(location)).toEqual(before);
    expect(applicationIdOf(location)).toBe(0);
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

    expect(() => openRegistryDatabase({ location, stateNamespaceId: "state_local", securityDomain: "local" })).toThrowError(
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

    expect(() => openRegistryDatabase({ location, stateNamespaceId: "state_local", securityDomain: "local" })).toThrowError(
      expect.objectContaining({
        name: "RegistryDatabaseIdentityError",
        code: "unidentified_schema",
      }),
    );

    expect(objectNamesOf(location)).toEqual(before);
    expect(applicationIdOf(location)).toBe(0);
  });

  it("still opens :memory:", () => {
    const database = openRegistryDatabase({ location: ":memory:", stateNamespaceId: "state_local", securityDomain: "local" });
    const cards = database
      .prepare("SELECT COUNT(*) AS total FROM cards")
      .get() as { total: number };
    database.close();

    expect(cards.total).toBe(0);
  });

  it("records the deployment identity and refuses a different one, writing nothing", async () => {
    // The second axis, same as openIngestionDatabase: application_id says which
    // domain a file belongs to, this says which installation. A registry.db
    // written under one security domain must not serve another.
    const location = await databaseFile("registry.db");
    openRegistryDatabase({
      location,
      stateNamespaceId: "state_prod",
      securityDomain: "prod",
    }).close();
    const before = objectNamesOf(location);

    expect(() =>
      openRegistryDatabase({
        location,
        stateNamespaceId: "state_local",
        securityDomain: "local",
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "RegistryDatabaseIdentityError",
        code: "identity_mismatch",
      }),
    );

    expect(objectNamesOf(location)).toEqual(before);
  });

  it("reopens under the same deployment identity", async () => {
    const location = await databaseFile("registry.db");
    openRegistryDatabase({
      location,
      stateNamespaceId: "state_prod",
      securityDomain: "prod",
    }).close();

    const reopened = openRegistryDatabase({
      location,
      stateNamespaceId: "state_prod",
      securityDomain: "prod",
    });
    reopened.close();
  });

  it("refuses a marked file whose identity was never recorded", async () => {
    // The mark and the identity are written in the same open, so a file with
    // one and not the other stopped half way — not an older shape to adopt.
    const location = await databaseFile("registry.db");
    const half = new DatabaseSync(location);
    half.exec("CREATE TABLE cards (card_id TEXT PRIMARY KEY)");
    half.exec(
      `PRAGMA application_id = ${String(REGISTRY_DATABASE_APPLICATION_ID)}`,
    );
    half.close();

    expect(() =>
      openRegistryDatabase({
        location,
        stateNamespaceId: "state_local",
        securityDomain: "local",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "schema_invalid" }),
    );
  });

  it("refuses a blank identity before touching the file", async () => {
    const location = await databaseFile("registry.db");

    expect(() =>
      openRegistryDatabase({
        location,
        stateNamespaceId: "  ",
        securityDomain: "local",
      }),
    ).toThrowError(TypeError);

    expect(objectNamesOf(location)).toEqual([]);
  });

  it("stamps the schema version and refuses a file a newer build wrote", async () => {
    const location = await databaseFile("registry.db");
    openRegistryDatabase({
      location,
      stateNamespaceId: "state_local",
      securityDomain: "local",
    }).close();
    expect(schemaVersionOf(location)).toBe(REGISTRY_DATABASE_SCHEMA_VERSION);

    const ahead = new DatabaseSync(location);
    ahead.exec(
      `PRAGMA user_version = ${String(REGISTRY_DATABASE_SCHEMA_VERSION + 1)}`,
    );
    ahead.close();
    const before = objectNamesOf(location);

    // Reading a shape this build does not know is the quiet corruption the
    // version exists to prevent: the tables look familiar and the rows may not
    // mean what they did.
    expect(() =>
      openRegistryDatabase({
        location,
        stateNamespaceId: "state_local",
        securityDomain: "local",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "schema_newer" }),
    );
    expect(objectNamesOf(location)).toEqual(before);
  });

  it("refuses a file whose columns do not match the version it claims", async () => {
    // Marked as Registry's, claiming this build's version, and holding a
    // half-shaped `cards` table — hand-edited, or a migration that stopped.
    // CREATE TABLE IF NOT EXISTS leaves it as it is, so only a column check
    // catches it before a store reads a column that is not there.
    const location = await databaseFile("registry.db");
    const broken = new DatabaseSync(location);
    broken.exec("CREATE TABLE cards (card_id TEXT PRIMARY KEY)");
    broken.exec(
      `PRAGMA application_id = ${String(REGISTRY_DATABASE_APPLICATION_ID)}`,
    );
    broken.exec(
      `PRAGMA user_version = ${String(REGISTRY_DATABASE_SCHEMA_VERSION)}`,
    );
    broken.close();

    expect(() =>
      openRegistryDatabase({
        location,
        stateNamespaceId: "state_local",
        securityDomain: "local",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "schema_invalid" }),
    );
  });

  it("makes a file-backed database durable", async () => {
    // The approval trail lives here, and nothing re-derives an approval: a
    // power cut that lost the last decisions would bring Cards back serving
    // what someone had withdrawn.
    const location = await databaseFile("registry.db");

    openRegistryDatabase({
      location,
      stateNamespaceId: "state_local",
      securityDomain: "local",
    }).close();

    const database = new DatabaseSync(location);
    const journal = database.prepare("PRAGMA journal_mode").get() as {
      journal_mode: string;
    };
    database.close();
    expect(journal.journal_mode.toLowerCase()).toBe("wal");
  });

  it("refuses a blank location before opening anything", () => {
    expect(() =>
      openRegistryDatabase({
        location: "   ",
        stateNamespaceId: "state_local",
        securityDomain: "local",
      }),
    ).toThrowError(TypeError);
  });

  it("refuses a metadata table of the right name and the wrong shape", async () => {
    // Read before checked, this surfaced as a raw SQLite `no such column`:
    // nothing a caller could branch on, and no statement that the file is
    // unusable.
    const location = await databaseFile("registry.db");
    const wrong = new DatabaseSync(location);
    wrong.exec(
      "CREATE TABLE registry_metadata (singleton INTEGER PRIMARY KEY, other TEXT)",
    );
    wrong.exec(
      `PRAGMA application_id = ${String(REGISTRY_DATABASE_APPLICATION_ID)}`,
    );
    wrong.exec(
      `PRAGMA user_version = ${String(REGISTRY_DATABASE_SCHEMA_VERSION)}`,
    );
    wrong.close();

    expect(() =>
      openRegistryDatabase({
        location,
        stateNamespaceId: "state_local",
        securityDomain: "local",
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "RegistryDatabaseIdentityError",
        code: "schema_invalid",
      }),
    );
  });

  it("reports a newer shape as newer, not as a mismatched deployment", async () => {
    // Both are true of this file, and only one is actionable: a build that
    // cannot read the shape cannot claim to know whose the identity inside it
    // is. Reporting the mismatch would send an operator after the wrong thing.
    const location = await databaseFile("registry.db");
    openRegistryDatabase({
      location,
      stateNamespaceId: "state_prod",
      securityDomain: "prod",
    }).close();
    const ahead = new DatabaseSync(location);
    ahead.exec(
      `PRAGMA user_version = ${String(REGISTRY_DATABASE_SCHEMA_VERSION + 5)}`,
    );
    ahead.close();

    expect(() =>
      openRegistryDatabase({
        location,
        stateNamespaceId: "state_local",
        securityDomain: "local",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "schema_newer" }),
    );
  });
});
