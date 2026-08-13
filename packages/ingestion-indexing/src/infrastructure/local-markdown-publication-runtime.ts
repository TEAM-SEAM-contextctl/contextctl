import { EmbeddingPipeline, type EmbeddingPipelinePolicy } from "../application/embed-managed-chunks.js";
import { ManagedDocumentSearch } from "../application/managed-document-search.js";
import { MarkdownCapture } from "../application/markdown-capture.js";
import { MarkdownPublicationWorkflow } from "../application/markdown-publication-workflow.js";
import { DocumentIndexPublisher } from "../application/publish-document-index.js";
import { SourceManagement } from "../application/source-management.js";
import type { BlockIdSource } from "../domain/document-capture.js";
import type { EmbeddingProfile } from "../domain/embedding-profile.js";
import { stableIdentity } from "../domain/revision-identity.js";
import type { EmbeddingPort } from "../ports/embedding.js";
import type { PublicationReadyNotifier } from "../ports/markdown-publication.js";
import type {
  CredentialResolver,
  SourceConfigurationResolver,
  SourceIdGenerator,
} from "../ports/source-adapter.js";
import type { VectorIndexPort } from "../ports/vector-index.js";
import { DeterministicEmbeddingAdapter } from "./deterministic-embedding-adapter.js";
import { InMemoryIndexPublicationStore } from "./in-memory-index-publication-store.js";
import { InMemoryIngestionPublicationStore } from "./in-memory-ingestion-publication-store.js";
import { InMemoryMarkdownPublicationCheckpointStore } from "./in-memory-markdown-publication-checkpoint-store.js";
import { InMemoryMarkdownPublicationEventSink } from "./in-memory-markdown-publication-event-sink.js";
import { InMemoryPublicationReadyNotifier } from "./in-memory-publication-ready-notifier.js";
import { InMemoryVectorIndexAdapter } from "./in-memory-vector-index-adapter.js";
import { MarkdownFileSourceAdapter } from "./markdown-file-source-adapter.js";
import { RemarkMarkdownParser } from "./remark-markdown-parser.js";
import { SourceAdapterRegistry } from "./source-adapter-registry.js";

export interface LocalMarkdownPublicationRuntimeOptions {
  readonly configurations: Readonly<Record<string, unknown>>;
  readonly credentials?: Readonly<Record<string, unknown>>;
  readonly embeddingProfile: EmbeddingProfile;
  readonly embeddingProvider?: EmbeddingPort;
  readonly vectorIndex?: VectorIndexPort;
  readonly readyNotifier?: PublicationReadyNotifier;
  readonly embeddingPolicy?: EmbeddingPipelinePolicy;
  readonly defaultSourceTimeoutMs?: number;
  readonly clock?: () => string;
}

export interface LocalMarkdownPublicationRuntime {
  readonly workflow: MarkdownPublicationWorkflow;
  readonly search: ManagedDocumentSearch;
  readonly checkpoints: InMemoryMarkdownPublicationCheckpointStore;
  readonly publications: InMemoryIngestionPublicationStore;
  readonly readyNotifications: InMemoryPublicationReadyNotifier;
  readonly events: InMemoryMarkdownPublicationEventSink;
  readonly indexPublications: InMemoryIndexPublicationStore;
  readonly vectorIndex: VectorIndexPort;
}

/**
 * Network-free I5 composition. Production daemon wiring and durable stores are
 * intentionally left to the composition root and the Index hardening issue.
 */
export function createLocalMarkdownPublicationRuntime(
  options: LocalMarkdownPublicationRuntimeOptions,
): LocalMarkdownPublicationRuntime {
  const clock = options.clock ?? (() => new Date().toISOString());
  const configurations = new LocalValueResolver(options.configurations);
  const credentials = new LocalValueResolver(options.credentials ?? {});
  const sourceManagement = new SourceManagement({
    adapters: new SourceAdapterRegistry([
      new MarkdownFileSourceAdapter({ now: () => new Date(clock()) }),
    ]),
    configurations,
    credentials,
    ids: new SequentialSourceIdGenerator(),
    defaultTimeoutMs: options.defaultSourceTimeoutMs ?? 30_000,
  });
  const embeddingProvider =
    options.embeddingProvider ?? new DeterministicEmbeddingAdapter();
  const vectorIndex = options.vectorIndex ?? new InMemoryVectorIndexAdapter();
  const checkpoints = new InMemoryMarkdownPublicationCheckpointStore();
  const publications = new InMemoryIngestionPublicationStore();
  const readyNotifications = new InMemoryPublicationReadyNotifier();
  const events = new InMemoryMarkdownPublicationEventSink();
  const indexPublications = new InMemoryIndexPublicationStore();
  const parser = new RemarkMarkdownParser();
  const embeddingPipeline = new EmbeddingPipeline({
    provider: embeddingProvider,
    ...(options.embeddingPolicy === undefined
      ? {}
      : { policy: options.embeddingPolicy }),
  });
  const workflow = new MarkdownPublicationWorkflow({
    sourceManagement,
    checkpoints,
    captureMarkdown: (command) =>
      new MarkdownCapture({
        parser,
        ids: new StableBlockIdSource(command.observationId),
      }).capture(command),
    embeddingPipeline,
    indexPublisher: new DocumentIndexPublisher({
      vectorIndex,
      publications: indexPublications,
      clock,
    }),
    publications,
    readyNotifier: options.readyNotifier ?? readyNotifications,
    events,
    embeddingProfile: options.embeddingProfile,
    clock,
  });
  return {
    workflow,
    search: new ManagedDocumentSearch({
      embeddings: embeddingProvider,
      vectorIndex,
      publications: indexPublications,
    }),
    checkpoints,
    publications,
    readyNotifications,
    events,
    indexPublications,
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
