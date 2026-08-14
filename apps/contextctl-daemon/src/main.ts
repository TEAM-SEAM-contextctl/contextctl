import type { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import {
  DeterministicEmbeddingAdapter,
  InMemoryIndexPublicationStore,
  InMemoryVectorIndexAdapter,
  ManagedDocumentSearch,
  StaticQueryEmbeddingProviderRegistry,
  StaticVectorIndexConnectorRegistry,
  TEXT_MEASURE_PROFILE_VERSION,
  type EmbeddingPort,
  type EmbeddingProfile,
  type IndexPublicationStore,
  type VectorIndexConnectorResolver,
  type VectorIndexPort,
} from "@contextctl/ingestion-indexing";
import {
  openRegistryDatabase,
  SqliteCardStore,
} from "@contextctl/registry-lifecycle";
import {
  createDeliveryHttpServer,
  createHttpQueryHandler,
  createMcpQueryServer,
  runStdioServer,
  type DeliveryHttpHandler,
  type McpQueryServer,
  type ResolveContextPorts,
} from "@contextctl/selection-delivery";

import { IngestionManagedDocumentRetriever } from "./adapters/ingestion-managed-document-retriever.js";
import { RegistryApprovedCardCatalog } from "./adapters/registry-approved-card-catalog.js";

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

/** The isolation key searches are made under. See the retriever's port docs. */
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
}

/**
 * The assembled graph.
 *
 * The search-side stores are part of the return value on purpose. Nothing is
 * published yet, so every search is empty until an ingest path writes into
 * *these* instances — an in-memory store shared by reference, not by name. If
 * they stayed private, wiring ingest later would mean assembling a second,
 * disconnected set and discovering the disconnection only at demo time.
 */
export interface DaemonRuntime {
  readonly database: DatabaseSync;
  readonly cards: SqliteCardStore;
  readonly selectionPorts: ResolveContextPorts;
  readonly mcpServer: McpQueryServer;
  readonly httpHandler: DeliveryHttpHandler;
  readonly search: ManagedDocumentSearch;
  readonly publications: IndexPublicationStore;
  readonly vectorIndexes: VectorIndexConnectorResolver;
  readonly vectorIndex: VectorIndexPort;
  readonly embeddingProvider: EmbeddingPort;
  readonly securityDomain: string;
  readonly connectorId: string;
  readonly embeddingProfile: EmbeddingProfile;
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
  const embeddingProfile = options.embeddingProfile ?? DEFAULT_EMBEDDING_PROFILE;
  // Matches the naming `createLocalMarkdownPublicationRuntime` uses, so a
  // publish path composed from that helper registers the same provider identity
  // instead of a second one that only differs in its label.
  const embeddingProviderId =
    options.embeddingProviderId ??
    `local.${securityDomain}.${embeddingProfile.id}`;

  const database = openRegistryDatabase(
    options.registryDatabaseLocation ?? ":memory:",
  );
  const cards = new SqliteCardStore(database);

  const embeddingProvider = new DeterministicEmbeddingAdapter();
  const vectorIndex = new InMemoryVectorIndexAdapter();
  const vectorIndexes = new StaticVectorIndexConnectorRegistry([
    { connectorId, vectorIndex },
  ]);
  const publications = new InMemoryIndexPublicationStore();
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

  const selectionPorts: ResolveContextPorts = {
    catalog: new RegistryApprovedCardCatalog(cards),
    retriever: new IngestionManagedDocumentRetriever({
      search,
      publications,
      securityDomain,
    }),
  };

  return {
    database,
    cards,
    selectionPorts,
    mcpServer: createMcpQueryServer(selectionPorts),
    httpHandler: createHttpQueryHandler(selectionPorts),
    search,
    publications,
    vectorIndexes,
    vectorIndex,
    embeddingProvider,
    securityDomain,
    connectorId,
    embeddingProfile,
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
    registryDatabaseLocation?: string;
    securityDomain?: string;
    connectorId?: string;
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
): Promise<void> {
  const runtime = createDaemonRuntime(readDaemonRuntimeOptions(environment));
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
