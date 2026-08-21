import { describe, expect, it } from "vitest";

import {
  DOCUMENT_KEYWORD_EXTRACTION_POLICY_VERSION,
} from "../src/domain/derived-publication-keywords.js";
import {
  InMemoryIngestionPublicationStore,
  IngestionPublicationCommitIncomplete,
  IngestionPublicationStoreConflict,
  SqliteIngestionPublicationStore,
  buildEmptyMarkdownPublication,
  buildMarkdownPublication,
  createPublishedDocumentScopes,
  openIngestionDatabase,
  type IngestionPublicationStore,
} from "../src/index.js";
import {
  createDocumentFixture,
  createIndexManifestFixture,
  createSemanticUnitFixture,
} from "./fixtures/document-fixture.js";
import { rootId } from "./fixtures/root-id-fixture.js";

const NOW = "2026-08-19T00:00:00.000Z";

describe("Publication recovery intent", () => {
  it("canonicalizes producer array order before freezing Publication bytes", () => {
    const document = createDocumentFixture();
    const semanticUnits = createSemanticUnitFixture();
    const manifestDraft = createIndexManifestFixture();
    const scopes = createPublishedDocumentScopes({
      manifest: manifestDraft,
      semanticScopes: [{ semanticUnitIds: ["unit_payment_failures"] }],
    });
    const manifest = {
      ...manifestDraft,
      scopeRevisions: scopes.map(({ scopeId, scopeVersion }) => ({
        scopeId,
        scopeVersion,
      })),
    };

    const ordered = buildMarkdownPublication({
      publicationId: rootId("pub", "canonical-order"),
      document,
      semanticUnits,
      manifest,
      scopes,
    });
    const reordered = buildMarkdownPublication({
      publicationId: rootId("pub", "canonical-order"),
      document,
      semanticUnits: [...semanticUnits].reverse(),
      manifest,
      scopes: [...scopes].reverse(),
    });

    expect(reordered).toEqual(ordered);
    const section = ordered.knowledgeUnits.find(
      (unit) => unit.id === "unit_payment_failures",
    );
    expect(section?.facts).toContainEqual({
      name: "keywords.derived",
      value: ["after", "failed", "five", "minutes", "payments", "retry"],
    });
    expect(section?.provenance.policyVersions["schema.extraction"]).toBe(
      DOCUMENT_KEYWORD_EXTRACTION_POLICY_VERSION,
    );
    const documentRoot = ordered.knowledgeUnits.find(
      (unit) => unit.id === "unit_payments",
    );
    expect(
      documentRoot?.facts.some((fact) => fact.name === "keywords.derived"),
    ).toBe(false);
  });

  it.each(["memory", "sqlite"] as const)(
    "freezes canonical bytes and commits the exact intent in %s",
    async (adapter) => {
      const database =
        adapter === "sqlite"
          ? openIngestionDatabase({
              location: ":memory:",
              stateNamespaceId: "state_intent_test",
              securityDomain: "tenant-a",
            })
          : undefined;
      const store: IngestionPublicationStore =
        database === undefined
          ? new InMemoryIngestionPublicationStore()
          : new SqliteIngestionPublicationStore(database);
      const initial = buildEmptyMarkdownPublication({
        publicationId: rootId("pub", `${adapter}-initial`),
        document: createDocumentFixture(),
        producedAt: NOW,
      });

      const prepared = await store.prepareRecoveryIntent(initial);
      const repeated = await store.prepareRecoveryIntent(
        structuredClone(initial),
      );

      expect(prepared.status).toBe("prepared");
      expect(repeated.status).toBe("already_prepared");
      expect(repeated.intent.canonicalPayload).toBe(
        prepared.intent.canonicalPayload,
      );
      expect(await store.pendingRecoveryIntentForSource(initial.sourceId)).toEqual(
        prepared.intent,
      );
      await expect(
        store.prepareRecoveryIntent({
          ...initial,
          producedAt: "2026-08-19T00:00:01.000Z",
        }),
      ).rejects.toBeInstanceOf(IngestionPublicationStoreConflict);

      const nextDocument = {
        ...createDocumentFixture(),
        observationId: rootId("obs", `${adapter}-second`),
      };
      const fork = buildEmptyMarkdownPublication({
        publicationId: rootId("pub", `${adapter}-fork`),
        document: nextDocument,
        producedAt: "2026-08-19T00:01:00.000Z",
      });
      await expect(
        store.prepareRecoveryIntent(fork),
      ).rejects.toBeInstanceOf(IngestionPublicationStoreConflict);

      expect(await store.commitReady(prepared.intent.publication)).toMatchObject({
        status: "published",
        publication: initial,
      });
      expect(await store.pendingRecoveryIntentForSource(initial.sourceId)).toBeUndefined();
      expect(await store.findRecoveryIntent(initial.publicationId)).toMatchObject({
        state: "committed",
        canonicalPayload: prepared.intent.canonicalPayload,
      });
      expect(await store.commitReady(initial)).toMatchObject({
        status: "already_published",
      });

      const next = buildEmptyMarkdownPublication({
        publicationId: rootId("pub", `${adapter}-next`),
        document: nextDocument,
        producedAt: "2026-08-19T00:01:00.000Z",
        previous: initial,
      });
      await expect(store.commitReady(next)).rejects.toBeInstanceOf(
        IngestionPublicationCommitIncomplete,
      );
      const nextIntent = await store.prepareRecoveryIntent(next);
      await store.commitReady(initial);
      expect(await store.pendingRecoveryIntentForSource(initial.sourceId)).toEqual(
        nextIntent.intent,
      );
      await expect(store.commitReady(next)).resolves.toMatchObject({
        status: "published",
      });
      expect((await store.latestForSource(initial.sourceId))?.publicationId).toBe(
        next.publicationId,
      );
      database?.close();
    },
  );
});
