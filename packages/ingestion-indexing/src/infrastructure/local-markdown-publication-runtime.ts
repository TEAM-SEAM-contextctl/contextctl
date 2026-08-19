import { EmbeddingPipeline, type EmbeddingPipelinePolicy } from "../application/embed-managed-chunks.js";
import {
  FailedIndexStagingCleanup,
  type FailedIndexStagingCleanupPolicy,
} from "../application/cleanup-failed-index-staging.js";
import { ManagedDocumentSearch } from "../application/managed-document-search.js";
import { MarkdownCapture } from "../application/markdown-capture.js";
import { MarkdownPublicationWorkflow } from "../application/markdown-publication-workflow.js";
import { PublicationReadyReconciler } from "../application/reconcile-publication-ready.js";
import { DocumentIndexPublisher } from "../application/publish-document-index.js";
import { IncrementalDocumentReindexer } from "../application/reindex-document-incrementally.js";
import { SourceManagement } from "../application/source-management.js";
import {
  SourceObservationRetention,
  type SourceObservationRetentionPolicy,
} from "../application/retain-source-observations.js";
import type { BlockIdSource } from "../domain/document-capture.js";
import {
  isDocumentRetrievalEmbeddingProfile,
  type EmbeddingProfile,
} from "../domain/embedding-profile.js";
import { stableIdentity } from "../domain/revision-identity.js";
import type { EmbeddingPort } from "../ports/embedding.js";
import type { PublicationReadyNotifier } from "../ports/markdown-publication.js";
import type {
  IngestionPublicationStore,
  MarkdownPublicationCheckpointStore,
} from "../ports/markdown-publication.js";
import type { IndexPublicationStore } from "../ports/index-publication-store.js";
import type { IndexStagingAttemptStore } from "../ports/index-staging-attempt.js";
import type { SourceObservationStore } from "../ports/source-observation.js";
import type {
  CredentialResolver,
  SourceConfigurationResolver,
  SourceIdGenerator,
} from "../ports/source-adapter.js";
import type { VectorIndexPort } from "../ports/vector-index.js";
import { InMemoryIndexPublicationStore } from "./in-memory-index-publication-store.js";
import { InMemoryIndexStagingAttemptStore } from "./in-memory-index-staging-attempt-store.js";
import { InMemoryIngestionPublicationStore } from "./in-memory-ingestion-publication-store.js";
import { InMemoryMarkdownPublicationCheckpointStore } from "./in-memory-markdown-publication-checkpoint-store.js";
import { InMemoryMarkdownPublicationEventSink } from "./in-memory-markdown-publication-event-sink.js";
import { InMemoryPublicationReadyNotifier } from "./in-memory-publication-ready-notifier.js";
import { InMemorySourceObservationStore } from "./in-memory-source-observation-store.js";
import { InMemoryVectorIndexAdapter } from "./in-memory-vector-index-adapter.js";
import { MarkdownFileSourceAdapter } from "./markdown-file-source-adapter.js";
import { RemarkMarkdownParser } from "./remark-markdown-parser.js";
import { SourceAdapterRegistry } from "./source-adapter-registry.js";
import {
  StaticQueryEmbeddingProviderRegistry,
  StaticVectorIndexConnectorRegistry,
} from "./static-managed-search-registries.js";
import { assertProductionEmbeddingProvider } from "./transformers-js-local-embedding-adapter.js";

export interface LocalMarkdownPublicationRuntimeOptions {
  readonly configurations: Readonly<Record<string, unknown>>;
  readonly credentials?: Readonly<Record<string, unknown>>;
  readonly embeddingProfile: EmbeddingProfile;
  readonly connectorId: string;
  readonly stateNamespaceId: string;
  readonly securityDomain: string;
  /** Explicit provider bound to the exact document and query profile. */
  readonly embeddingProvider: EmbeddingPort;
  readonly vectorIndex?: VectorIndexPort;
  readonly readyNotifier?: PublicationReadyNotifier;
  readonly checkpoints?: MarkdownPublicationCheckpointStore;
  readonly publications?: IngestionPublicationStore;
  readonly observations?: SourceObservationStore;
  readonly indexPublications?: IndexPublicationStore;
  /** Required with a supplied durable Index Catalog. */
  readonly stagingAttempts?: IndexStagingAttemptStore;
  readonly stagingCleanupPolicy?: FailedIndexStagingCleanupPolicy;
  readonly observationRetentionPolicy?: SourceObservationRetentionPolicy;
  readonly observationRetentionLeaseMs?: number;
  readonly embeddingPolicy?: EmbeddingPipelinePolicy;
  readonly defaultSourceTimeoutMs?: number;
  readonly sourceIds?: SourceIdGenerator;
  readonly clock?: () => string;
}

export interface LocalMarkdownPublicationRuntime {
  readonly workflow: MarkdownPublicationWorkflow;
  readonly search: ManagedDocumentSearch;
  readonly checkpoints: MarkdownPublicationCheckpointStore;
  readonly publications: IngestionPublicationStore;
  readonly observations: SourceObservationStore;
  readonly observationRetention: SourceObservationRetention;
  readonly readyNotifier: PublicationReadyNotifier;
  readonly readyNotifications: InMemoryPublicationReadyNotifier | undefined;
  readonly readyReconciler: PublicationReadyReconciler;
  readonly events: InMemoryMarkdownPublicationEventSink;
  readonly indexPublications: IndexPublicationStore;
  readonly stagingAttempts: IndexStagingAttemptStore;
  readonly stagingCleanup: FailedIndexStagingCleanup;
  readonly vectorIndex: VectorIndexPort;
}

/**
 * Network-free composition that defaults to in-memory adapters and accepts
 * durable adapter instances from a production composition root.
 */
export function createLocalMarkdownPublicationRuntime(
  options: LocalMarkdownPublicationRuntimeOptions,
): LocalMarkdownPublicationRuntime {
  if (options.embeddingProvider === undefined) {
    throw new TypeError("an explicit embedding provider is required");
  }
  if (isDocumentRetrievalEmbeddingProfile(options.embeddingProfile)) {
    assertProductionEmbeddingProvider(
      options.embeddingProfile,
      options.embeddingProvider,
    );
  }
  if (
    options.indexPublications !== undefined &&
    options.stagingAttempts === undefined
  ) {
    throw new TypeError(
      "a supplied Index Catalog requires a shared staging attempt store",
    );
  }
  const clock = options.clock ?? (() => new Date().toISOString());
  const configurations = new LocalValueResolver(options.configurations);
  const credentials = new LocalValueResolver(options.credentials ?? {});
  const observations =
    options.observations ?? new InMemorySourceObservationStore();
  const sourceManagement = new SourceManagement({
    adapters: new SourceAdapterRegistry([
      new MarkdownFileSourceAdapter({ now: () => new Date(clock()) }),
    ]),
    configurations,
    credentials,
    ids: options.sourceIds ?? new SequentialSourceIdGenerator(),
    observations,
    defaultTimeoutMs: options.defaultSourceTimeoutMs ?? 30_000,
    clock,
  });
  const embeddingProvider = options.embeddingProvider;
  const vectorIndex = options.vectorIndex ?? new InMemoryVectorIndexAdapter();
  const checkpoints =
    options.checkpoints ?? new InMemoryMarkdownPublicationCheckpointStore();
  const publications =
    options.publications ?? new InMemoryIngestionPublicationStore();
  const readyNotifications =
    options.readyNotifier === undefined
      ? new InMemoryPublicationReadyNotifier()
      : undefined;
  const readyNotifier = options.readyNotifier ?? readyNotifications!;
  const events = new InMemoryMarkdownPublicationEventSink();
  const indexPublications =
    options.indexPublications ?? new InMemoryIndexPublicationStore();
  const stagingAttempts =
    options.stagingAttempts ?? new InMemoryIndexStagingAttemptStore();
  const vectorIndexes = new StaticVectorIndexConnectorRegistry([
    { connectorId: options.connectorId, vectorIndex },
  ]);
  const parser = new RemarkMarkdownParser();
  const embeddingPipeline = new EmbeddingPipeline({
    provider: embeddingProvider,
    ...(options.embeddingPolicy === undefined
      ? {}
      : { policy: options.embeddingPolicy }),
  });
  const indexPublisher = new DocumentIndexPublisher({
    vectorIndex,
    publications: indexPublications,
    stagingAttempts,
    clock,
  });
  const workflow = new MarkdownPublicationWorkflow({
    sourceManagement,
    observations,
    checkpoints,
    captureMarkdown: (command) =>
      new MarkdownCapture({
        parser,
        ids: new StableBlockIdSource(command.observationId),
      }).capture(command),
    documentReindexer: new IncrementalDocumentReindexer({
      vectorIndex,
      publications: indexPublications,
      embeddingPipeline,
      indexPublisher,
    }),
    publications,
    events,
    embeddingProfile: options.embeddingProfile,
    stateNamespaceId: options.stateNamespaceId,
    securityDomain: options.securityDomain,
    clock,
    ...(options.observationRetentionLeaseMs === undefined
      ? {}
      : {
          observationRetentionLeaseMs: options.observationRetentionLeaseMs,
        }),
  });
  return {
    workflow,
    search: new ManagedDocumentSearch({
      embeddingProviders: new StaticQueryEmbeddingProviderRegistry([
        {
          securityDomain: options.securityDomain,
          embeddingProfile: options.embeddingProfile,
          providerId: `local.${options.securityDomain}.${options.embeddingProfile.id}`,
          provider: embeddingProvider,
        },
      ]),
      vectorIndexes,
      publications: indexPublications,
    }),
    checkpoints,
    publications,
    observations,
    observationRetention: new SourceObservationRetention({
      observations,
      ...(options.observationRetentionPolicy === undefined
        ? {}
        : { policy: options.observationRetentionPolicy }),
      clock,
    }),
    readyNotifier,
    readyNotifications,
    readyReconciler: new PublicationReadyReconciler({
      publications,
      notifier: readyNotifier,
      clock,
    }),
    events,
    indexPublications,
    stagingAttempts,
    stagingCleanup: new FailedIndexStagingCleanup({
      attempts: stagingAttempts,
      publications: indexPublications,
      vectorIndexes,
      ...(options.stagingCleanupPolicy === undefined
        ? {}
        : { policy: options.stagingCleanupPolicy }),
      clock,
    }),
    vectorIndex,
  };
}

class LocalValueResolver
  implements SourceConfigurationResolver, CredentialResolver
{
  constructor(private readonly values: Readonly<Record<string, unknown>>) {}

  async resolve(reference: string, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    if (!Object.hasOwn(this.values, reference)) {
      throw new Error("local reference is unavailable");
    }
    return structuredClone(this.values[reference]);
  }
}

class SequentialSourceIdGenerator implements SourceIdGenerator {
  #next = 1;

  nextSourceId(): string {
    return `src_local${String(this.#next++)}`;
  }
}

class StableBlockIdSource implements BlockIdSource {
  #next = 0;

  constructor(private readonly observationId: string) {}

  nextBlockId(): string {
    return stableIdentity("blk", {
      observationId: this.observationId,
      ordinal: this.#next++,
    });
  }
}
