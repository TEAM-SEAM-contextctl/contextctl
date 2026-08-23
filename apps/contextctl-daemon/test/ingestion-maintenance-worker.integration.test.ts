import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  openIngestionDatabase,
  QdrantVectorIndexAdapter,
  SqliteIndexPublicationStore,
  SqliteIndexStagingAttemptStore,
  SqliteIngestionPublicationStore,
  SqliteMarkdownPublicationCheckpointStore,
  SqliteSourceObservationStore,
  type PublishMarkdownSourceResult,
} from "@contextctl/ingestion-indexing";

import {
  createDaemonRuntime,
  DEFAULT_EMBEDDING_PROFILE,
  type DaemonIngestionStores,
  type DaemonRuntime,
} from "../src/main.js";
import { ManualRuntimeClock } from "../src/runtime/clock.js";

const qdrantUrl = process.env.CONTEXTCTL_QDRANT_URL;
const integration = qdrantUrl === undefined ? describe.skip : describe;
const TEST_TIMEOUT_MS = 30_000;
const SOURCE_REFERENCE = "source.maintenance.integration";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

integration("daemon Ingestion maintenance integration", () => {
  it("delivers once and restores SQLite plus Qdrant state after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "contextctl-maintenance-"));
    directories.push(directory);
    const markdownPath = join(directory, "operations.md");
    const ingestionPath = join(directory, "ingestion.db");
    const registryPath = join(directory, "registry.db");
    await writeFile(
      markdownPath,
      "# 운영 안내\n\n## 결제 재시도\n\n결제 실패는 세 번까지 재시도합니다.\n",
      "utf8",
    );

    const suffix = `${String(Date.now())}-${process.pid}`;
    const stateNamespaceId = `maintenance-${suffix}`;
    const securityDomain = `maintenance-${suffix}`;
    const firstClock = new ManualRuntimeClock();
    const firstDatabase = openIngestionDatabase({
      location: ingestionPath,
      stateNamespaceId,
      securityDomain,
    });
    const first = createRuntime({
      ingestionDatabase: firstDatabase,
      registryPath,
      markdownPath,
      stateNamespaceId,
      securityDomain,
      clock: firstClock,
    });

    let published: PublishMarkdownSourceResult;
    try {
      published = await publish(first);
      first.ingestionMaintenanceWorker.start();
      firstClock.advance(0);
      await waitForCycle(first);

      await expect(
        first.registryIntake.claim(publicationIdOf(published)),
      ).resolves.toMatchObject({ status: "already_claimed" });
      const firstHits = await first.search.search({
        queryText: "결제 재시도",
        securityDomain,
        scopeRef: firstManagedScopeRef(published),
        limit: 8,
      });
      expect(firstHits.some((hit) => hit.text.includes("세 번"))).toBe(true);
    } finally {
      await first.ingestionMaintenanceWorker.stop();
      first.database.close();
      firstDatabase.close();
    }

    const secondClock = new ManualRuntimeClock(1_000);
    const secondDatabase = openIngestionDatabase({
      location: ingestionPath,
      stateNamespaceId,
      securityDomain,
    });
    const second = createRuntime({
      ingestionDatabase: secondDatabase,
      registryPath,
      markdownPath,
      stateNamespaceId,
      securityDomain,
      clock: secondClock,
    });
    try {
      second.ingestionMaintenanceWorker.start();
      secondClock.advance(0);
      await waitForCycle(second);

      await expect(
        second.registryIntake.claim(publicationIdOf(published)),
      ).resolves.toMatchObject({ status: "already_claimed" });
      const restoredHits = await second.search.search({
        queryText: "결제 재시도",
        securityDomain,
        scopeRef: firstManagedScopeRef(published),
        limit: 8,
      });
      expect(restoredHits.some((hit) => hit.text.includes("세 번"))).toBe(true);
      expect(second.ingestionMaintenanceWorker.status).toMatchObject({
        cycles: 1,
        lastOutcome: "completed",
      });
    } finally {
      await second.ingestionMaintenanceWorker.stop();
      second.database.close();
      secondDatabase.close();
    }
  }, TEST_TIMEOUT_MS);
});

function createRuntime(input: {
  readonly ingestionDatabase: ReturnType<typeof openIngestionDatabase>;
  readonly registryPath: string;
  readonly markdownPath: string;
  readonly stateNamespaceId: string;
  readonly securityDomain: string;
  readonly clock: ManualRuntimeClock;
}): DaemonRuntime {
  const stores: DaemonIngestionStores = {
    observations: new SqliteSourceObservationStore(input.ingestionDatabase),
    checkpoints: new SqliteMarkdownPublicationCheckpointStore(
      input.ingestionDatabase,
    ),
    publications: new SqliteIngestionPublicationStore(input.ingestionDatabase),
    indexPublications: new SqliteIndexPublicationStore(input.ingestionDatabase),
    stagingAttempts: new SqliteIndexStagingAttemptStore(input.ingestionDatabase),
  };
  return createDaemonRuntime({
    registryDatabaseLocation: input.registryPath,
    stateIdentity: {
      stateNamespaceId: input.stateNamespaceId,
      securityDomain: input.securityDomain,
    },
    embeddingProfile: DEFAULT_EMBEDDING_PROFILE,
    vectorIndex: new QdrantVectorIndexAdapter({ url: requiredQdrantUrl() }),
    sourceConfigurations: {
      [SOURCE_REFERENCE]: { path: input.markdownPath },
    },
    ingestionStores: stores,
    runtimeClock: input.clock,
  });
}

async function publish(runtime: DaemonRuntime): Promise<PublishMarkdownSourceResult> {
  return await runtime.ingestion.workflow.publish({
    source: {
      sourceType: "markdown",
      displayName: "Maintenance integration",
      configReference: SOURCE_REFERENCE,
      polling: { enabled: false },
    },
    connectorId: runtime.connectorId,
    securityDomain: runtime.securityDomain,
  });
}

async function waitForCycle(runtime: DaemonRuntime): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (runtime.ingestionMaintenanceWorker.status.cycles > 0) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("maintenance cycle did not settle");
}

function publicationIdOf(result: PublishMarkdownSourceResult): string {
  const publicationId = result.publication?.publicationId;
  if (publicationId === undefined) throw new Error("nothing was published");
  return publicationId;
}

function firstManagedScopeRef(
  result: PublishMarkdownSourceResult,
): { readonly scopeId: string; readonly scopeVersion: string } {
  for (const unit of result.publication?.knowledgeUnits ?? []) {
    for (const scope of unit.publishedScopes) {
      // A Publication carries document, section and segment Scopes. Selecting
      // the first managed Scope made this assertion depend on UUID ordering:
      // sometimes it named only the title unit and could never contain the
      // retry sentence. The restart check needs the aggregate document Scope.
      if (
        scope.kind === "managed_document" &&
        scope.selector.kind === "document"
      ) {
        return { scopeId: scope.scopeId, scopeVersion: scope.scopeVersion };
      }
    }
  }
  throw new Error("Publication has no managed document Scope");
}

function requiredQdrantUrl(): string {
  if (qdrantUrl === undefined) throw new Error("Qdrant URL is required");
  return qdrantUrl;
}
