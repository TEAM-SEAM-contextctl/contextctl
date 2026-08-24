import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";

import {
  createLocalMarkdownPublicationRuntime,
  DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
  DeterministicEmbeddingAdapter,
  EmbeddingProviderFault,
  InMemoryIndexPublicationStore,
  InMemoryIndexStagingAttemptStore,
  InMemoryIngestionPublicationStore,
  isDocumentRetrievalEmbeddingProfile,
  ManagedDocumentSearch,
  StaticQueryEmbeddingProviderRegistry,
  StaticVectorIndexConnectorRegistry,
  TEXT_MEASURE_PROFILE_VERSION,
  type EmbeddingPort,
  type EmbeddingProfile,
  type IndexPublicationStore,
  type IndexStagingAttemptStore,
  type IngestionPublicationStore,
  type LocalMarkdownPublicationRuntime,
  type LocalDocumentEmbeddingInferenceResource,
  type MarkdownPublicationCheckpointStore,
  type SourceObservationStore,
  type VectorIndexConnectorResolver,
  type VectorIndexPort,
} from "@contextctl/ingestion-indexing";
import {
  DeterministicCardMeaningGenerator,
  openRegistryDatabase,
  SqliteCardStore,
  SqliteConsumerCheckpointStore,
  SqliteIntakeStore,
  type CardMeaningGenerator,
  type Clock,
  type IdGenerator,
} from "@contextctl/registry-lifecycle";
import {
  createDeliveryHttpServer,
  createHttpQueryHandler,
  CARD_SELECTION_EMBEDDING_PROFILE,
  createMcpQueryServer,
  DEFAULT_POLICY_CONTEXT,
  DETERMINISTIC_CARD_SELECTION_PROFILE,
  DeterministicCardEmbeddingAdapter,
  InMemoryCardCandidateIndexStore,
  isCardSelectionEmbeddingProfile,
  runStdioServer,
  type ApprovedCardCatalog,
  type CardCandidateIndexStore,
  type CardEmbeddingPort,
  type CardSelectionProfile,
  type DeliveryHttpHandler,
  type McpQueryServer,
  type PolicyContext,
  type ResolveContextApplication,
} from "@contextctl/selection-delivery";

import {
  readActiveEmbeddingProfiles,
  readEmbeddingCompositionConfiguration,
  type EmbeddingCompositionConfiguration,
} from "./embedding/configuration.js";
import {
  composeCardEmbedding,
  composeDocumentEmbedding,
} from "./embedding/composition.js";
import {
  cardProfileExecutionKind,
  documentProfileExecutionKind,
  IngestionDocumentEmbeddingProviderFactory,
  SelectionCardEmbeddingProviderFactory,
  type CardEmbeddingProviderFactory,
  type DocumentEmbeddingProviderFactory,
} from "./embedding/provider-factory.js";
import {
  cardProfileNeedsLocalAssets,
  documentProfileNeedsLocalAssets,
  type RequiredEmbeddingBindings,
} from "./embedding/required-bindings.js";
import { DaemonContextApplication } from "./context-application.js";
import {
  AdmissionControlledResolve,
  createDeliveryRequestExecution,
  DaemonRuntimeControl,
} from "./runtime/runtime-control.js";
import { LaneBoundCardCandidateIndexStore } from "./runtime/lane-bound-card-candidate-index.js";
import { LaneBoundIngestionEmbedding } from "./runtime/lane-bound-ingestion-embedding.js";
import {
  PreparedApprovedCardCatalog,
  RetainingCardCandidateIndexStore,
} from "./runtime/prepared-card-catalog.js";
import type { RuntimeClock } from "./runtime/clock.js";
import type { DaemonRuntimeProfile } from "./runtime/profile.js";
import {
  ScheduledCardEmbedding,
  ScheduledDocumentEmbedding,
  type EmbeddingRuntimeScheduler,
  type EmbeddingRuntimeSchedulerProfile,
} from "./runtime/embedding-runtime-scheduler.js";
import { IngestionPublicationRepository } from "./adapters/ingestion-publication-repository.js";
import { LocalCardEmbeddingAdapter } from "./adapters/local-card-embedding-adapter.js";
import { RegistryApprovedCardCatalog } from "./adapters/registry-approved-card-catalog.js";
import { RegistryPublicationReadyNotifier } from "./adapters/registry-publication-ready-notifier.js";
import { resolveVectorBackend } from "./vector-backend.js";
import { RegistryIntake } from "./registry-intake.js";
import {
  IngestionMaintenanceWorker,
  type IngestionMaintenanceWorkerPolicy,
} from "./runtime/ingestion-maintenance-worker.js";
import {
  assertDaemonStateIdentity,
  DEFAULT_DAEMON_STATE_IDENTITY,
  readDaemonStateIdentity,
  type DaemonStateIdentity,
} from "./runtime/state-identity.js";
import {
  assertDaemonStateReady,
} from "./runtime/state-readiness.js";

export {
  DaemonStateIdentityConfigurationError,
  DEFAULT_DAEMON_STATE_IDENTITY,
  readDaemonStateIdentity,
  SECURITY_DOMAIN_VARIABLE,
  STATE_NAMESPACE_ID_VARIABLE,
  type DaemonStateIdentity,
} from "./runtime/state-identity.js";
export {
  DaemonStateReadinessError,
  type DaemonStateReadinessErrorCode,
} from "./runtime/state-readiness.js";

export { VectorBackendConfigurationError } from "./vector-backend.js";

/**
 * The Composition Root.
 *
 * Every port a domain declared is bound to an implementation here and nowhere
 * else, and the file is deliberately two halves: `createDaemonRuntime` builds
 * the object graph and returns it, while the process entry point below is the
 * only thing that opens a socket or reads `process`. Importing this module
 * therefore has no effect at all — which matters because `package.json` points
 * `exports["."]` at it, so anything that resolves `@contextctl/daemon` loads
 * this file, and a top-level `runStdioServer` would hang on stdin.
 */

/**
 * The embedding profile the runtime registers a query provider for.
 *
 * A profile is not a preference: `StaticQueryEmbeddingProviderRegistry` keys
 * providers on the exact profile a publication was made under
 * (`static-managed-search-registries.ts:113-118`, no wildcard), so a query can
 * only be embedded if this value equals the published one field for field.
 * Exported so the ingest side, when it is wired, can publish under the same
 * profile rather than restate one that has to match.
 */
export const DEFAULT_EMBEDDING_PROFILE: EmbeddingProfile = {
  id: "contextctl-local",
  version: "1.0.0",
  model: "deterministic-local-v1",
  dimensions: 8,
  distance: "cosine",
  maxInputTokens: 480,
  textMeasureProfileVersion: TEXT_MEASURE_PROFILE_VERSION,
};

/** The connector name the published document index is expected to carry. */
export const DEFAULT_CONNECTOR_ID = "vector.local";

/** Compatibility projection of the default deployment identity. */
export const DEFAULT_SECURITY_DOMAIN =
  DEFAULT_DAEMON_STATE_IDENTITY.securityDomain;

/**
 * Options, all of them optional and all of them explicit.
 *
 * Three of these — `securityDomain`, `connectorId`, `embeddingProfile` — are
 * matched exactly rather than interpreted: search resolves a provider by
 * security domain plus profile and a vector index by connector id, and none of
 * the three has a wildcard. They are therefore configuration by necessity, not
 * by taste, and nothing downstream may infer them.
 */
/**
 * The five stores Ingestion keeps its own state in.
 *
 * Named as one type so a caller cannot supply a subset. Every one of them is
 * read on a path some *other* one writes: an observation decides whether a
 * publish is a no-op, a checkpoint decides whether it runs at all, the outbox is
 * what Registry claims out of, and the catalog is what a query resolves a Scope
 * against. Persisting four of the five produces a composition that is neither
 * durable nor in-memory, and the failure it produces is silence.
 */
export interface DaemonIngestionStores {
  readonly observations: SourceObservationStore;
  readonly checkpoints: MarkdownPublicationCheckpointStore;
  /** Ingestion's Publication outbox, not the index catalog. */
  readonly publications: IngestionPublicationStore;
  /** The index catalog. Near-homonym of the field above; different thing. */
  readonly indexPublications: IndexPublicationStore;
  readonly stagingAttempts: IndexStagingAttemptStore;
}

export interface DaemonRuntimeOptions {
  /**
   * Where Registry's SQLite database lives. Defaults to `":memory:"`, which
   * makes an unconfigured daemon start with an empty catalog rather than
   * pick a directory on the operator's behalf.
   */
  readonly registryDatabaseLocation?: string;
  /** One identity shared by Registry, Ingestion, Index Catalog and Qdrant. */
  readonly stateIdentity?: DaemonStateIdentity;
  readonly connectorId?: string;
  readonly embeddingProfile?: EmbeddingProfile;
  readonly embeddingProviderId?: string;
  /**
   * Where the fixed embedding assets were installed. Required whenever the
   * profile declares local production execution; the runtime never downloads.
   */
  readonly embeddingArtifactDirectory?: string;
  /**
   * An explicit provider. Test compositions pass the deterministic adapter
   * here — it is the only way that adapter reaches the graph, because a
   * production profile refuses any provider whose kind does not match.
   */
  readonly embeddingProvider?: EmbeddingPort;
  /**
   * The Card vector family this deployment selects under.
   *
   * Defaulted from the document profile rather than independently: a
   * composition that asked for network-free document vectors is a composition
   * that cannot load a model, so a Card profile pinning an artifact would refuse
   * to assemble for a reason the caller never stated.
   */
  readonly cardSelectionProfile?: CardSelectionProfile;
  /**
   * An explicit Card embedding provider. Bound like `embeddingProvider` and for
   * the same reason: a production Card profile refuses any provider whose kind
   * does not match, so the deterministic adapter reaches the graph only here.
   */
  readonly cardEmbeddingProvider?: CardEmbeddingPort;
  /**
   * How each embedding layer reaches a provider.
   *
   * Two independent settings, never one. A deployment may send Card text to a
   * hosted provider while document chunks never leave the machine, or the
   * reverse, and all four combinations assemble through the same path. Defaults
   * to local on both, which is what an unconfigured daemon did before this
   * surface existed.
   */
  readonly embedding?: EmbeddingCompositionConfiguration;
  /** Verified physical sessions the composition may inject into domain adapters. */
  readonly localEmbeddingInferenceResources?: readonly LocalDocumentEmbeddingInferenceResource[];
  /**
   * Every provider binding this deployment is still on the hook for.
   *
   * Computed by the caller because it is a read of durable state — approved
   * Cards, and the Scope catalog they point into — and this function is
   * synchronous by contract. Absent means "nothing has been published yet",
   * which is the truth for the in-memory composition the defaults build: there
   * are no older profiles to restore because there are no older indexes.
   */
  readonly requiredEmbeddingBindings?: RequiredEmbeddingBindings;
  /**
   * Who builds the concrete adapters.
   *
   * A seam so the four combinations can be assembled and tested before either
   * domain's remote adapter is final. Production compositions leave these at
   * their defaults, which bind whatever the owning domain has shipped.
   */
  readonly documentEmbeddingFactory?: DocumentEmbeddingProviderFactory;
  readonly cardEmbeddingFactory?: CardEmbeddingProviderFactory;
  /**
   * The Source configuration records the ingest path may resolve, keyed by the
   * `configReference` a publish command names.
   *
   * Ingestion resolves configuration through a port rather than reading files
   * itself, and the local resolver it ships is a fixed record. Empty by default:
   * an unconfigured daemon can serve queries against whatever the Registry
   * database already holds, and refuses to ingest a Source nobody declared
   * rather than inventing a path.
   */
  readonly sourceConfigurations?: Readonly<Record<string, unknown>>;
  /**
   * The physical vector index every published document chunk is written to and
   * every managed search reads from.
   *
   * Required rather than defaulted. Tests may inject the network-free in-memory
   * adapter explicitly, but an operating composition must bind Qdrant before it
   * can create state. Making absence select a test adapter lets one process
   * publish vectors that the next process cannot read while both report success.
   */
  readonly vectorIndex: VectorIndexPort;
  /**
   * Ingestion's own durable state, all five stores together or none of them.
   *
   * One field rather than five for the reason `SemanticSelectionPorts` is one
   * field: a composition that persisted the Publication outbox while leaving the
   * index catalog in memory would claim Publications it can no longer resolve a
   * Scope for. The five are consistent only as a set, so the type says so.
   *
   * `stagingAttempts` travels with `indexPublications` by Ingestion's own
   * contract — `createLocalMarkdownPublicationRuntime` refuses a supplied
   * catalog without it — and grouping them here is what keeps that pairing from
   * being a runtime surprise.
   */
  readonly ingestionStores?: DaemonIngestionStores;
  /**
   * How a Card's expression layer — description, questions, aliases, keywords —
   * is written when Registry claims a Publication.
   *
   * Defaults to the deterministic generator, which needs nothing external and is
   * therefore the only honest default: a composition that reached for a model by
   * default would fail to assemble on a machine with no endpoint configured. A
   * deployment with a model binds `FallbackCardMeaningGenerator` here so an
   * outage degrades the Card text rather than stopping Registry.
   */
  readonly meanings?: CardMeaningGenerator;
  /**
   * What a query may reach, fixed for this process. Defaults to
   * `DEFAULT_POLICY_CONTEXT` — retrieval only, sensitive Cards denied.
   *
   * Handed to `DaemonContextApplication` once, so MCP, HTTP and the query CLI
   * answer under one policy. It is configuration and nothing a request can
   * name: Selection's request type has no field for it, and the CLI reads it
   * through one resolver for every path that composes a runtime.
   */
  readonly policy?: PolicyContext;
  /** Wall clock for Registry's audit trail. Overridden to pin timestamps. */
  readonly clock?: () => string;
  /**
   * The versioned operating limits this process runs under.
   *
   * Defaults to `daemon-runtime-profile-v1`. Supplied whole rather than as
   * loose numbers so the version travels with the values: a measurement taken
   * under adjusted limits has to be able to say which profile produced it.
   */
  readonly runtimeProfile?: DaemonRuntimeProfile;
  /**
   * Limits for one physically shared local inference session.
   *
   * Supplied whole and versioned. Loose queue or RSS variables would make a
   * benchmark unable to identify which policy produced it.
   */
  readonly embeddingSchedulerProfile?: EmbeddingRuntimeSchedulerProfile;
  /**
   * The clock admission and deadlines are measured against.
   *
   * Separate from `clock` above, which stamps Registry's audit trail with wall
   * time. This one measures elapsed milliseconds, and tests substitute it to
   * make queue ordering and stage budgets deterministic.
   */
  readonly runtimeClock?: RuntimeClock;
  /** Versioned cadence for the daemon-owned background Ingestion worker. */
  readonly ingestionMaintenanceWorkerPolicy?: IngestionMaintenanceWorkerPolicy;
}

/** Compatibility projection of the default deployment identity. */
export const DEFAULT_STATE_NAMESPACE_ID =
  DEFAULT_DAEMON_STATE_IDENTITY.stateNamespaceId;

/** Shown when a production profile has no installed assets to read. */
export const EMBEDDING_ASSETS_MISSING_GUIDANCE =
  "Embedding assets are not installed. Install the pinned revision, then set the artifact directory.";

/**
 * The assembled graph.
 *
 * The stores are part of the return value on purpose, and every one of them is
 * shared by reference rather than by name: the ingest path writes into the same
 * catalog, vector index and embedding provider the query path reads, so a
 * document published here is retrievable here. Assembling a second, parallel set
 * is exactly the failure this shape exists to make impossible — it publishes
 * successfully and searches nothing, and nothing fails until a demo.
 */
export interface DaemonRuntime {
  readonly database: DatabaseSync;
  readonly cards: SqliteCardStore;
  /** The approved Card read model both query surfaces select over. */
  readonly catalog: ApprovedCardCatalog;
  /**
   * The one entry point a query surface may call.
   *
   * It is the whole pipeline behind a two-method interface: neither surface
   * receives the catalog or the search, so neither can list a Card a resolution
   * would not have selected, or cause a read outside a plan.
   */
  readonly contextApplication: ResolveContextApplication;
  readonly mcpServer: McpQueryServer;
  readonly httpHandler: DeliveryHttpHandler;
  readonly search: ManagedDocumentSearch;
  readonly publications: IndexPublicationStore;
  /**
   * Required alongside a supplied Index Catalog: the publisher stages a physical
   * index before it commits a catalog record, and the two have to agree on which
   * attempts are outstanding or a failed staging is never cleaned up.
   */
  readonly stagingAttempts: IndexStagingAttemptStore;
  /** Ingestion's own immutable Publication outbox; Registry claims out of it. */
  readonly ingestionPublications: IngestionPublicationStore;
  /** The Markdown ingest path. `workflow.publish` is its entry point. */
  readonly ingestion: LocalMarkdownPublicationRuntime;
  /** Registry's consumption of a Publication. See `registry-intake.ts`. */
  readonly registryIntake: RegistryIntake;
  readonly vectorIndexes: VectorIndexConnectorResolver;
  readonly vectorIndex: VectorIndexPort;
  readonly embeddingProvider: EmbeddingPort;
  /**
   * The Card vector family, its provider, and the index built under it.
   *
   * All three are separate values from the document ones above and none of them
   * is derived from the others at use time: separate profile, separate port,
   * separate index. The one thing that may be shared is the loaded session
   * inside `embeddingProvider`, which `LocalCardEmbeddingAdapter` wraps.
   */
  readonly cardSelectionProfile: CardSelectionProfile;
  readonly cardEmbeddingProvider: CardEmbeddingPort;
  readonly cardCandidateIndex: CardCandidateIndexStore;
  /**
   * Prepares the latest approved-Card snapshot outside a user request budget.
   *
   * `runDaemon` calls this before opening ingress and the one-shot query CLI
   * calls it before starting its 3-second request clock. Repeated calls are
   * cheap because the candidate store is keyed by the snapshot digest.
   */
  prepareCardCandidates(): Promise<void>;
  /** The daemon-owned arbiter for a physically shared local model session. */
  readonly embeddingScheduler: EmbeddingRuntimeScheduler;
  /** Whether the two domain ports in this graph actually use that one session. */
  readonly sharesLocalEmbeddingSession: boolean;
  /** Loads daemon-owned local model workers before any ingress is opened. */
  prepareEmbeddingRuntime(): Promise<void>;
  /** Validates every approved durable Scope binding without creating state. */
  prepareStateReadiness(): Promise<void>;
  /** The one deployment identity injected into every stateful dependency. */
  readonly stateIdentity: DaemonStateIdentity;
  readonly securityDomain: string;
  readonly connectorId: string;
  readonly embeddingProfile: EmbeddingProfile;
  readonly stateNamespaceId: string;
  /**
   * The lanes, the profile and the lifecycle this process runs under.
   *
   * Exposed because operating entry points outside this file admit through it:
   * the CLI runs ingest in the Ingestion lane, Registry intake claims in its
   * own, and shutdown stops every admission boundary. A runtime that hid it
   * would leave those callers to invent their own limits.
   */
  readonly control: DaemonRuntimeControl;
  /** Background scheduling only; maintenance rules remain in Ingestion. */
  readonly ingestionMaintenanceWorker: IngestionMaintenanceWorker;
}

/**
 * Builds the daemon's object graph without starting anything.
 *
 * This function chooses no infrastructure implicitly. Tests may inject
 * network-free adapters, while an operating composition binds Qdrant, durable
 * Ingestion stores and the exact configured embedding providers. In either
 * case construction opens no listener and starts no background timer; the
 * process entry point owns those effects after the graph validates.
 */
export function createDaemonRuntime(
  options: DaemonRuntimeOptions,
): DaemonRuntime {
  const legacyIdentity = options as DaemonRuntimeOptions & {
    readonly securityDomain?: unknown;
    readonly stateNamespaceId?: unknown;
  };
  if (
    "securityDomain" in legacyIdentity ||
    "stateNamespaceId" in legacyIdentity
  ) {
    throw new TypeError(
      "state identity must be supplied as one stateIdentity object",
    );
  }
  if (options.vectorIndex === undefined) {
    throw new TypeError("an explicit vector index is required");
  }
  const stateIdentity = assertDaemonStateIdentity(
    options.stateIdentity ?? DEFAULT_DAEMON_STATE_IDENTITY,
  );
  const { securityDomain, stateNamespaceId } = stateIdentity;
  const connectorId = options.connectorId ?? DEFAULT_CONNECTOR_ID;
  const embeddingProfile =
    options.embeddingProfile ?? DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE;
  const now = options.clock ?? (() => new Date().toISOString());
  const clock: Clock = { now };
  const ids: IdGenerator = new RandomIdGenerator();

  const database = openRegistryDatabase({
    location: options.registryDatabaseLocation ?? ":memory:",
    stateNamespaceId,
    securityDomain,
  });
  const cards = new SqliteCardStore(database);

  const vectorIndex = options.vectorIndex;
  const vectorIndexes = new StaticVectorIndexConnectorRegistry([
    { connectorId, vectorIndex },
  ]);
  // Destructured rather than read field by field below, so the five either all
  // come from the caller or all come from the defaults. Reading them
  // individually would let a future edit default one of them and rebuild the
  // exact inconsistency `DaemonIngestionStores` exists to make unrepresentable.
  const stores = options.ingestionStores;
  const publications = stores?.indexPublications ?? new InMemoryIndexPublicationStore();
  const stagingAttempts = stores?.stagingAttempts ?? new InMemoryIndexStagingAttemptStore();
  const ingestionPublications = stores?.publications ?? new InMemoryIngestionPublicationStore();
  // Chosen before either provider, because both layers are resolved together and
  // neither may be derived from the other's result. The fallback still reads the
  // document profile, and only as a default for a caller that named no Card
  // profile at all: a composition binding a profile with no execution semantics
  // is a test composition, and handing it a profile that pins a 390MB artifact
  // would refuse to assemble for a reason the caller never stated. The
  // configured modes below are independent of it.
  const cardSelectionProfile =
    options.cardSelectionProfile ??
    (isDocumentRetrievalEmbeddingProfile(embeddingProfile)
      ? CARD_SELECTION_EMBEDDING_PROFILE
      : DETERMINISTIC_CARD_SELECTION_PROFILE);

  const embeddingConfiguration =
    options.embedding ?? DEFAULT_EMBEDDING_COMPOSITION_CONFIGURATION;
  const requiredBindings =
    options.requiredEmbeddingBindings ??
    currentProfilesOnly(embeddingProfile, cardSelectionProfile);

  // Two calls, not one. Neither reads the other's configuration or result, which
  // is what makes local/local, local/remote, remote/local and remote/remote the
  // same code path rather than four.
  const ownedDocumentEmbeddingFactory =
    options.documentEmbeddingFactory === undefined
      ? new IngestionDocumentEmbeddingProviderFactory(
          options.localEmbeddingInferenceResources,
        )
      : undefined;
  const documentEmbedding = composeDocumentEmbedding({
    configuration: embeddingConfiguration.document,
    currentProfile: embeddingProfile,
    reachableProfiles: requiredBindings.documentProfiles,
    securityDomain,
    artifactDirectory: options.embeddingArtifactDirectory,
    factory:
      options.documentEmbeddingFactory ?? ownedDocumentEmbeddingFactory!,
    ...(embeddingConfiguration.retainedDocumentBindings === undefined
      ? {}
      : {
          retainedBindings:
            embeddingConfiguration.retainedDocumentBindings,
        }),
    providerOverride: documentProviderOverride(options, embeddingProfile),
  });
  const cardEmbedding = composeCardEmbedding({
    configuration: embeddingConfiguration.card,
    profile: cardSelectionProfile,
    securityDomain,
    artifactDirectory: options.embeddingArtifactDirectory,
    factory:
      options.cardEmbeddingFactory ??
      transitionalCardEmbeddingFactory(
        documentEmbedding.provider,
        embeddingProfile,
      ),
    providerOverride: cardProviderOverride(options, cardSelectionProfile),
  });
  const embeddingProvider = documentEmbedding.provider;
  const rawCardEmbeddingProvider = cardEmbedding.provider;

  const control = new DaemonRuntimeControl({
    ...(options.runtimeProfile === undefined
      ? {}
      : { profile: options.runtimeProfile }),
    ...(options.runtimeClock === undefined
      ? {}
      : { clock: options.runtimeClock }),
    ...(options.embeddingSchedulerProfile === undefined
      ? {}
      : { embeddingSchedulerProfile: options.embeddingSchedulerProfile }),
  });
  if (ownedDocumentEmbeddingFactory !== undefined) {
    control.lifecycle.registerCloseable("local_embedding_workers", async () => {
      await ownedDocumentEmbeddingFactory.close();
    });
  }
  const prepareEmbeddingRuntime = async (): Promise<void> => {
    await ownedDocumentEmbeddingFactory?.ready();
  };
  const sharesLocalEmbeddingSession =
    embeddingConfiguration.document.mode === "local" &&
    embeddingConfiguration.card.mode === "local" &&
    rawCardEmbeddingProvider instanceof LocalCardEmbeddingAdapter &&
    rawCardEmbeddingProvider.usesProvider(embeddingProvider);
  const queryDocumentEmbeddingProvider = sharesLocalEmbeddingSession
    ? new ScheduledDocumentEmbedding(
        embeddingProvider,
        control.embeddingScheduler,
        "resolve",
      )
    : embeddingProvider;
  const ingestionEmbeddingProvider = sharesLocalEmbeddingSession
    ? new ScheduledDocumentEmbedding(
        embeddingProvider,
        control.embeddingScheduler,
        "background",
      )
    : embeddingProvider;
  const cardEmbeddingProvider = sharesLocalEmbeddingSession
    ? new ScheduledCardEmbedding(
        rawCardEmbeddingProvider,
        control.embeddingScheduler,
        "resolve",
      )
    : rawCardEmbeddingProvider;
  const backgroundCardEmbeddingProvider = sharesLocalEmbeddingSession
    ? new ScheduledCardEmbedding(
        rawCardEmbeddingProvider,
        control.embeddingScheduler,
        "background",
      )
    : undefined;

  const search = new ManagedDocumentSearch({
    // Every required profile, not just the current one. A query against an index
    // published under an older profile resolves a provider only if that exact
    // profile is registered, and an approved Card can still name a Scope inside
    // such an index.
    embeddingProviders: new StaticQueryEmbeddingProviderRegistry(
      documentEmbedding.registrations.map((registration) =>
        registration.provider === embeddingProvider
          ? { ...registration, provider: queryDocumentEmbeddingProvider }
          : registration,
      ),
    ),
    vectorIndexes,
    publications,
  });
  // One store per runtime, so the index survives between requests and is
  // rebuilt only when the catalog snapshot it was prepared for changes. A store
  // per request would re-embed the whole catalog on every query.
  const cardCandidateIndex = new InMemoryCardCandidateIndexStore();

  const registryCatalog = new RegistryApprovedCardCatalog(cards);
  const prepareStateReadiness = async (): Promise<void> =>
    await assertDaemonStateReady({
      stateIdentity,
      catalog: registryCatalog,
      publications,
      vectorIndexes,
    });
  const laneBoundCardCandidateIndex = new LaneBoundCardCandidateIndexStore(
    cardCandidateIndex,
    control.selectionAssets,
    backgroundCardEmbeddingProvider,
  );
  // Retention wraps the build boundary, not the other way around. A cache hit
  // for the active generation must not queue behind a newer generation that is
  // occupying the single build lane; only actual builds need that admission.
  const preparedCardCandidateIndex = new RetainingCardCandidateIndexStore(
    laneBoundCardCandidateIndex,
  );
  const catalog = new PreparedApprovedCardCatalog({
    upstream: registryCatalog,
    index: preparedCardCandidateIndex,
    profile: cardSelectionProfile,
    embedding: cardEmbeddingProvider,
  });
  const prepareCardCandidates = async (): Promise<void> => await catalog.refresh();
  const registryIntake = new RegistryIntake(
    {
      publications: new IngestionPublicationRepository(ingestionPublications),
      checkpoints: new SqliteConsumerCheckpointStore(database, now),
      // The Cards, their events and the consumer cursor land in one transaction,
      // so the store that does it is one port rather than two calls in sequence.
      intake: new SqliteIntakeStore(database, now),
      meanings: options.meanings ?? new DeterministicCardMeaningGenerator(),
      cards,
      clock,
      ids,
    },
    { afterCatalogChange: prepareCardCandidates },
  );
  const readyNotifier = new RegistryPublicationReadyNotifier({
    intake: registryIntake,
    lane: control.registryConsume,
  });
  const pipeline = new DaemonContextApplication({
    catalog,
    search,
    securityDomain,
    deadlines: control.profile.deadlines,
    clock: control.clock,
    // The policy every surface this application serves runs under. Stated
    // here even when it is the default, so a reader of this composition sees
    // that sensitive Cards are denied rather than having to know what
    // Selection assumes when nothing is said.
    selection: { policy: options.policy ?? DEFAULT_POLICY_CONTEXT },
    semantic: {
      embedding: cardEmbeddingProvider,
      // Wrapped rather than passed through: the rebuild inside is background
      // work with its own lane, and a Resolve that triggers it must not be the
      // thing that decides how many run at once.
      index: preparedCardCandidateIndex,
      profile: cardSelectionProfile,
    },
  });
  // Every transport receives the controlled surface, never the pipeline. Handing
  // one of them the pipeline directly would give that transport an unmetered
  // path into the same resources the other two are queueing for.
  const contextApplication = new AdmissionControlledResolve(control, pipeline);

  /**
   * The production half of the pipeline.
   *
   * Every store and adapter it could have built for itself is handed in
   * instead, because the defaults are per-call in-memory instances: a runtime
   * that let this helper mint its own catalog would publish into one store and
   * search another. `stagingAttempts` travels with `indexPublications` by
   * contract — the helper refuses a supplied catalog without it.
   *
   * `publications` here is Ingestion's Publication outbox, not the index
   * catalog. The two options are near-homonyms and mean different things; the
   * index catalog is `indexPublications`.
   */
  const ingestion = createLocalMarkdownPublicationRuntime({
    configurations: options.sourceConfigurations ?? {},
    embeddingProfile,
    connectorId,
    stateNamespaceId,
    securityDomain,
    // Publication batches have their own capacity. When one local session is
    // shared, this reference also carries the scheduler's background priority;
    // managed-search queries use the separate Resolve-priority view above.
    embeddingProvider: new LaneBoundIngestionEmbedding(
      ingestionEmbeddingProvider,
      control.ingestionEmbedding,
    ),
    vectorIndex,
    readyNotifier,
    publications: ingestionPublications,
    indexPublications: publications,
    stagingAttempts,
    // Spread rather than assigned: `exactOptionalPropertyTypes` makes an
    // explicit `undefined` different from an absent key, and only the absent key
    // selects Ingestion's own in-memory default.
    ...(stores === undefined
      ? {}
      : { observations: stores.observations, checkpoints: stores.checkpoints }),
    clock: now,
  });
  const ingestionMaintenanceWorker = new IngestionMaintenanceWorker({
    maintenance: ingestion.maintenance,
    lane: control.ingestion,
    clock: control.clock,
    ...(options.ingestionMaintenanceWorkerPolicy === undefined
      ? {}
      : { policy: options.ingestionMaintenanceWorkerPolicy }),
  });

  return {
    database,
    cards,
    catalog,
    contextApplication,
    mcpServer: createMcpQueryServer(contextApplication),
    httpHandler: createHttpQueryHandler(contextApplication),
    search,
    publications,
    stagingAttempts,
    ingestionPublications,
    ingestion,
    registryIntake,
    vectorIndexes,
    vectorIndex,
    embeddingProvider,
    cardSelectionProfile,
    cardEmbeddingProvider,
    cardCandidateIndex,
    prepareCardCandidates,
    embeddingScheduler: control.embeddingScheduler,
    sharesLocalEmbeddingSession,
    prepareEmbeddingRuntime,
    prepareStateReadiness,
    stateIdentity,
    securityDomain,
    connectorId,
    embeddingProfile,
    stateNamespaceId,
    control,
    ingestionMaintenanceWorker,
  };
}

/**
 * Identifiers for Card Versions and lifecycle events.
 *
 * Random rather than sequential because the Registry database outlives the
 * process: a counter restarting at one after a restart would collide with ids
 * already stored, and `appendCardVersion` refuses a duplicate — so the failure
 * would surface as an ingest that stopped working, not as a wrong id.
 */
class RandomIdGenerator implements IdGenerator {
  nextId(): string {
    return `id_${randomUUID().replaceAll("-", "")}`;
  }
}

/**
 * The default both layers take when nothing is configured.
 *
 * Local on each side independently, which reproduces exactly what an
 * unconfigured daemon did before the layers could be chosen apart. It is a
 * default and not a fallback: a layer that asked for remote and could not be
 * bound raises, because the two produce vectors that are not comparable and the
 * operator asked for one of them specifically.
 */
export const DEFAULT_EMBEDDING_COMPOSITION_CONFIGURATION: EmbeddingCompositionConfiguration =
  Object.freeze({
    document: Object.freeze({ mode: "local" as const }),
    card: Object.freeze({ mode: "local" as const }),
  });

/**
 * The binding set of a deployment that has published nothing.
 *
 * Used when the caller supplied none, which is the in-memory composition: with
 * no committed index there is no older profile any approved Card could still
 * reach, so the current two are the whole requirement. A durable composition
 * computes the real set from its stores and passes it in.
 */
function currentProfilesOnly(
  documentProfile: EmbeddingProfile,
  cardProfile: CardSelectionProfile,
): RequiredEmbeddingBindings {
  const documentLocal = documentProfileNeedsLocalAssets(documentProfile);
  const cardLocal = cardProfileNeedsLocalAssets(cardProfile);
  return {
    documentProfiles: [documentProfile],
    cardProfile,
    requirements: [
      {
        layer: "document",
        reason: "current_document_profile",
        profileId: documentProfile.id,
        profileVersion: documentProfile.version,
        needsLocalAssets: documentLocal,
        scopes: [],
      },
      {
        layer: "card",
        reason: "card_candidate_index_profile",
        profileId: cardProfile.id,
        profileVersion: cardProfile.version,
        needsLocalAssets: cardLocal,
        scopes: [],
      },
    ],
    needsLocalAssets: documentLocal || cardLocal,
  };
}

/**
 * The provider a caller supplied, or the one a profile without execution
 * semantics has to use.
 *
 * The deterministic adapter reaches the graph here and nowhere else. That is not
 * a fallback for a failed production binding — a production profile never
 * arrives at this branch, because it declares an execution kind and is bound by
 * a factory. It is the only provider that matches a profile which pins no
 * artifact and names no provider, and without it every test composition would
 * have to supply one by hand.
 */
function documentProviderOverride(
  options: DaemonRuntimeOptions,
  profile: EmbeddingProfile,
): EmbeddingPort | undefined {
  if (options.embeddingProvider !== undefined) return options.embeddingProvider;
  if (documentProfileExecutionKind(profile) === undefined) {
    return new DeterministicEmbeddingAdapter();
  }
  return undefined;
}

/**
 * The Card provider a caller supplied, or the one a profile without execution
 * semantics has to use.
 *
 * Mirrors the document side. The deterministic Card adapter reaches the graph
 * here and nowhere else, and only for a profile that pins no artifact and names
 * no provider — a production profile declares an execution kind and is built by
 * a factory instead.
 */
function cardProviderOverride(
  options: DaemonRuntimeOptions,
  profile: CardSelectionProfile,
): CardEmbeddingPort | undefined {
  if (options.cardEmbeddingProvider !== undefined) {
    return options.cardEmbeddingProvider;
  }
  if (cardProfileExecutionKind(profile) === undefined) {
    // Given its profile so it states it and answers under no other, the way a
    // production adapter does; the network-free composition then binds it by
    // the same rule instead of by kind alone.
    return new DeterministicCardEmbeddingAdapter({ profile });
  }
  return undefined;
}

/**
 * The Card factory this package still has to supply, and is scheduled to stop.
 *
 * Selection owns `CardEmbeddingPort` and will ship providers that implement it
 * directly. Until then the only thing in the repository that can answer a
 * production local Card profile is `LocalCardEmbeddingAdapter`, the translation
 * adapter this package holds, and deleting it before the replacement exists
 * would take local Card selection away rather than move it.
 *
 * Confined to one function on purpose. When Selection's adapters land, this
 * function and the adapter it names are one deletion, and the default becomes
 * `SelectionCardEmbeddingProviderFactory` — which is already the shape the
 * replacement plugs into. Anything a caller injects wins over this, so a
 * composition that has Selection's adapter never reaches it.
 *
 * The remote branch refuses and must not grow a wrapper of its own: reaching the
 * Card family through whatever provider the document family chose is exactly the
 * coupling two independent settings exist to prevent.
 */
function transitionalCardEmbeddingFactory(
  documentProvider: EmbeddingPort,
  documentProfile: EmbeddingProfile,
): CardEmbeddingProviderFactory {
  const selection = new SelectionCardEmbeddingProviderFactory();
  return {
    createLocal: (input) => {
      if (
        isCardSelectionEmbeddingProfile(input.profile) &&
        documentProfileExecutionKind(documentProfile) === "local"
      ) {
        return new LocalCardEmbeddingAdapter({
          provider: documentProvider,
          session: documentProfile,
          card: input.profile,
        });
      }
      return selection.createLocal(input);
    },
    createRemote: (input) => selection.createRemote(input),
  };
}

/** Reads the runtime's configuration out of the environment. */
export function readDaemonRuntimeOptions(
  environment: Readonly<Partial<Record<string, string>>>,
): DaemonRuntimeOptions {
  // Built by assignment rather than as one literal: `exactOptionalPropertyTypes`
  // makes `{ key: undefined }` different from an absent key, and an absent key
  // is what selects the default.
  const options: {
    vectorIndex: VectorIndexPort;
    registryDatabaseLocation?: string;
    stateIdentity: DaemonStateIdentity;
    connectorId?: string;
    embeddingArtifactDirectory?: string;
    embedding?: EmbeddingCompositionConfiguration;
    embeddingProfile?: EmbeddingProfile;
    cardSelectionProfile?: CardSelectionProfile;
  } = {
    vectorIndex: resolveVectorBackend(environment).vectorIndex,
    stateIdentity: readDaemonStateIdentity(environment),
  };
  const location = environment.CONTEXTCTL_REGISTRY_DATABASE;
  if (location !== undefined) {
    options.registryDatabaseLocation = location;
  }
  const connectorId = environment.CONTEXTCTL_CONNECTOR_ID;
  if (connectorId !== undefined) {
    options.connectorId = connectorId;
  }
  const artifactDirectory = environment.CONTEXTCTL_EMBEDDING_ASSET_DIRECTORY;
  if (artifactDirectory !== undefined) {
    options.embeddingArtifactDirectory = artifactDirectory;
  }
  if (hasEmbeddingProviderConfiguration(environment)) {
    const domain = options.stateIdentity.securityDomain;
    const embedding = readEmbeddingCompositionConfiguration(
      environment,
      domain,
    );
    const profiles = readActiveEmbeddingProfiles(environment, embedding);
    options.embedding = embedding;
    options.embeddingProfile = profiles.document;
    options.cardSelectionProfile = profiles.card;
  }
  return options;
}

function hasEmbeddingProviderConfiguration(
  environment: Readonly<Partial<Record<string, string>>>,
): boolean {
  return Object.keys(environment).some(
    (name) =>
      name.startsWith("CONTEXTCTL_DOCUMENT_EMBEDDING_") ||
      name.startsWith("CONTEXTCTL_CARD_EMBEDDING_") ||
      name === "CONTEXTCTL_DOCUMENT_RETAINED_EMBEDDING_BINDINGS",
  );
}

/**
 * The HTTP port, or `undefined` for "do not listen".
 *
 * Absence is the default because the query surface is unauthenticated: opening
 * it has to be something an operator asked for, never something that happens
 * because the daemon booted.
 */
export function readHttpPort(
  environment: Readonly<Partial<Record<string, string>>>,
): number | undefined {
  const raw = environment.CONTEXTCTL_HTTP_PORT;
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError(`CONTEXTCTL_HTTP_PORT is not a port: ${raw}`);
  }
  return port;
}

export interface DaemonHttpBinding {
  readonly host: string;
  readonly port: number;
}

/**
 * Reads the optional unauthenticated HTTP listener configuration.
 *
 * v1 has no HTTP authentication layer, so the only safe binding is a numeric
 * loopback address. Hostnames are intentionally refused: even `localhost` is a
 * name whose resolution is outside this process and therefore not proof of a
 * local trust boundary.
 */
export function readHttpBinding(
  environment: Readonly<Partial<Record<string, string>>>,
): DaemonHttpBinding | undefined {
  const port = readHttpPort(environment);
  const configuredHost = environment.CONTEXTCTL_HTTP_HOST?.trim();
  if (port === undefined) {
    if (configuredHost !== undefined && configuredHost !== "") {
      throw new TypeError(
        "CONTEXTCTL_HTTP_HOST requires CONTEXTCTL_HTTP_PORT",
      );
    }
    return undefined;
  }

  const host = configuredHost === undefined || configuredHost === ""
    ? "127.0.0.1"
    : configuredHost;
  if (!isLoopbackAddress(host)) {
    throw new TypeError(
      "CONTEXTCTL_HTTP_HOST must be a numeric loopback address because v1 HTTP has no authentication",
    );
  }
  return { host, port };
}

function isLoopbackAddress(host: string): boolean {
  if (host === "::1") return true;
  const octets = host.split(".");
  if (octets.length !== 4 || octets[0] !== "127") return false;
  return octets.every(
    (octet) =>
      /^(?:0|[1-9]\d{0,2})$/u.test(octet) && Number(octet) <= 255,
  );
}

/** Opens the validated listener and reports bind failures synchronously. */
export function listenHttpServer(
  server: Server,
  binding: DaemonHttpBinding,
): Promise<void> {
  if (!isLoopbackAddress(binding.host)) {
    throw new TypeError("HTTP server binding must be loopback-only");
  }
  return new Promise<void>((resolve, reject) => {
    const onError = (cause: Error): void => {
      server.removeListener("listening", onListening);
      reject(cause);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    try {
      server.listen(binding.port, binding.host);
    } catch (cause: unknown) {
      server.removeListener("error", onError);
      server.removeListener("listening", onListening);
      reject(cause);
    }
  });
}

/**
 * Starts the daemon: MCP over stdio, and HTTP only when a port was configured.
 *
 * stdio is the surface that is always on, so nothing else may write to stdout —
 * a stray log line lands in the middle of the JSON-RPC stream and desynchronises
 * the peer. Diagnostics go to stderr.
 *
 * Resolves when stdin ends, which is how an MCP client says it is finished.
 */
export async function runDaemon(
  environment: Readonly<Partial<Record<string, string>>> = process.env,
  options?: DaemonRuntimeOptions,
): Promise<void> {
  // Validate the unauthenticated listener before opening databases or loading
  // model assets. A bad trust-boundary setting is a configuration failure, not
  // a partially started daemon that now needs recovery.
  const httpBinding = readHttpBinding(environment);
  let runtime: DaemonRuntime;
  try {
    // The caller's options replace the environment reading rather than merging
    // with it. A merge would need a rule for every field about which source
    // wins, and the one caller that passes options — the CLI — has already
    // applied the environment plus its own file defaults; reading the
    // environment a second time underneath would silently undo them.
    runtime = createDaemonRuntime(options ?? readDaemonRuntimeOptions(environment));
  } catch (error) {
    if (
      error instanceof EmbeddingProviderFault &&
      error.code === "embedding_artifact_unavailable"
    ) {
      process.stderr.write(`${EMBEDDING_ASSETS_MISSING_GUIDANCE}\n`);
    }
    throw error;
  }
  const { lifecycle } = runtime.control;
  runtime.embeddingScheduler.startMonitoring();
  try {
    // A Card index build is background work, but making the first caller pay
    // for a cold Granite build spends that caller's whole 3-second budget.
    // Prepare the current immutable snapshot before either ingress opens. A
    // later catalog change is still rebuilt through the same coalescing store.
    await runtime.prepareStateReadiness();
    await runtime.prepareEmbeddingRuntime();
    await runtime.prepareCardCandidates();
  } catch (error) {
    await runtime.control.lifecycle.shutdown();
    runtime.database.close();
    throw error;
  }
  const deliveryExecution = createDeliveryRequestExecution(runtime.control);
  // Registered from the inside out because shutdown releases in reverse: the
  // HTTP listener stops before the database it would otherwise still be
  // handing requests to.
  lifecycle.registerCloseable("registry_database", () => {
    runtime.database.close();
  });
  lifecycle.registerDrainHook(() => {
    runtime.ingestionMaintenanceWorker.beginDraining();
  });
  lifecycle.registerCloseable("ingestion_maintenance_worker", async () => {
    await runtime.ingestionMaintenanceWorker.stop();
  });

  let stopHttpAccepting: (() => Promise<void>) | undefined;
  if (httpBinding !== undefined) {
    const server = createDeliveryHttpServer(
      runtime.httpHandler,
      deliveryExecution,
    );
    try {
      await listenHttpServer(server, httpBinding);
    } catch (cause: unknown) {
      // Preparation has already opened the embedding scheduler, database and
      // maintenance resources. A bind conflict is therefore a startup failure
      // of the whole daemon, not permission to leave those resources alive.
      lifecycle.beginDraining();
      reportShutdownFailures(await lifecycle.shutdown());
      throw cause;
    }
    let closeStarted: Promise<void> | undefined;
    stopHttpAccepting = () => {
      closeStarted ??= new Promise<void>((resolve, reject) => {
        server.close((cause) =>
          cause === undefined ? resolve() : reject(cause),
        );
      });
      return closeStarted;
    };
    lifecycle.registerCloseable(
      "http_server",
      async () => {
        const stopped = stopHttpAccepting?.() ?? Promise.resolve();
        // Admission has already drained. Connections still reading an
        // incomplete body were never admitted and must not hold shutdown open
        // forever; admitted responses have finished before this point.
        server.closeAllConnections();
        await stopped;
      },
    );
  }

  // The Selection-owned stdio transport resolves only when its input ends.
  // Ending process.stdin is not ours to do, so a small daemon-owned proxy gives
  // a signal handler a closeable MCP ingress without mutating the caller's
  // stream. It also lets the transport finish every message already framed
  // before resources are released.
  const mcpInput = new PassThrough();
  const onStdinError = (cause: Error): void => {
    mcpInput.destroy(cause);
  };
  process.stdin.once("error", onStdinError);
  process.stdin.pipe(mcpInput);

  const onSignal = (): void => {
    // Refusal is immediate and separate from the wait. A daemon that started
    // draining only once the shutdown promise was awaited would keep admitting
    // for as long as it took the handler to get scheduled.
    lifecycle.beginDraining();
    void stopHttpAccepting?.().catch(() => undefined);
    process.stdin.unpipe(mcpInput);
    mcpInput.end();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  runtime.ingestionMaintenanceWorker.start();

  try {
    await runStdioServer(
      runtime.mcpServer,
      mcpInput,
      process.stdout,
      deliveryExecution,
    );
  } finally {
    // stdin ending is an MCP client saying it is finished, which is the same
    // event as a signal from the process's point of view: stop admitting, let
    // admitted work finish, then release. Shared with the handlers above rather
    // than duplicated, so a client that disconnects during a SIGTERM does not
    // start a second shutdown that closes everything twice.
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    process.stdin.removeListener("error", onStdinError);
    process.stdin.unpipe(mcpInput);
    lifecycle.beginDraining();
    void stopHttpAccepting?.().catch(() => undefined);
    reportShutdownFailures(await lifecycle.shutdown());
  }
}

function reportShutdownFailures(
  failures: readonly { readonly resource: string; readonly reason: string }[],
): void {
  for (const failure of failures) {
    process.stderr.write(
      `종료 중 ${failure.resource} 정리에 실패했습니다: ${failure.reason}\n`,
    );
  }
}

/** Whether this module was executed, as opposed to imported. */
function isProcessEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isProcessEntryPoint()) {
  await runDaemon();
}
