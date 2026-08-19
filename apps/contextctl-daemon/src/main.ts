import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import {
  assertProductionEmbeddingProvider,
  createLocalMarkdownPublicationRuntime,
  DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
  DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST_SHA256,
  DeterministicEmbeddingAdapter,
  EmbeddingProviderFault,
  InMemoryIndexPublicationStoreV2,
  InMemoryIndexStagingAttemptStore,
  InMemoryIngestionPublicationStore,
  InMemoryVectorIndexAdapter,
  isDocumentRetrievalEmbeddingProfile,
  ManagedDocumentSearch,
  StaticQueryEmbeddingProviderRegistry,
  StaticVectorIndexConnectorRegistry,
  TEXT_MEASURE_PROFILE_VERSION,
  TransformersJsLocalEmbeddingAdapter,
  type EmbeddingPort,
  type EmbeddingProfile,
  type IndexPublicationStoreV2,
  type IndexStagingAttemptStore,
  type IngestionPublicationStore,
  type LocalMarkdownPublicationRuntime,
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
  type CardMeaningGenerator,
  type Clock,
  type IdGenerator,
} from "@contextctl/registry-lifecycle";
import {
  assertCardEmbeddingProviderKind,
  createDeliveryHttpServer,
  createHttpQueryHandler,
  createMcpQueryServer,
  DEFAULT_CARD_ADMISSION_LIMITS,
  DeterministicCardEmbeddingAdapter,
  InMemoryCardCandidateIndexStore,
  isCardSelectionEmbeddingProfile,
  runStdioServer,
  type ApprovedCardCatalog,
  type CardCandidateIndexStore,
  type CardEmbeddingPort,
  type CardSelectionEmbeddingProfile,
  type CardSelectionProfile,
  type DeliveryHttpHandler,
  type McpQueryServer,
  type ResolveContextApplication,
} from "@contextctl/selection-delivery";

import { DaemonContextApplication } from "./context-application.js";
import { IngestionPublicationRepository } from "./adapters/ingestion-publication-repository.js";
import { LocalCardEmbeddingAdapter } from "./adapters/local-card-embedding-adapter.js";
import { RegistryApprovedCardCatalog } from "./adapters/registry-approved-card-catalog.js";
import { RegistryIntake } from "./registry-intake.js";

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

/**
 * The Card vector family a production deployment selects under.
 *
 * It names the same repository, the same revision, the same file and the same
 * digest as `DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE`, and that is
 * deliberate: document retrieval moved to fp32, and making an operator install a
 * second 390MB model whose only difference is quantization would buy nothing.
 * One artifact on disk, one loaded session, two profiles.
 *
 * The ids differ, and that is what keeps them two families rather than one. A
 * Card vector and a document chunk vector are built from different text, rebuilt
 * on different events and held in different indexes; sharing an id would make
 * "same weights" read as "same vector space", and a Card would become
 * comparable against a document index by accident.
 */
export const CARD_SELECTION_EMBEDDING_PROFILE: CardSelectionEmbeddingProfile =
  Object.freeze({
    id: "card-granite-97m-multilingual-r2-fp32-v1",
    version: "1",
    model: "ibm-granite/granite-embedding-97m-multilingual-r2",
    modelRevision: "835ad14087e140460703cf0fae09f97d469d65c2",
    execution: Object.freeze({
      kind: "local",
      adapter: "transformers-js-onnx",
      adapterVersion: "4.2.0",
      artifactRepository:
        "onnx-community/granite-embedding-97m-multilingual-r2-ONNX",
      artifactRevision: "536a9f241cb3f02a9c5995a1e708c784bd274859",
      artifactPath: "onnx/model.onnx",
      artifactSha256:
        "68e592b160673d30250824c1116bc6ab33f70efb22b97c9e1d7ce1e69c1c9d70",
      assetManifestSha256: DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST_SHA256,
      precision: "fp32",
    }),
    dimensions: 384,
    pooling: "cls",
    normalization: "l2",
    distance: "cosine",
    selectionTextSchemaVersion: 2,
    cardInputTransformVersion: "card-selection-text-v2",
    queryInputTransformVersion: "card-selection-text-v2",
    admissionLimits: DEFAULT_CARD_ADMISSION_LIMITS,
  });

/**
 * The Card vector family a network-free composition selects under.
 *
 * It carries no `execution` block, which is what makes it a legal profile for a
 * provider that loads nothing: a profile that pinned an artifact while a hash
 * adapter produced the vectors would state a provenance that is simply false.
 * Eight dimensions rather than 384 for the same reason `DEFAULT_EMBEDDING_PROFILE`
 * is eight — nothing in a hash vector needs the width.
 */
export const DETERMINISTIC_CARD_SELECTION_PROFILE: CardSelectionProfile =
  Object.freeze({
    id: "card-deterministic-local-v1",
    version: "1",
    model: "deterministic-local-v1",
    dimensions: 8,
    distance: "cosine",
    normalization: "l2",
    selectionTextSchemaVersion: 2,
    admissionLimits: DEFAULT_CARD_ADMISSION_LIMITS,
  });

/** The connector name the published document index is expected to carry. */
export const DEFAULT_CONNECTOR_ID = "vector.local";

/** The isolation key searches are made under. See `DaemonContextApplication`. */
export const DEFAULT_SECURITY_DOMAIN = "local";

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
  readonly indexPublications: IndexPublicationStoreV2;
  readonly stagingAttempts: IndexStagingAttemptStore;
}

export interface DaemonRuntimeOptions {
  /**
   * Where Registry's SQLite database lives. Defaults to `":memory:"`, which
   * makes an unconfigured daemon start with an empty catalog rather than
   * pick a directory on the operator's behalf.
   */
  readonly registryDatabaseLocation?: string;
  readonly securityDomain?: string;
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
   * Defaulted to the network-free in-memory adapter, which is what makes an
   * unconfigured composition assemble at all. It is also why a composition that
   * outlives one process has to state this: the in-memory adapter's records die
   * with the process, so a runtime that published in one process and searched in
   * another would answer every query with an empty, *successful* result. The
   * caller that knows it spans processes is the caller that binds a durable one.
   */
  readonly vectorIndex?: VectorIndexPort;
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
   * The state namespace published index manifests are stamped with. Matched
   * exactly like the three above; it names which logical deployment's state a
   * physical index belongs to.
   */
  readonly stateNamespaceId?: string;
  /** Wall clock for Registry's audit trail. Overridden to pin timestamps. */
  readonly clock?: () => string;
}

/** The state namespace a local, single-deployment composition publishes under. */
export const DEFAULT_STATE_NAMESPACE_ID = "state_local";

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
  readonly publications: IndexPublicationStoreV2;
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
  readonly securityDomain: string;
  readonly connectorId: string;
  readonly embeddingProfile: EmbeddingProfile;
  readonly stateNamespaceId: string;
}

/**
 * Builds the daemon's object graph without starting anything.
 *
 * Everything it assembles runs without external infrastructure: SQLite is
 * in-process, and the vector index, the publication catalog and the embedding
 * provider are the network-free adapters Ingestion ships for exactly this.
 * A durable composition swaps those three and changes nothing else.
 */
export function createDaemonRuntime(
  options: DaemonRuntimeOptions = {},
): DaemonRuntime {
  const securityDomain = options.securityDomain ?? DEFAULT_SECURITY_DOMAIN;
  const connectorId = options.connectorId ?? DEFAULT_CONNECTOR_ID;
  const embeddingProfile =
    options.embeddingProfile ?? DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE;
  // Matches the naming `createLocalMarkdownPublicationRuntime` uses, so a
  // publish path composed from that helper registers the same provider identity
  // instead of a second one that only differs in its label.
  const embeddingProviderId =
    options.embeddingProviderId ??
    `local.${securityDomain}.${embeddingProfile.id}`;

  const stateNamespaceId =
    options.stateNamespaceId ?? DEFAULT_STATE_NAMESPACE_ID;
  const now = options.clock ?? (() => new Date().toISOString());
  const clock: Clock = { now };
  const ids: IdGenerator = new RandomIdGenerator();

  const database = openRegistryDatabase(
    options.registryDatabaseLocation ?? ":memory:",
  );
  const cards = new SqliteCardStore(database);

  const embeddingProvider = resolveEmbeddingProvider(options, embeddingProfile);
  const vectorIndex = options.vectorIndex ?? new InMemoryVectorIndexAdapter();
  const vectorIndexes = new StaticVectorIndexConnectorRegistry([
    { connectorId, vectorIndex },
  ]);
  // Destructured rather than read field by field below, so the five either all
  // come from the caller or all come from the defaults. Reading them
  // individually would let a future edit default one of them and rebuild the
  // exact inconsistency `DaemonIngestionStores` exists to make unrepresentable.
  const stores = options.ingestionStores;
  const publications = stores?.indexPublications ?? new InMemoryIndexPublicationStoreV2();
  const stagingAttempts = stores?.stagingAttempts ?? new InMemoryIndexStagingAttemptStore();
  const ingestionPublications = stores?.publications ?? new InMemoryIngestionPublicationStore();
  const search = new ManagedDocumentSearch({
    embeddingProviders: new StaticQueryEmbeddingProviderRegistry([
      {
        securityDomain,
        embeddingProfile,
        providerId: embeddingProviderId,
        provider: embeddingProvider,
      },
    ]),
    vectorIndexes,
    publications,
  });

  const cardSelectionProfile =
    options.cardSelectionProfile ??
    (isDocumentRetrievalEmbeddingProfile(embeddingProfile)
      ? CARD_SELECTION_EMBEDDING_PROFILE
      : DETERMINISTIC_CARD_SELECTION_PROFILE);
  const cardEmbeddingProvider = resolveCardEmbeddingProvider(
    options,
    cardSelectionProfile,
    embeddingProvider,
    embeddingProfile,
  );
  // One store per runtime, so the index survives between requests and is
  // rebuilt only when the catalog snapshot it was prepared for changes. A store
  // per request would re-embed the whole catalog on every query.
  const cardCandidateIndex = new InMemoryCardCandidateIndexStore();

  const catalog = new RegistryApprovedCardCatalog(cards);
  const contextApplication = new DaemonContextApplication({
    catalog,
    search,
    securityDomain,
    semantic: {
      embedding: cardEmbeddingProvider,
      index: cardCandidateIndex,
      profile: cardSelectionProfile,
    },
  });

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
    embeddingProvider,
    vectorIndex,
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

  const registryIntake = new RegistryIntake({
    publications: new IngestionPublicationRepository(ingestionPublications),
    checkpoints: new SqliteConsumerCheckpointStore(database, now),
    meanings: options.meanings ?? new DeterministicCardMeaningGenerator(),
    cards,
    clock,
    ids,
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
    securityDomain,
    connectorId,
    embeddingProfile,
    stateNamespaceId,
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
 * Binds the one embedding provider the graph may use.
 *
 * A production profile declares how its vectors were made, so the provider has
 * to match that declaration: the deterministic adapter reports `test` and is
 * rejected outright. Nothing here falls back — an unusable production profile
 * ends the assembly rather than quietly producing vectors of another kind.
 */
function resolveEmbeddingProvider(
  options: DaemonRuntimeOptions,
  profile: EmbeddingProfile,
): EmbeddingPort {
  if (!isDocumentRetrievalEmbeddingProfile(profile)) {
    // A profile without production execution semantics describes no artifact
    // to load, so the caller owns the binding.
    if (options.embeddingProvider !== undefined) return options.embeddingProvider;
    return new DeterministicEmbeddingAdapter();
  }
  if (options.embeddingProvider !== undefined) {
    assertProductionEmbeddingProvider(profile, options.embeddingProvider);
    return options.embeddingProvider;
  }
  if (profile.execution.kind !== "local") {
    // Remote execution needs a secret-backed connector binding this
    // composition does not own yet.
    throw new EmbeddingProviderFault("embedding_artifact_unavailable", false);
  }
  if (options.embeddingArtifactDirectory === undefined) {
    throw new EmbeddingProviderFault("embedding_artifact_unavailable", false);
  }
  const provider = new TransformersJsLocalEmbeddingAdapter({
    artifactDirectory: options.embeddingArtifactDirectory,
    profile,
  });
  assertProductionEmbeddingProvider(profile, provider);
  return provider;
}

/**
 * Binds the one Card embedding provider the graph may use.
 *
 * The shape mirrors `resolveEmbeddingProvider` above, and the mirror is the
 * point: a profile that pins an artifact requires a provider that loaded one,
 * and the deterministic adapter reports `test` and is refused. Nothing falls
 * back.
 *
 * The production branch hands the *document* provider to the wrapper rather than
 * constructing a second local adapter. The two profiles name one artifact
 * digest, one precision and one pooling, so a second adapter would load a second
 * copy of identical weights and answer identically — see
 * `LocalCardEmbeddingAdapter`, where the reasoning and its limits are stated.
 */
function resolveCardEmbeddingProvider(
  options: DaemonRuntimeOptions,
  cardProfile: CardSelectionProfile,
  sessionProvider: EmbeddingPort,
  sessionProfile: EmbeddingProfile,
): CardEmbeddingPort {
  if (!isCardSelectionEmbeddingProfile(cardProfile)) {
    // A profile without production execution semantics describes no artifact to
    // load, so the caller owns the binding.
    if (options.cardEmbeddingProvider !== undefined) {
      return options.cardEmbeddingProvider;
    }
    return new DeterministicCardEmbeddingAdapter();
  }
  if (options.cardEmbeddingProvider !== undefined) {
    assertCardEmbeddingProviderKind(
      cardProfile,
      options.cardEmbeddingProvider,
      cardProfile.execution.kind,
    );
    return options.cardEmbeddingProvider;
  }
  if (cardProfile.execution.kind !== "local") {
    // Remote execution needs a secret-backed connector binding this composition
    // does not own yet.
    throw new EmbeddingProviderFault("embedding_artifact_unavailable", false);
  }
  const provider = new LocalCardEmbeddingAdapter({
    provider: sessionProvider,
    session: sessionProfile,
    card: cardProfile,
  });
  assertCardEmbeddingProviderKind(cardProfile, provider, "local");
  return provider;
}

/** Reads the runtime's configuration out of the environment. */
export function readDaemonRuntimeOptions(
  environment: Readonly<Partial<Record<string, string>>>,
): DaemonRuntimeOptions {
  // Built by assignment rather than as one literal: `exactOptionalPropertyTypes`
  // makes `{ key: undefined }` different from an absent key, and an absent key
  // is what selects the default.
  const options: {
    registryDatabaseLocation?: string;
    securityDomain?: string;
    connectorId?: string;
    stateNamespaceId?: string;
    embeddingArtifactDirectory?: string;
  } = {};
  const location = environment.CONTEXTCTL_REGISTRY_DATABASE;
  if (location !== undefined) {
    options.registryDatabaseLocation = location;
  }
  const securityDomain = environment.CONTEXTCTL_SECURITY_DOMAIN;
  if (securityDomain !== undefined) {
    options.securityDomain = securityDomain;
  }
  const connectorId = environment.CONTEXTCTL_CONNECTOR_ID;
  if (connectorId !== undefined) {
    options.connectorId = connectorId;
  }
  const stateNamespaceId = environment.CONTEXTCTL_STATE_NAMESPACE_ID;
  if (stateNamespaceId !== undefined) {
    options.stateNamespaceId = stateNamespaceId;
  }
  const artifactDirectory = environment.CONTEXTCTL_EMBEDDING_ASSET_DIRECTORY;
  if (artifactDirectory !== undefined) {
    options.embeddingArtifactDirectory = artifactDirectory;
  }
  return options;
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
  const httpPort = readHttpPort(environment);
  if (httpPort !== undefined) {
    createDeliveryHttpServer(runtime.httpHandler).listen(httpPort);
  }
  await runStdioServer(runtime.mcpServer, process.stdin, process.stdout);
}

/** Whether this module was executed, as opposed to imported. */
function isProcessEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isProcessEntryPoint()) {
  await runDaemon();
}
