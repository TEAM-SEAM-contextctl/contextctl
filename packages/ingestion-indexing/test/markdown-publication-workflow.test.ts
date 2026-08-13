import { fileURLToPath } from "node:url";

import {
  type PublicationReady,
  parseIngestionPublication,
  type IngestionPublication,
} from "@contextctl/contracts";
import { describe, expect, it } from "vitest";

import {
  DeterministicEmbeddingAdapter,
  createLocalMarkdownPublicationRuntime,
  type EmbeddingPort,
  type EmbeddingProviderRequest,
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
const profile = {
  id: "markdown-vertical-slice",
  version: "1.0.0",
  model: "deterministic-markdown-v1",
  dimensions: 8,
  distance: "cosine" as const,
  maxInputTokens: 480,
  textMeasureProfileVersion: "unicode-estimate-v1",
};

describe("MarkdownPublicationWorkflow", () => {
  it("runs a real Markdown Source through ready Publication and managed search", async () => {
    const embeddings = new RecordingEmbeddingPort();
    const runtime = createLocalMarkdownPublicationRuntime({
      configurations: {
        "source.fixture": { path: STRUCTURE_FIXTURE },
      },
      embeddingProfile: profile,
      embeddingProvider: embeddings,
      clock: () => NOW,
    });

    const result = await runtime.workflow.publish(command());

    expect(result.status).toBe("published");
    expect(result.publication).toBeDefined();
    const publication = requiredPublication(result.publication);
    expect(runtime.readyNotifications.notifications).toEqual([
      { schemaVersion: 1, publicationId: publication.publicationId },
    ]);
    expect(
      await runtime.publications.find(publication.publicationId),
    ).toEqual(publication);
    expect(await runtime.publications.pendingReady()).toEqual([]);

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
      unit.evidence.some(
        (fact) => fact.name === "title" && fact.value === "재시도",
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
      scope,
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
      ["embedding", "completed"],
      ["index_publication", "completed"],
      ["ingestion_publication", "completed"],
      ["ready_notification", "completed"],
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
      embeddingProvider: embeddings,
      clock: () => NOW,
    });
    const first = await runtime.workflow.publish(command());
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
    expect(runtime.readyNotifications.notifications).toHaveLength(1);
    expect(await runtime.publications.pendingReady()).toEqual([]);
    expect(
      repeated.diagnostics
        .filter((diagnostic) => diagnostic.status === "skipped")
        .map((diagnostic) => diagnostic.stage),
    ).toEqual([
      "capture",
      "segmentation",
      "chunking",
      "embedding",
      "index_publication",
      "ingestion_publication",
      "ready_notification",
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

  it("returns a bounded failing-stage diagnostic without logging source text", async () => {
    const runtime = createLocalMarkdownPublicationRuntime({
      configurations: {
        "source.unsupported": { path: UNSUPPORTED_FIXTURE },
      },
      embeddingProfile: profile,
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
    expect(runtime.readyNotifications.notifications).toEqual([]);
  });

  it("keeps a committed Publication pending and redelivers its ID after notification failure", async () => {
    const notifier = new FailOnceReadyNotifier();
    const runtime = createLocalMarkdownPublicationRuntime({
      configurations: {
        "source.fixture": { path: STRUCTURE_FIXTURE },
      },
      embeddingProfile: profile,
      readyNotifier: notifier,
      clock: () => NOW,
    });

    const error = await runtime.workflow
      .publish(command())
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "stage_failed",
      stage: "ready_notification",
      diagnosticCode: "notification_unavailable",
    });
    const pending = await runtime.publications.pendingReady();
    expect(pending).toHaveLength(1);
    const stored = await runtime.publications.find(
      pending[0]!.publicationId,
    );
    expect(stored).toBeDefined();

    const retry = await runtime.workflow.publish(command());

    expect(retry.status).toBe("unchanged");
    expect(notifier.delivered).toEqual(pending);
    expect(await runtime.publications.pendingReady()).toEqual([]);
    expect(
      await runtime.publications.find(pending[0]!.publicationId),
    ).toEqual(stored);
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
