import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  createSelectionAuditRecord,
  InMemoryCardCatalog,
  selectContext,
  type SelectionAuditRecord,
} from "@contextctl/selection-delivery";
import { afterEach, describe, expect, it } from "vitest";

import {
  inspectSelectionAuditDatabase,
  openSelectionAuditDatabase,
  SqliteSelectionAuditStore,
} from "../../src/selection-audit/sqlite-selection-audit-store.js";
import { WorkerThreadSelectionAuditStore } from "../../src/selection-audit/worker-thread-selection-audit-store.js";

const IDENTITY = {
  stateNamespaceId: "state_audit_test",
  securityDomain: "tenant-audit-test",
};
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function record(
  suffix: string,
  recordedAt: string,
): Promise<SelectionAuditRecord> {
  const plan = await selectContext(
    { catalog: new InMemoryCardCatalog([]) },
    "이 문자열은 저장되면 안 됩니다",
  );
  return createSelectionAuditRecord({
    plan,
    auditId: `sa_${suffix.padStart(32, "0")}`,
    recordedAt,
  });
}

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "contextctl-audit-"));
  temporaryDirectories.push(directory);
  return join(directory, "selection-audit.db");
}

describe("SqliteSelectionAuditStore", () => {
  it("runs durable writes behind an actually asynchronous worker boundary", async () => {
    const location = databasePath();
    openSelectionAuditDatabase({ location, stateIdentity: IDENTITY }).close();
    const store = new WorkerThreadSelectionAuditStore({
      location,
      stateIdentity: IDENTITY,
    });
    const stored = await record("1", new Date().toISOString());

    const append = store.append(stored);
    expect(append).toBeInstanceOf(Promise);
    await append;
    await expect(store.list(1)).resolves.toMatchObject([
      { auditId: stored.auditId, recordDigest: stored.recordDigest },
    ]);
    await expect(store.find(stored.auditId)).resolves.toEqual(stored);
    await store.close();
    await expect(store.append(stored)).rejects.toThrow(/closed/u);
  });

  it("persists bounded records with a private database mode", async () => {
    const location = databasePath();
    const database = openSelectionAuditDatabase({
      location,
      stateIdentity: IDENTITY,
    });
    const now = () => Date.parse("2026-08-27T00:02:00.000Z");
    const store = new SqliteSelectionAuditStore(database, now, location);
    const first = await record("1", "2026-08-27T00:00:00.000Z");
    const second = await record("2", "2026-08-27T00:01:00.000Z");
    await store.append(first);
    await store.append(second);
    expect(statSync(location).mode & 0o777).toBe(0o600);
    for (const sidecar of [`${location}-wal`, `${location}-shm`]) {
      expect(existsSync(sidecar)).toBe(true);
      expect(statSync(sidecar).mode & 0o777).toBe(0o600);
    }
    database.close();
    const reopened = openSelectionAuditDatabase({
      location,
      stateIdentity: IDENTITY,
      readOnly: true,
    });
    const readStore = new SqliteSelectionAuditStore(reopened, now, location);
    await expect(readStore.list(2)).resolves.toMatchObject([
      { auditId: second.auditId, recordDigest: second.recordDigest },
      { auditId: first.auditId, recordDigest: first.recordDigest },
    ]);
    await expect(readStore.find(first.auditId)).resolves.toEqual(first);
    reopened.close();
  });

  it("prunes a lone record older than thirty days against wall-clock time", async () => {
    const database = openSelectionAuditDatabase({
      location: ":memory:",
      stateIdentity: IDENTITY,
    });
    const store = new SqliteSelectionAuditStore(
      database,
      () => Date.parse("2026-08-27T00:00:00.000Z"),
    );
    await store.append(await record("1", "2026-06-01T00:00:00.000Z"));

    await expect(store.list(10)).resolves.toEqual([]);
    database.close();
  });

  it("refuses an unidentified or differently owned database", () => {
    const unidentified = databasePath();
    const raw = new DatabaseSync(unidentified);
    raw.exec("CREATE TABLE foreign_records (id TEXT PRIMARY KEY)");
    raw.close();
    expect(() =>
      openSelectionAuditDatabase({
        location: unidentified,
        stateIdentity: IDENTITY,
      }),
    ).toThrow(/unidentified/u);
    expect(existsSync(`${unidentified}-wal`)).toBe(false);

    const owned = databasePath();
    openSelectionAuditDatabase({
      location: owned,
      stateIdentity: IDENTITY,
    }).close();
    expect(() =>
      openSelectionAuditDatabase({
        location: owned,
        stateIdentity: { ...IDENTITY, securityDomain: "another-tenant" },
        readOnly: true,
      }),
    ).toThrow(/identity/u);
  });

  it("fails closed when persisted bytes are corrupted", async () => {
    const database = openSelectionAuditDatabase({
      location: ":memory:",
      stateIdentity: IDENTITY,
    });
    const store = new SqliteSelectionAuditStore(database);
    const stored = await record("1", "2026-08-27T00:00:00.000Z");
    await store.append(stored);
    database
      .prepare(
        "UPDATE selection_audit_records SET record_json = record_json || ' '",
      )
      .run();

    await expect(store.find(stored.auditId)).rejects.toThrow(/byte count/u);
    database.close();
  });

  it("fails closed when the indexed timestamp disagrees with the payload", async () => {
    const database = openSelectionAuditDatabase({
      location: ":memory:",
      stateIdentity: IDENTITY,
    });
    const now = () => Date.parse("2026-08-27T00:01:00.000Z");
    const store = new SqliteSelectionAuditStore(database, now);
    const stored = await record("1", "2026-08-27T00:00:00.000Z");
    await store.append(stored);
    database
      .prepare("UPDATE selection_audit_records SET recorded_at_ms = recorded_at_ms + 1")
      .run();

    await expect(store.find(stored.auditId)).rejects.toThrow(/does not match/u);
    database.close();
  });

  it("refuses a WAL-only read snapshot instead of ignoring committed records", () => {
    const location = databasePath();
    openSelectionAuditDatabase({ location, stateIdentity: IDENTITY }).close();
    rmSync(`${location}-shm`, { force: true });
    writeFileSync(`${location}-wal`, "orphaned-wal");

    expect(
      inspectSelectionAuditDatabase({ location, stateIdentity: IDENTITY }),
    ).toMatchObject({ status: "incompatible", detail: expect.stringMatching(/WAL/u) });
  });

  it("reports compatibility without mutating the store", async () => {
    const location = databasePath();
    const database = openSelectionAuditDatabase({
      location,
      stateIdentity: IDENTITY,
    });
    await new SqliteSelectionAuditStore(database).append(
      await record("1", "2026-08-27T00:00:00.000Z"),
    );
    database.close();

    expect(
      inspectSelectionAuditDatabase({ location, stateIdentity: IDENTITY }),
    ).toEqual({ status: "compatible", recordCount: 1 });
  });
});
