import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  openIngestionDatabase,
  listPublishedQdrantBackupTargets,
  QdrantVectorIndexAdapter,
  SqliteIndexPublicationStore,
  SqliteIndexStagingAttemptStore,
  SqliteIngestionPublicationStore,
  SqliteMarkdownPublicationCheckpointStore,
  SqliteSourceObservationStore,
  type PublishMarkdownSourceResult,
} from "@contextctl/ingestion-indexing";
import { approveCardVersion } from "@contextctl/registry-lifecycle";

import {
  createDaemonRuntime,
  DEFAULT_EMBEDDING_PROFILE,
  type DaemonIngestionStores,
  type DaemonRuntime,
} from "../src/main.js";
import {
  readStateBackupManifest,
} from "../src/operations/state-backup.js";
import { runStateBackupCommand } from "../src/cli/state-backup-command.js";

const qdrantUrl = process.env.CONTEXTCTL_QDRANT_URL;
const integration = qdrantUrl === undefined ? describe.skip : describe;
const TEST_TIMEOUT_MS = 60_000;
const SOURCE_REFERENCE = "source.backup.recovery.integration";
const directories: string[] = [];
const createdCollections = new Set<string>();

afterEach(async () => {
  for (const collectionName of createdCollections) {
    await deleteCollection(collectionName).catch(() => undefined);
  }
  createdCollections.clear();
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

integration("state backup recovery integration", () => {
  it("restores approved Cards, Scopes and document search, then resumes idempotently", async () => {
    const directory = await mkdtemp(join(tmpdir(), "contextctl-recovery-"));
    directories.push(directory);
    const sourceHome = join(directory, "source-home");
    const restoredHome = join(directory, "restored-home");
    const rejectedHome = join(directory, "must-not-exist");
    const backupDirectory = join(directory, "backup");
    const markdownPath = join(directory, "operations.md");
    await mkdir(sourceHome);
    await writeFile(
      markdownPath,
      "# 운영 안내\n\n## 결제 재시도\n\n결제 실패는 세 번까지 재시도합니다.\n",
      "utf8",
    );
    const suffix = `${String(Date.now())}-${String(process.pid)}`;
    const identity = {
      stateNamespaceId: `recovery-${suffix}`,
      securityDomain: `recovery-${suffix}`,
    };

    const first = openRuntime(sourceHome, markdownPath, identity);
    let publication: PublishMarkdownSourceResult;
    let approvedBefore: Awaited<ReturnType<typeof first.runtime.cards.listApprovedCards>>;
    let resolutionBefore: Awaited<ReturnType<typeof first.runtime.contextApplication.resolveContext>>;
    try {
      publication = await publish(first.runtime);
      for (const target of listPublishedQdrantBackupTargets(
        first.ingestionDatabase,
        identity,
      )) {
        createdCollections.add(target.collectionName);
      }
      await first.runtime.registryIntake.claim(publicationIdOf(publication));
      await approveAllValidatedVersions(first.runtime);
      await first.runtime.prepareCardCandidates();
      approvedBefore = await first.runtime.cards.listApprovedCards();
      resolutionBefore = await first.runtime.contextApplication.resolveContext({
        query: "결제 실패 재시도",
      });
      expect(approvedBefore.cards.length).toBeGreaterThan(0);
      expect(
        resolutionBefore.items.some(
          (item) =>
            item.fulfillment.status === "fulfilled" &&
            item.fulfillment.context.chunks.some((chunk) =>
              chunk.text.includes("세 번"),
            ),
        ),
      ).toBe(true);
    } finally {
      first.close();
    }

    const backupEnvironment = {
      CONTEXTCTL_HOME: sourceHome,
      CONTEXTCTL_QDRANT_URL: requiredQdrantUrl(),
      ...(process.env.CONTEXTCTL_QDRANT_API_KEY === undefined
        ? {}
        : { CONTEXTCTL_QDRANT_API_KEY: process.env.CONTEXTCTL_QDRANT_API_KEY }),
      CONTEXTCTL_STATE_NAMESPACE_ID: identity.stateNamespaceId,
      CONTEXTCTL_SECURITY_DOMAIN: identity.securityDomain,
    };
    const created = await runStateBackupCommand({
      command: { kind: "backup_create", destination: backupDirectory },
      environment: backupEnvironment,
      workingDirectory: directory,
    });
    expect(created.exitCode).toBe(0);
    const manifest = await readStateBackupManifest(backupDirectory);
    expect(manifest.qdrant.length).toBeGreaterThan(0);
    for (const artifact of manifest.qdrant) {
      createdCollections.add(artifact.collectionName);
      await deleteCollection(artifact.collectionName);
    }

    const restoredOutcome = await runStateBackupCommand({
      command: {
        kind: "backup_restore",
        source: backupDirectory,
        targetHome: restoredHome,
      },
      environment: backupEnvironment,
      workingDirectory: directory,
    });
    expect(restoredOutcome.exitCode).toBe(0);

    const restored = openRuntime(restoredHome, markdownPath, identity);
    try {
      const approvedAfter = await restored.runtime.cards.listApprovedCards();
      await restored.runtime.prepareCardCandidates();
      const resolutionAfter = await restored.runtime.contextApplication.resolveContext({
        query: "결제 실패 재시도",
      });

      expect(approvedAfter).toEqual(approvedBefore!);
      expect(resolutionAfter).toEqual(resolutionBefore!);
      await expect(
        restored.runtime.registryIntake.claim(publicationIdOf(publication!)),
      ).resolves.toMatchObject({ status: "already_claimed" });
      await expect(publish(restored.runtime)).resolves.toMatchObject({
        status: "unchanged",
      });
    } finally {
      restored.close();
    }

    await expect(
      runStateBackupCommand({
        command: {
          kind: "backup_restore",
          source: backupDirectory,
          targetHome: rejectedHome,
        },
        environment: backupEnvironment,
        workingDirectory: directory,
      }),
    ).rejects.toMatchObject({ code: "restore_write_failed" });
    await expect(access(rejectedHome)).rejects.toThrow();
  }, TEST_TIMEOUT_MS);
});

function openRuntime(
  home: string,
  markdownPath: string,
  identity: { readonly stateNamespaceId: string; readonly securityDomain: string },
): {
  readonly runtime: DaemonRuntime;
  readonly ingestionDatabase: ReturnType<typeof openIngestionDatabase>;
  close(): void;
} {
  const ingestionDatabase = openIngestionDatabase({
    location: join(home, "ingestion.db"),
    ...identity,
  });
  const stores: DaemonIngestionStores = {
    observations: new SqliteSourceObservationStore(ingestionDatabase),
    checkpoints: new SqliteMarkdownPublicationCheckpointStore(ingestionDatabase),
    publications: new SqliteIngestionPublicationStore(ingestionDatabase),
    indexPublications: new SqliteIndexPublicationStore(ingestionDatabase),
    stagingAttempts: new SqliteIndexStagingAttemptStore(ingestionDatabase),
  };
  const runtime = createDaemonRuntime({
    registryDatabaseLocation: join(home, "registry.db"),
    stateIdentity: identity,
    embeddingProfile: DEFAULT_EMBEDDING_PROFILE,
    vectorIndex: new QdrantVectorIndexAdapter({ url: requiredQdrantUrl() }),
    sourceConfigurations: { [SOURCE_REFERENCE]: { path: markdownPath } },
    ingestionStores: stores,
  });
  return {
    runtime,
    ingestionDatabase,
    close: () => {
      runtime.database.close();
      ingestionDatabase.close();
    },
  };
}

async function publish(runtime: DaemonRuntime): Promise<PublishMarkdownSourceResult> {
  return await runtime.ingestion.workflow.publish({
    source: {
      sourceType: "markdown",
      displayName: "Backup recovery integration",
      configReference: SOURCE_REFERENCE,
      polling: { enabled: false },
    },
    connectorId: runtime.connectorId,
    securityDomain: runtime.securityDomain,
  });
}

async function approveAllValidatedVersions(runtime: DaemonRuntime): Promise<void> {
  const rows = runtime.database.prepare(
    "SELECT card_id, version_id FROM card_versions WHERE validation_state = 'validated' ORDER BY append_order",
  ).all() as unknown as readonly {
    readonly card_id: string;
    readonly version_id: string;
  }[];
  let sequence = 0;
  for (const row of rows) {
    sequence += 1;
    await approveCardVersion(
      {
        cards: runtime.cards,
        clock: { now: () => "2026-08-24T00:00:00.000Z" },
        ids: { nextId: () => `event_backup_${String(sequence)}` },
      },
      row.card_id,
      row.version_id,
      { decidedBy: "backup-integration" },
    );
  }
}

function publicationIdOf(result: PublishMarkdownSourceResult): string {
  const publicationId = result.publication?.publicationId;
  if (publicationId === undefined) throw new Error("nothing was published");
  return publicationId;
}

async function deleteCollection(collectionName: string): Promise<void> {
  const endpoint = new URL(requiredQdrantUrl());
  if (!endpoint.pathname.endsWith("/")) endpoint.pathname += "/";
  const url = new URL(`collections/${encodeURIComponent(collectionName)}`, endpoint);
  const response = await fetch(url, {
    method: "DELETE",
    ...(process.env.CONTEXTCTL_QDRANT_API_KEY === undefined
      ? {}
      : { headers: { "api-key": process.env.CONTEXTCTL_QDRANT_API_KEY } }),
  });
  if (!response.ok) {
    throw new Error(`failed to delete integration collection: ${String(response.status)}`);
  }
  await response.body?.cancel();
}

function requiredQdrantUrl(): string {
  if (qdrantUrl === undefined) throw new Error("CONTEXTCTL_QDRANT_URL is required");
  return qdrantUrl;
}
