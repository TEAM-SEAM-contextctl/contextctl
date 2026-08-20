import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type PublicationReady,
  parseIngestionPublication,
  type IngestionPublication,
} from "@contextctl/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  DeterministicEmbeddingAdapter,
  InMemoryVectorIndexAdapter,
  InMemoryMarkdownPublicationCheckpointStore,
  PublicationReadyReconciler,
  createLocalMarkdownPublicationRuntime,
  type EmbeddingPort,
  type EmbeddingProviderRequest,
  type MarkdownPublicationCheckpoint,
  type MarkdownPublicationCheckpointStore,
  type PublicationReadyNotifier,
  type PublishMarkdownSourceCommand,
} from "../src/index.js";

const STRUCTURE_FIXTURE = fileURLToPath(
  new URL("./fixtures/markdown/structure.md", import.meta.url),
);
const UNSUPPORTED_FIXTURE = fileURLToPath(
  new URL("./fixtures/markdown/unsupported.md", import.meta.url),
);
const NOW = "2026-08-13T06:00:00.000Z";
const temporaryDirectories: string[] = [];
const profile = {
  id: "markdown-vertical-slice",
  version: "1.0.0",
  model: "deterministic-markdown-v1",
  dimensions: 8,
  distance: "cosine" as const,
  maxInputTokens: 480,
  textMeasureProfileVersion: "unicode-estimate-v1",
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("MarkdownPublicationWorkflow", () => {
  it("requires the vector index at the composition boundary", () => {
    expect(() =>
      createLocalMarkdownPublicationRuntime({
        configurations: {},
        embeddingProfile: profile,
        embeddingProvider: new DeterministicEmbeddingAdapter(),
        connectorId: "vector.local",
        stateNamespaceId: "state_test",
        securityDomain: "tenant-a",
      } as unknown as Parameters<typeof createLocalMarkdownPublicationRuntime>[0]),
    ).toThrow("an explicit vector index is required");
  });

  it("runs a real Markdown Source through ready Publication and managed search", async () => {
    const embeddings = new RecordingEmbeddingPort();
    const runtime = createLocalMarkdownPublicationRuntime({
      configurations: {
        "source.fixture": { path: STRUCTURE_FIXTURE },
      },
      embeddingProfile: profile,
      connectorId: "vector.local",
      stateNamespaceId: "state_test",
      securityDomain: "tenant-a",
      embeddingProvider: embeddings,
      vectorIndex: new InMemoryVectorIndexAdapter(),
      clock: () => NOW,
    });

    const result = await runtime.workflow.publish(command());

    expect(result.status).toBe("published");
    expect(result.publication).toBeDefined();
    const publication = requiredPublication(result.publication);
    await expect(runtime.readyReconciler.reconcile()).resolves.toEqual([
      { publicationId: publication.publicationId, status: "delivered" },
    ]);
    expect(runtime.readyNotifications?.notifications).toEqual([
      { schemaVersion: 1, publicationId: publication.publicationId },
    ]);
    expect(
      await runtime.publications.find(publication.publicationId),
    ).toEqual(publication);
    await expect(runtime.readyReconciler.reconcile()).resolves.toEqual([]);
    expect(
      await runtime.observations.find(result.observationId!),
    ).toMatchObject({
      id: result.observationId,
      sourceId: result.sourceId,
    });
    expect(
      await runtime.observations.comparisonForSource(result.sourceId),
    ).toMatchObject({ id: result.observationId });
    expect(
      await runtime.checkpoints.findBySourceId(result.sourceId),
    ).toMatchObject({ observationId: result.observationId });

    const registryView = consumeAsRegistry(
      parseIngestionPublication(
        JSON.parse(JSON.stringify(publication)) as unknown,
      ),
    );
    expect(registryView.length).toBeGreaterThan(1);
    expect(registryView.every((unit) => unit.scopeRefs.length === 1)).toBe(true);
    expect(JSON.stringify(registryView)).not.toMatch(
      /chunk|embedding|collection|credential|vector/i,
    );

    const retryUnit = publication.knowledgeUnits.find((unit) =>
      unit.facts.some(
        (fact) => fact.name === "section.label" && fact.value === "재시도",
      ),
    );
    expect(retryUnit).toBeDefined();
    const scope = retryUnit?.publishedScopes[0];
    expect(scope?.kind).toBe("managed_document");
    if (scope === undefined || scope.kind !== "managed_document") {
      throw new Error("managed fixture Scope is missing");
    }
    const hits = await runtime.search.search({
      queryText: "결제 재시도 절차",
      securityDomain: "tenant-a",
      scopeRef: { scopeId: scope.scopeId, scopeVersion: scope.scopeVersion },
      limit: 5,
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.semanticUnitId === retryUnit?.id)).toBe(true);
    expect(hits.some((hit) => hit.text.includes("재시도"))).toBe(true);
    expect(JSON.stringify(hits)).not.toMatch(
      /accessHandle|collection|credential|filter|score|vector|vendor/i,
    );

    expect(result.diagnostics.map(({ stage, status }) => [stage, status])).toEqual([
      ["registration", "completed"],
      ["inspection", "completed"],
      ["observation", "completed"],
      ["capture", "completed"],
      ["segmentation", "completed"],
      ["chunking", "completed"],
      ["index_update", "completed"],
      ["ingestion_publication", "completed"],
    ]);
    expect(runtime.events.events.every((event) => event.operationId !== "")).toBe(
      true,
    );
    expect(JSON.stringify(runtime.events.events)).not.toContain(
      "운영 문서는 결제 실패를 다룹니다.",
    );

    // A Registry fixture consumer has no acknowledgement/purge power over the
    // Ingestion store; the immutable Publication remains fetchable.
    expect(registryView).not.toEqual([]);
    expect(
      await runtime.publications.find(publication.publicationId),
    ).toEqual(publication);
  });

  it("stops an identical rerun before capture, embedding, and a new version", async () => {
    const embeddings = new RecordingEmbeddingPort();
    const runtime = createLocalMarkdownPublicationRuntime({
      configurations: {
        "source.fixture": { path: STRUCTURE_FIXTURE },
      },
      embeddingProfile: profile,
      connectorId: "vector.local",
      stateNamespaceId: "state_test",
      securityDomain: "tenant-a",
      embeddingProvider: embeddings,
      vectorIndex: new InMemoryVectorIndexAdapter(),
      clock: () => NOW,
    });
    const first = await runtime.workflow.publish(command());
    await runtime.readyReconciler.reconcile();
    const embeddingCallsAfterFirst = embeddings.requests.length;

    const repeated = await runtime.workflow.publish(command());

    expect(repeated).toMatchObject({
      status: "unchanged",
      sourceId: first.sourceId,
      observationId: first.observationId,
      indexVersion: first.indexVersion,
      publication: { publicationId: first.publication?.publicationId },
    });
    expect(embeddings.requests).toHaveLength(embeddingCallsAfterFirst);
    expect(runtime.readyNotifications?.notifications).toHaveLength(1);
    await expect(runtime.readyReconciler.reconcile()).resolves.toEqual([]);
    expect(
      repeated.diagnostics
        .filter((diagnostic) => diagnostic.status === "skipped")
        .map((diagnostic) => diagnostic.stage),
    ).toEqual([
      "capture",
      "segmentation",
      "chunking",
      "index_update",
      "ingestion_publication",
    ]);
    const documentScope = first.publication?.knowledgeUnits
      .flatMap((unit) => unit.publishedScopes)
      .find(
        (scope) =>
          scope.kind === "managed_document" &&
          scope.selector.kind === "document",
      );
    if (documentScope === undefined || documentScope.kind !== "managed_document") {
      throw new Error("document Scope is missing");
    }
    const current = await runtime.indexPublications.current(
      documentScope.documentIndex.documentIndexId,
    );
    expect(current?.manifest.indexVersion).toBe(first.indexVersion);
  });

  it("re-embeds only affected chunks and preserves unchanged published Scopes", async () => {
    const fixture = await createTemporaryMarkdown(`
# 운영 안내

공통 운영 원칙입니다.

## 결제

결제 실패는 한 번 재시도합니다.

## 배송

배송 조회는 운송장 번호를 사용합니다.
`);
    const embeddings = new RecordingEmbeddingPort();
    const runtime = createLocalMarkdownPublicationRuntime({
      configurations: { "source.fixture": { path: fixture.path } },
      embeddingProfile: profile,
      connectorId: "vector.local",
      stateNamespaceId: "state_test",
      securityDomain: "tenant-a",
      embeddingProvider: embeddings,
      vectorIndex: new InMemoryVectorIndexAdapter(),
      clock: () => NOW,
    });

    const first = await runtime.workflow.publish(command());
    const firstRequestCount = embeddings.requests.length;
    await writeFile(
      fixture.path,
      `
# 운영 안내

공통 운영 원칙입니다.

## 결제

결제 실패는 최대 세 번 재시도합니다.

## 배송

배송 조회는 운송장 번호를 사용합니다.
`,
      "utf8",
    );

    const second = await runtime.workflow.publish(command());
    const checkpoint = await runtime.checkpoints.findBySourceId(first.sourceId);
    const incrementalRequests = embeddings.requests.slice(firstRequestCount);
    const embeddedInputCount = incrementalRequests.reduce(
      (count, request) => count + request.inputs.length,
      0,
    );
    const firstPublication = requiredPublication(first.publication);
    const secondPublication = requiredPublication(second.publication);
    const firstDelivery = unitWithLabel(firstPublication, "배송");
    const secondDelivery = unitWithLabel(secondPublication, "배송");
    const firstPayment = unitWithLabel(firstPublication, "결제");
    const secondPayment = unitWithLabel(secondPublication, "결제");

    expect(second.status).toBe("published");
    expect(checkpoint?.indexingSnapshot).toBeDefined();
    expect(embeddedInputCount).toBeGreaterThan(0);
    expect(embeddedInputCount).toBeLessThan(
      checkpoint?.indexingSnapshot?.chunks.length ?? 0,
    );
    expect(secondDelivery).toEqual(firstDelivery);
    expect(secondPayment.publishedScopes).not.toEqual(
      firstPayment.publishedScopes,
    );
    expect(
      second.diagnostics.find((diagnostic) => diagnostic.stage === "index_update"),
    ).toMatchObject({ status: "completed" });
  });

  it("repairs a comparison pointer from the durable checkpoint before observing again", async () => {
    const fixture = await createTemporaryMarkdown("# First\n\nInitial snapshot.\n");
    const runtime = createLocalMarkdownPublicationRuntime({
      configurations: { "source.fixture": { path: fixture.path } },
      embeddingProfile: profile,
      embeddingProvider: new DeterministicEmbeddingAdapter(),
      vectorIndex: new InMemoryVectorIndexAdapter(),
      connectorId: "vector.local",
      stateNamespaceId: "state_test",
      securityDomain: "tenant-a",
      clock: () => NOW,
    });
    const first = await runtime.workflow.publish(command());
    await writeFile(fixture.path, "# Updated\n\nSecond snapshot.\n", "utf8");
    const second = await runtime.workflow.publish(command());
    await runtime.observations.markComparisonBaseline({
      sourceId: second.sourceId,
      observationId: first.observationId!,
      expectedObservationId: second.observationId!,
    });

    const repeated = await runtime.workflow.publish(command());

    expect(repeated.status).toBe("unchanged");
    await expect(
      runtime.observations.comparisonForSource(second.sourceId),
    ).resolves.toMatchObject({ id: second.observationId });
  });

  it("publishes an empty knowledge set without replacing the last physical Index", async () => {
    const fixture = await createTemporaryMarkdown(`
# 운영 안내

검색 가능한 내용입니다.
`);
    const embeddings = new RecordingEmbeddingPort();
    const runtime = createLocalMarkdownPublicationRuntime({
      configurations: { "source.fixture": { path: fixture.path } },
      embeddingProfile: profile,
      connectorId: "vector.local",
      stateNamespaceId: "state_test",
      securityDomain: "tenant-a",
      embeddingProvider: embeddings,
      vectorIndex: new InMemoryVectorIndexAdapter(),
      clock: () => NOW,
    });

    const first = await runtime.workflow.publish(command());
    const firstPublication = requiredPublication(first.publication);
    const documentIndexId = requiredManagedDocumentIndexId(firstPublication);
    const physicalHead = await runtime.indexPublications.current(documentIndexId);
    const embeddingCalls = embeddings.requests.length;
    await writeFile(fixture.path, "", "utf8");

    const emptied = await runtime.workflow.publish(command());
    const checkpoint = await runtime.checkpoints.findBySourceId(first.sourceId);

    expect(emptied.status).toBe("published");
    expect(emptied.indexVersion).toBeUndefined();
    expect(emptied.publication?.knowledgeUnits).toEqual([]);
    expect(emptied.publication?.changes).toHaveLength(
      firstPublication.knowledgeUnits.length,
    );
    expect(
      emptied.publication?.changes.every((change) => change.kind === "removed"),
    ).toBe(true);
    expect(embeddings.requests).toHaveLength(embeddingCalls);
    expect(await runtime.indexPublications.current(documentIndexId)).toEqual(
      physicalHead,
    );
    expect(checkpoint?.indexingSnapshot?.chunks).toEqual([]);
    expect(
      emptied.diagnostics.find((diagnostic) => diagnostic.stage === "index_update"),
    ).toMatchObject({ status: "skipped", code: "empty_document" });

    const repeated = await runtime.workflow.publish(command());
    expect(repeated.status).toBe("unchanged");
    expect(repeated.publication?.publicationId).toBe(
      emptied.publication?.publicationId,
    );
    expect(repeated.indexVersion).toBeUndefined();
  });

  it("returns a bounded failing-stage diagnostic without logging source text", async () => {
    const runtime = createLocalMarkdownPublicationRuntime({
      configurations: {
        "source.unsupported": { path: UNSUPPORTED_FIXTURE },
      },
      embeddingProfile: profile,
      embeddingProvider: new DeterministicEmbeddingAdapter(),
      vectorIndex: new InMemoryVectorIndexAdapter(),
      connectorId: "vector.local",
      stateNamespaceId: "state_test",
      securityDomain: "tenant-a",
      clock: () => NOW,
    });

    const error = await runtime.workflow
      .publish(command("source.unsupported"))
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "stage_failed",
      stage: "segmentation",
      diagnosticCode: "incomplete_document",
      diagnostics: expect.arrayContaining([
        {
          stage: "segmentation",
          status: "failed",
          code: "incomplete_document",
        },
      ]),
    });
    expect(String(error)).not.toContain("obviously-fake-sensitive-content");
    expect(JSON.stringify(error)).not.toContain(
      "obviously-fake-sensitive-content",
    );
    expect(JSON.stringify(runtime.events.events)).not.toContain(
      "obviously-fake-sensitive-content",
    );
    expect(runtime.readyNotifications?.notifications).toEqual([]);
  });

  it("rejects a security domain that is not bound to the workflow provider", async () => {
    const embeddings = new RecordingEmbeddingPort();
    const runtime = createLocalMarkdownPublicationRuntime({
      configurations: {
        "source.fixture": { path: STRUCTURE_FIXTURE },
      },
      embeddingProfile: profile,
      connectorId: "vector.local",
      stateNamespaceId: "state_test",
      securityDomain: "tenant-a",
      embeddingProvider: embeddings,
      vectorIndex: new InMemoryVectorIndexAdapter(),
      clock: () => NOW,
    });

    await expect(
      runtime.workflow.publish({
        ...command(),
        securityDomain: "tenant-b",
      }),
    ).rejects.toMatchObject({
      code: "invalid_request",
      stage: "registration",
      diagnosticCode: "security_domain_not_allowed",
      diagnostics: [
        {
          stage: "registration",
          status: "failed",
          code: "security_domain_not_allowed",
        },
      ],
    });
    expect(embeddings.requests).toEqual([]);
    expect(runtime.events.events).toEqual([]);
  });

  it("keeps a committed Publication pending and redelivers its ID after notification failure", async () => {
    const notifier = new FailOnceReadyNotifier();
    const runtime = createLocalMarkdownPublicationRuntime({
      configurations: {
        "source.fixture": { path: STRUCTURE_FIXTURE },
      },
      embeddingProfile: profile,
      embeddingProvider: new DeterministicEmbeddingAdapter(),
      vectorIndex: new InMemoryVectorIndexAdapter(),
      connectorId: "vector.local",
      stateNamespaceId: "state_test",
      securityDomain: "tenant-a",
      readyNotifier: notifier,
      clock: () => NOW,
    });

    const published = await runtime.workflow.publish(command());
    expect(published.status).toBe("published");
    await expect(runtime.readyReconciler.reconcile()).resolves.toEqual([
      {
        publicationId: published.publication?.publicationId,
        status: "failed",
        diagnosticCode: "notification_unavailable",
      },
    ]);
    const stored = await runtime.publications.find(
      published.publication!.publicationId,
    );
    expect(stored).toBeDefined();

    const retry = await runtime.workflow.publish(command());

    expect(retry.status).toBe("unchanged");
    expect(notifier.delivered).toEqual([]);
    const retryReconciler = new PublicationReadyReconciler({
      publications: runtime.publications,
      notifier,
      clock: () => "2026-08-13T06:00:01.000Z",
    });
    await expect(retryReconciler.reconcile()).resolves.toEqual([
      {
        publicationId: published.publication?.publicationId,
        status: "delivered",
      },
    ]);
    expect(notifier.delivered).toEqual([
      {
        schemaVersion: 1,
        publicationId: published.publication?.publicationId,
      },
    ]);
    await expect(retryReconciler.reconcile()).resolves.toEqual([]);
    expect(
      await runtime.publications.find(published.publication!.publicationId),
    ).toEqual(stored);
  });

  it("recovers a committed Publication when its final checkpoint write failed", async () => {
    const embeddings = new RecordingEmbeddingPort();
    const checkpoints = new FailOnceFinalCheckpointStore();
    const runtime = createLocalMarkdownPublicationRuntime({
      configurations: {
        "source.fixture": { path: STRUCTURE_FIXTURE },
      },
      embeddingProfile: profile,
      connectorId: "vector.local",
      stateNamespaceId: "state_test",
      securityDomain: "tenant-a",
      embeddingProvider: embeddings,
      vectorIndex: new InMemoryVectorIndexAdapter(),
      checkpoints,
      clock: () => NOW,
    });

    const failed = await runtime.workflow
      .publish(command())
      .catch((caught: unknown) => caught);
    const embeddingCalls = embeddings.requests.length;
    const committed = await runtime.publications.latestForSource(
      checkpoints.sourceId,
    );

    expect(failed).toMatchObject({
      stage: "ingestion_publication",
      diagnosticCode: "checkpoint_unavailable",
    });
    expect(committed).toBeDefined();
    await expect(runtime.observations.count()).resolves.toBe(1);

    const recovered = await runtime.workflow.publish(command());
    const checkpoint = await runtime.checkpoints.findBySourceId(
      checkpoints.sourceId,
    );

    expect(recovered.status).toBe("already_published");
    expect(recovered.publication).toEqual(committed);
    expect(embeddings.requests).toHaveLength(embeddingCalls);
    expect(checkpoint?.indexingSnapshot).toBeDefined();
    expect(checkpoint?.observationId).toBe(recovered.observationId);
    await expect(runtime.observations.count()).resolves.toBe(1);
    await expect(runtime.readyReconciler.reconcile()).resolves.toHaveLength(1);
    await expect(runtime.readyReconciler.reconcile()).resolves.toEqual([]);
  });
});

function command(
  configReference = "source.fixture",
): PublishMarkdownSourceCommand {
  return {
    source: {
      sourceType: "markdown",
      displayName: "Markdown fixture",
      configReference,
      polling: { enabled: false },
    },
    connectorId: "vector.local",
    securityDomain: "tenant-a",
  };
}

function requiredPublication(
  publication: IngestionPublication | undefined,
): IngestionPublication {
  if (publication === undefined) throw new Error("Publication is missing");
  return publication;
}

function unitWithLabel(
  publication: IngestionPublication,
  label: string,
): IngestionPublication["knowledgeUnits"][number] {
  const unit = publication.knowledgeUnits.find((candidate) =>
    candidate.facts.some(
      (fact) => fact.name === "section.label" && fact.value === label,
    ),
  );
  if (unit === undefined) throw new Error(`Knowledge Unit is missing: ${label}`);
  return unit;
}

function requiredManagedDocumentIndexId(
  publication: IngestionPublication,
): string {
  const scope = publication.knowledgeUnits
    .flatMap((unit) => unit.publishedScopes)
    .find((candidate) => candidate.kind === "managed_document");
  if (scope === undefined || scope.kind !== "managed_document") {
    throw new Error("managed document Scope is missing");
  }
  return scope.documentIndex.documentIndexId;
}

async function createTemporaryMarkdown(content: string): Promise<{
  readonly path: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "contextctl-workflow-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "source.md");
  await writeFile(path, content.trimStart(), "utf8");
  return { path };
}

function consumeAsRegistry(publication: IngestionPublication) {
  return publication.knowledgeUnits.map((unit) => ({
    unitId: unit.id,
    scopeRefs: unit.publishedScopes.map((scope) => ({
      scopeId: scope.scopeId,
      scopeVersion: scope.scopeVersion,
    })),
  }));
}

class RecordingEmbeddingPort implements EmbeddingPort {
  readonly requests: EmbeddingProviderRequest[] = [];
  readonly #delegate = new DeterministicEmbeddingAdapter();

  async embed(request: EmbeddingProviderRequest) {
    this.requests.push(request);
    return this.#delegate.embed(request);
  }
}

class FailOnceReadyNotifier implements PublicationReadyNotifier {
  readonly delivered: PublicationReady[] = [];
  #failed = false;

  async notify(notification: PublicationReady): Promise<void> {
    if (!this.#failed) {
      this.#failed = true;
      throw new NotificationUnavailable();
    }
    this.delivered.push(structuredClone(notification));
  }
}

class NotificationUnavailable extends Error {
  readonly code = "notification_unavailable";
}

class FailOnceFinalCheckpointStore
  implements MarkdownPublicationCheckpointStore
{
  readonly #delegate = new InMemoryMarkdownPublicationCheckpointStore();
  #failed = false;
  sourceId = "";

  async register(
    ...args: Parameters<MarkdownPublicationCheckpointStore["register"]>
  ) {
    const result = await this.#delegate.register(...args);
    this.sourceId = result.checkpoint.source.id;
    return result;
  }

  async save(checkpoint: MarkdownPublicationCheckpoint): Promise<void> {
    if (!this.#failed && checkpoint.indexingSnapshot !== undefined) {
      this.#failed = true;
      throw new CheckpointUnavailable();
    }
    await this.#delegate.save(checkpoint);
  }

  findBySourceId(sourceId: string) {
    return this.#delegate.findBySourceId(sourceId);
  }
}

class CheckpointUnavailable extends Error {
  readonly code = "checkpoint_unavailable";
}
