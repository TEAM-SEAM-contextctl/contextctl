import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST_SHA256,
  DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
  openIngestionDatabase,
  SqliteIndexPublicationStore,
  SqliteIndexStagingAttemptStore,
  SqliteIngestionPublicationStore,
  SqliteMarkdownPublicationCheckpointStore,
  SqliteSourceObservationStore,
  verifyLocalEmbeddingAssets,
} from "@contextctl/ingestion-indexing";

import {
  openRegistryDatabase,
  SqliteCardStore,
  SqliteLifecycleEventStore,
} from "@contextctl/registry-lifecycle";

import {
  createDaemonRuntime,
  readDaemonStateIdentity,
  type DaemonRuntime,
  type DaemonRuntimeOptions,
  type DaemonStateIdentity,
} from "../main.js";
import { RegistryApprovedCardCatalog } from "../adapters/registry-approved-card-catalog.js";
import {
  readActiveEmbeddingProfiles,
  readEmbeddingCompositionConfiguration,
  assertRequiredDocumentProfileBindings,
  type ActiveEmbeddingProfiles,
  type EmbeddingCompositionConfiguration,
} from "../embedding/configuration.js";
import {
  computeRequiredEmbeddingBindings,
  type RequiredEmbeddingBindings,
} from "../embedding/required-bindings.js";
import {
  resolveActiveAssetDirectory,
} from "./asset-directory.js";
import {
  EmbeddingAssetsUnavailableError,
  verifyRequiredRetainedLocalBindings,
} from "./retained-embedding-assets.js";
import {
  resolveCardMeaningBackend,
  type CardMeaningBackend,
} from "./meaning-generator.js";
import { resolvePolicyContext } from "./policy-context.js";
import { resolveContextctlPaths, type ContextctlPaths } from "./paths.js";
import { readSourcesFile, toSourceConfigurations } from "./sources-file.js";
import { resolveVectorBackend, type VectorBackend } from "../vector-backend.js";

/**
 * The runtime one CLI invocation runs against, plus what an operator has to be
 * told about how it was assembled.
 *
 * Backend diagnostics travel beside the runtime rather than inside it because
 * `DaemonRuntime` already holds the ports it built. The production vector
 * backend is deliberately absent here: CLI composition accepts Qdrant only, so
 * carrying a second discriminant would imply a runtime choice that does not
 * exist.
 */
export interface CliRuntime {
  readonly runtime: DaemonRuntime;
  readonly paths: ContextctlPaths;
  readonly meaningBackend: CardMeaningBackend;
  /** Registered Source references, in the order the file declares them. */
  readonly sourceReferences: readonly string[];
  /** Closes execution workers and both databases. Every command path must call it. */
  close(): Promise<void>;
}

/**
 * Just Registry's database, for the commands that only decide about Cards.
 *
 * The operator decisions and the reachability report read and write Registry's
 * SQLite and nothing else. Routing them through `buildCliRuntime` made them
 * refuse to start without the 415MB embedding artifact installed, which is a
 * dependency none of them has: an operator could not disable a Card that was
 * serving bad content, or find out which Scopes are unreachable, until they had
 * downloaded a model neither command calls.
 *
 * That is also why this returns a narrow shape instead of a partly built
 * `CliRuntime`. A half-populated runtime would type-check at every call site and
 * fail at whichever one first touched the half that was missing.
 */
export interface RegistryOnlyRuntime {
  /** Identity resolved once for every store this command may touch. */
  readonly stateIdentity: DaemonStateIdentity;
  readonly database: DatabaseSync;
  readonly cards: SqliteCardStore;
  /** Human decisions needed to distinguish unreviewed from refused versions. */
  readonly lifecycleEvents: SqliteLifecycleEventStore;
  /**
   * Resolves Ingestion's opaque Source identity back to the operator-facing
   * registration reference. Card Scopes intentionally carry only `sourceId`,
   * so the daemon performs this translation without teaching Registry about
   * Ingestion checkpoints.
   */
  readonly sourceReferenceFor: (sourceId: string) => Promise<string | undefined>;
  /**
   * How far each Source has been published, read from Ingestion's own store.
   *
   * Needed for the processing delay: the reachability report compares what
   * Registry consumed against what Ingestion made ready, and only Ingestion knows
   * the second half. The same lightweight database also resolves a managed
   * document `sourceId` to the registration reference used by `cards list --source`.
   * Opening it costs nothing an operator has to install — it is a
   * second SQLite file, not the embedding artifact — so the commands stay
   * runnable on a machine with no model.
   */
  readonly publications: SqliteIngestionPublicationStore;
  /**
   * Indexing's own Scope catalog, for the status surface.
   *
   * Needed to answer whether a local artifact is still required: an approved
   * Card names a Scope, and only this catalog says which Embedding Profile the
   * index behind that Scope was published under. Without it the question can
   * only be answered from configuration, which describes what an operator wants
   * next rather than what the daemon is still on the hook for.
   */
  readonly indexPublications: SqliteIndexPublicationStore;
  close(): void;
}

export function openRegistryOnlyRuntime(input: {
  readonly environment: Readonly<Partial<Record<string, string>>>;
  readonly workingDirectory?: string;
}): RegistryOnlyRuntime {
  const paths = resolveContextctlPaths(input.environment, input.workingDirectory);
  const stateIdentity = readDaemonStateIdentity(input.environment);
  // The directory is created rather than required. SQLite reports a missing
  // parent as `unable to open database file`, which reads as a corrupt database
  // rather than as a first run, and these commands are reachable before anything
  // else has written to the home directory — `contextctl reachability` on a fresh
  // machine is a legitimate first command. `sources-file.ts` does the same on
  // write for the same reason.
  mkdirSync(dirname(paths.registryDatabase), { recursive: true });
  const database = openRegistryDatabase({
    location: paths.registryDatabase,
    ...stateIdentity,
  });

  // Opened on first use, not up front. Reachability, status and a Source-filtered
  // Card list read Ingestion; a Card decision does not. Eagerly opening the
  // second database made `contextctl cards approve` create an `ingestion.db` it
  // would never read — a file an operator then has to wonder about.
  let ingestionDatabase: DatabaseSync | undefined;
  let publications: SqliteIngestionPublicationStore | undefined;
  let indexPublications: SqliteIndexPublicationStore | undefined;
  let checkpoints: SqliteMarkdownPublicationCheckpointStore | undefined;

  // Both Ingestion-backed stores share one connection, opened by whichever is
  // touched first. Two `openIngestionDatabase` calls against one file would each
  // run the namespace check and the migration, and the second would be doing so
  // against state the first had already moved.
  const openIngestion = (): DatabaseSync => {
    if (ingestionDatabase === undefined) {
      mkdirSync(dirname(paths.ingestionDatabase), { recursive: true });
      ingestionDatabase = openIngestionDatabase({
        location: paths.ingestionDatabase,
        ...stateIdentity,
      });
    }
    return ingestionDatabase;
  };

  return {
    stateIdentity,
    database,
    cards: new SqliteCardStore(database),
    lifecycleEvents: new SqliteLifecycleEventStore(database),
    sourceReferenceFor: async (sourceId) => {
      checkpoints ??= new SqliteMarkdownPublicationCheckpointStore(
        openIngestion(),
      );
      return (await checkpoints.findBySourceId(sourceId))?.source.configReference;
    },
    get publications(): SqliteIngestionPublicationStore {
      if (publications === undefined) {
        publications = new SqliteIngestionPublicationStore(openIngestion());
      }
      return publications;
    },
    get indexPublications(): SqliteIndexPublicationStore {
      if (indexPublications === undefined) {
        indexPublications = new SqliteIndexPublicationStore(openIngestion());
      }
      return indexPublications;
    },
    close: () => {
      ingestionDatabase?.close();
      database.close();
    },
  };
}

export interface BuildCliRuntimeInput {
  readonly environment: Readonly<Partial<Record<string, string>>>;
  /** Where notices and warnings go. Never stdout — see `cli/main.ts`. */
  readonly diagnostics: (message: string) => void;
  readonly workingDirectory?: string;
}

/**
 * Assembles the runtime a command runs against, from durable state only.
 *
 * Every stateful dependency here is durable. Ingestion ships no durable vector
 * adapter other than Qdrant, so resolving it is the first composition step. A
 * missing endpoint therefore fails before any database opens; it can never
 * leave a checkpoint that says an index was published when no durable vectors
 * survived the process.
 *
 * The embedding profile is deliberately not stated. Omitting it selects
 * `DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE`, the pinned granite artifact,
 * and with it the production Card vector family — which is what makes `hybrid`
 * selection real rather than a deterministic stand-in. The cost is that the
 * assets must be installed; `createDaemonRuntime` refuses to assemble otherwise,
 * and `cli/main.ts` translates that refusal into an install instruction.
 */
export async function buildCliRuntime(
  input: BuildCliRuntimeInput,
): Promise<CliRuntime> {
  const paths = resolveContextctlPaths(input.environment, input.workingDirectory);
  const stateIdentity = readDaemonStateIdentity(input.environment);
  const vectorBackend = resolveVectorBackend(input.environment);
  const meaningBackend = resolveCardMeaningBackend({
    environment: input.environment,
    onFallback: input.diagnostics,
  });
  for (const notice of meaningBackend.notices) {
    input.diagnostics(notice);
  }

  const sources = await readSourcesFile(paths.sourcesFile);
  const sourceConfigurations = toSourceConfigurations(sources);

  await preflightActiveEmbeddingConfiguration(
    input.environment,
    paths,
    stateIdentity,
  );

  // Opened before `createDaemonRuntime` so that a schema failure — an ingestion
  // database written under a different security domain, say — is reported as
  // itself rather than as a runtime that would not assemble.
  const ingestionDatabase = openIngestionDatabase({
    location: paths.ingestionDatabase,
    ...stateIdentity,
  });

  let embeddingRuntime: ResolvedCliEmbeddingRuntime;
  try {
    embeddingRuntime = await resolveCliEmbeddingRuntime({
      environment: input.environment,
      paths,
      ingestionDatabase,
      stateIdentity,
    });
  } catch (error) {
    ingestionDatabase.close();
    throw error;
  }

  let runtime: DaemonRuntime;
  try {
    runtime = createDaemonRuntime(
      cliRuntimeOptions({
        environment: input.environment,
        paths,
        sourceConfigurations,
        ingestionDatabase,
        vectorBackend,
        meaningBackend,
        embeddingRuntime,
        stateIdentity,
      }),
    );
  } catch (error) {
    // The Registry database is opened inside `createDaemonRuntime`, so on this
    // path only the Ingestion one is ours to close. Leaking it would hold a WAL
    // lock that the operator's next attempt, after installing assets, would
    // then have to wait on.
    ingestionDatabase.close();
    throw error;
  }

  try {
    await runtime.prepareEmbeddingRuntime();
  } catch (error) {
    await runtime.control.lifecycle.shutdown();
    runtime.database.close();
    ingestionDatabase.close();
    throw error;
  }

  return {
    runtime,
    paths,
    meaningBackend,
    sourceReferences: Object.keys(sources.sources),
    async close(): Promise<void> {
      await runtime.control.lifecycle.shutdown();
      runtime.database.close();
      ingestionDatabase.close();
    },
  };
}

/**
 * The options a CLI composition passes, as one value a test can inspect.
 *
 * Separated from the function above so the wiring decision — which stores are
 * durable, which profile is selected — is assertable without opening a database
 * or installing 390MB of weights.
 */
export function cliRuntimeOptions(input: {
  /**
   * Read here for the access policy, and only for that. The other settings
   * arrive already resolved because each has a failure the caller answers
   * specially; the policy has one resolver and one answer, and resolving it
   * inside this function is what makes `query` and `serve` — the two callers —
   * unable to read it differently.
   */
  readonly environment: Readonly<Partial<Record<string, string>>>;
  readonly paths: ContextctlPaths;
  readonly sourceConfigurations: Readonly<Record<string, { readonly path: string }>>;
  readonly ingestionDatabase: DatabaseSync;
  readonly vectorBackend: VectorBackend;
  readonly meaningBackend: CardMeaningBackend;
  /**
   * The revision directory, never the managed root.
   *
   * `paths.embeddingAssetDirectory` is the root that holds `active.json` and a
   * `revisions/` tree; the adapter wants the immutable folder that directly
   * contains the manifest. Passing the root is what made `doctor` and the
   * runtime disagree, so this is taken as an argument — already resolved —
   * rather than derived from `paths` a second time here.
   */
  readonly embeddingRuntime: ResolvedCliEmbeddingRuntime;
  /** Already resolved; this function must not read identity from the environment. */
  readonly stateIdentity: DaemonStateIdentity;
}): DaemonRuntimeOptions {
  const { ingestionDatabase } = input;
  return {
    registryDatabaseLocation: input.paths.registryDatabase,
    stateIdentity: input.stateIdentity,
    embedding: input.embeddingRuntime.configuration,
    embeddingProfile: input.embeddingRuntime.profiles.document,
    cardSelectionProfile: input.embeddingRuntime.profiles.card,
    requiredEmbeddingBindings: input.embeddingRuntime.requiredBindings,
    ...(input.embeddingRuntime.artifactDirectory === undefined
      ? {}
      : {
          embeddingArtifactDirectory:
            input.embeddingRuntime.artifactDirectory,
        }),
    sourceConfigurations: input.sourceConfigurations,
    vectorIndex: input.vectorBackend.vectorIndex,
    meanings: input.meaningBackend.generator,
    policy: resolvePolicyContext(input.environment),
    ingestionStores: {
      observations: new SqliteSourceObservationStore(ingestionDatabase),
      checkpoints: new SqliteMarkdownPublicationCheckpointStore(ingestionDatabase),
      publications: new SqliteIngestionPublicationStore(ingestionDatabase),
      indexPublications: new SqliteIndexPublicationStore(ingestionDatabase),
      stagingAttempts: new SqliteIndexStagingAttemptStore(ingestionDatabase),
    },
  };
}

export interface ResolvedCliEmbeddingRuntime {
  readonly configuration: EmbeddingCompositionConfiguration;
  readonly profiles: ActiveEmbeddingProfiles;
  readonly requiredBindings: RequiredEmbeddingBindings;
  readonly artifactDirectory?: string;
}

/** Refuses active configuration errors before either state database is opened. */
export async function preflightActiveEmbeddingConfiguration(
  environment: Readonly<Partial<Record<string, string>>>,
  paths: ContextctlPaths,
  stateIdentity: DaemonStateIdentity,
): Promise<void> {
  const configuration = readEmbeddingCompositionConfiguration(
    environment,
    stateIdentity.securityDomain,
  );
  readActiveEmbeddingProfiles(environment, configuration);
  if (
    configuration.document.mode === "remote" &&
    configuration.card.mode === "remote"
  ) {
    return;
  }
  const assets = await resolveActiveAssetDirectory(
    paths.embeddingAssetDirectory,
    DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST_SHA256,
  );
  if (assets.status === "unavailable") {
    throw new EmbeddingAssetsUnavailableError(assets.problem);
  }
}

/**
 * Resolves provider configuration against the durable references that remain
 * reachable before the daemon object graph is created.
 *
 * The temporary Registry handle is closed before `createDaemonRuntime` opens
 * its long-lived handle. Ingestion's already validated connection is reused so
 * the catalog and the runtime cannot accidentally inspect two namespaces.
 */
export async function resolveCliEmbeddingRuntime(input: {
  readonly environment: Readonly<Partial<Record<string, string>>>;
  readonly paths: ContextctlPaths;
  readonly ingestionDatabase: DatabaseSync;
  readonly stateIdentity: DaemonStateIdentity;
}): Promise<ResolvedCliEmbeddingRuntime> {
  const configuration = readEmbeddingCompositionConfiguration(
    input.environment,
    input.stateIdentity.securityDomain,
  );
  const profiles = readActiveEmbeddingProfiles(
    input.environment,
    configuration,
  );

  mkdirSync(dirname(input.paths.registryDatabase), { recursive: true });
  const registryDatabase = openRegistryDatabase({
    location: input.paths.registryDatabase,
    ...input.stateIdentity,
  });
  let requiredBindings: RequiredEmbeddingBindings;
  try {
    requiredBindings = await computeRequiredEmbeddingBindings({
      documentProfile: profiles.document,
      cardProfile: profiles.card,
      catalog: new RegistryApprovedCardCatalog(
        new SqliteCardStore(registryDatabase),
      ),
      publications: new SqliteIndexPublicationStore(input.ingestionDatabase),
    });
  } finally {
    registryDatabase.close();
  }

  assertRequiredDocumentProfileBindings(
    configuration,
    requiredBindings.currentDocumentProfile,
    requiredBindings.documentProfiles,
  );

  await verifyRequiredRetainedLocalBindings(configuration, requiredBindings);
  const activeLocal =
    configuration.document.mode === "local" || configuration.card.mode === "local";
  if (!activeLocal) return { configuration, profiles, requiredBindings };
  const assets = await resolveActiveAssetDirectory(
    input.paths.embeddingAssetDirectory,
    DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST_SHA256,
  );
  if (assets.status === "unavailable") {
    throw new EmbeddingAssetsUnavailableError(assets.problem);
  }
  const resourceProfile =
    configuration.document.mode === "local"
      ? profiles.document
      : DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE;
  await verifyLocalEmbeddingAssets(assets.directory, resourceProfile);
  return {
    configuration,
    profiles,
    requiredBindings,
    artifactDirectory: assets.directory,
  };
}

export { EmbeddingAssetsUnavailableError } from "./retained-embedding-assets.js";
