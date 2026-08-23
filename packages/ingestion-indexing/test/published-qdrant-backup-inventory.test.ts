import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  PublishedDocumentIndexRef,
  PublishedDocumentScope,
} from "@contextctl/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  listPublishedQdrantBackupTargets,
  openIngestionDatabase,
  PublishedQdrantBackupInventoryError,
  SqliteIndexPublicationStore,
  type PublishedIndexVersion,
} from "../src/index.js";
import { createIndexManifestFixture } from "./fixtures/document-fixture.js";

const identity = {
  stateNamespaceId: "state_backup_inventory",
  securityDomain: "backup-inventory",
};
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("published Qdrant backup inventory", () => {
  it("includes every distinct collection referenced by retained immutable versions", async () => {
    const { database } = await fixture();
    const store = new SqliteIndexPublicationStore(database);
    await store.commitCurrent(published("aaaa", "1".repeat(32)));
    await store.commitCurrent(published("bbbb", "1".repeat(32)));
    await store.commitCurrent(published("cccc", "2".repeat(32)));

    expect(listPublishedQdrantBackupTargets(database, identity)).toEqual([
      { collectionName: `contextctl_${"1".repeat(32)}` },
      { collectionName: `contextctl_${"2".repeat(32)}` },
    ]);
    database.close();
  });

  it("fails closed on a different identity or a non-Qdrant binding", async () => {
    const first = await fixture();
    expect(() =>
      listPublishedQdrantBackupTargets(first.database, {
        ...identity,
        securityDomain: "other",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<PublishedQdrantBackupInventoryError>>({
        code: "identity_mismatch",
      }),
    );
    first.database.close();

    const second = await fixture();
    await new SqliteIndexPublicationStore(second.database).commitCurrent(
      published("aaaa", "memory:v1:not-qdrant", true),
    );
    expect(() =>
      listPublishedQdrantBackupTargets(second.database, identity),
    ).toThrowError(
      expect.objectContaining<Partial<PublishedQdrantBackupInventoryError>>({
        code: "unsupported_vector_binding",
      }),
    );
    second.database.close();
  });
});

async function fixture() {
  const directory = await mkdtemp(
    join(tmpdir(), "contextctl-backup-inventory-"),
  );
  directories.push(directory);
  const database = openIngestionDatabase({
    location: join(directory, "ingestion.db"),
    ...identity,
  });
  return { database };
}

function published(
  revision: "aaaa" | "bbbb" | "cccc",
  handle: string,
  literalHandle = false,
): PublishedIndexVersion {
  const fixture = createIndexManifestFixture();
  const indexVersion = `idxv_${revision}`;
  const scopeVersion = `scpv_${revision}`;
  const manifest = {
    ...fixture,
    stateNamespaceId: identity.stateNamespaceId,
    securityDomain: identity.securityDomain,
    indexVersion,
    scopeRevisions: [
      { scopeId: "scope_backup_inventory", scopeVersion },
    ],
    publishedAt: `2026-08-24T00:00:0${revision === "aaaa" ? "1" : revision === "bbbb" ? "2" : "3"}.000Z`,
  };
  const documentIndex: PublishedDocumentIndexRef = {
    documentIndexId: manifest.documentIndexId,
    sourceId: manifest.sourceId,
    documentId: manifest.documentId,
    indexVersion,
  };
  const scope: PublishedDocumentScope = {
    scopeId: "scope_backup_inventory",
    scopeVersion,
    kind: "managed_document",
    documentIndex,
    selector: { kind: "document" },
  };
  return {
    manifest,
    documentIndex,
    scopes: [scope],
    binding: {
      stateNamespaceId: identity.stateNamespaceId,
      documentIndexId: manifest.documentIndexId,
      indexVersion,
      connectorId: "vector.qdrant.backup",
      accessHandle: literalHandle ? handle : `qdrant:v1:${handle}`,
      securityDomain: identity.securityDomain,
    },
  };
}
