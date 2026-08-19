import type { DatabaseSync } from "node:sqlite";

import {
  openIngestionDatabase,
  SqliteIndexPublicationStore,
  SqliteIndexStagingAttemptStore,
  SqliteIngestionPublicationStore,
  SqliteMarkdownPublicationCheckpointStore,
  SqliteSourceObservationStore,
} from "@contextctl/ingestion-indexing";

import {
  createDaemonRuntime,
  DEFAULT_SECURITY_DOMAIN,
  DEFAULT_STATE_NAMESPACE_ID,
  type DaemonRuntime,
  type DaemonRuntimeOptions,
} from "../main.js";
import {
  describeAssetDirectoryProblem,
  resolveActiveAssetDirectory,
  type AssetDirectoryProblem,
} from "./asset-directory.js";
import {
  resolveCardMeaningBackend,
  type CardMeaningBackend,
} from "./meaning-generator.js";
import { resolveContextctlPaths, type ContextctlPaths } from "./paths.js";
import { readSourcesFile, toSourceConfigurations } from "./sources-file.js";
import { resolveVectorBackend, type VectorBackend } from "./vector-backend.js";

/**
 * The runtime one CLI invocation runs against, plus what an operator has to be
 * told about how it was assembled.
 *
 * The two backends travel beside the runtime rather than inside it because they
 * are diagnostics, not wiring: `DaemonRuntime` already holds the ports it built,
 * and what the CLI additionally needs to know is *which* of several legal
 * compositions it got — a question the graph itself cannot answer, since an
 * in-memory vector index and a Qdrant one are the same `VectorIndexPort`.
 */
export interface CliRuntime {
  readonly runtime: DaemonRuntime;
  readonly paths: ContextctlPaths;
  readonly vectorBackend: VectorBackend;
  readonly meaningBackend: CardMeaningBackend;
  /** Registered Source references, in the order the file declares them. */
  readonly sourceReferences: readonly string[];
  /** Closes both databases. Every command path must call it. */
  close(): void;
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
 * Every store here is file-backed except the vector index, and that exception is
 * the whole reason `vectorBackend` is reported rather than assumed: Ingestion
 * ships no durable vector adapter other than Qdrant, so an operator who has not
 * started one gets a composition that ingests successfully and then, in the next
 * process, searches an empty index. That failure produces no error anywhere —
 * which is exactly why the CLI says it out loud instead of letting a query
 * return an empty success.
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

  // Resolved here, and the failure is raised here rather than at the first
  // embedding call. The adapter loads lazily by design, so a composition given
  // a directory with no manifest in it assembles cleanly and then fails inside
  // `ingest` — which is the furthest possible point from the mistake. Asking
  // for the directory now turns that into a refusal to start, with the command
  // that fixes it named.
  const assets = await resolveActiveAssetDirectory(paths.embeddingAssetDirectory);
  if (assets.status === "unavailable") {
    throw new EmbeddingAssetsUnavailableError(assets.problem);
  }

  // Opened before `createDaemonRuntime` so that a schema failure — an ingestion
  // database written under a different security domain, say — is reported as
  // itself rather than as a runtime that would not assemble.
  const ingestionDatabase = openIngestionDatabase({
    location: paths.ingestionDatabase,
    stateNamespaceId: DEFAULT_STATE_NAMESPACE_ID,
    securityDomain: DEFAULT_SECURITY_DOMAIN,
  });

  let runtime: DaemonRuntime;
  try {
    runtime = createDaemonRuntime(
      cliRuntimeOptions({
        paths,
        sourceConfigurations,
        ingestionDatabase,
        vectorBackend,
        meaningBackend,
        embeddingArtifactDirectory: assets.directory,
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

  return {
    runtime,
    paths,
    vectorBackend,
    meaningBackend,
    sourceReferences: Object.keys(sources.sources),
    close(): void {
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
  readonly embeddingArtifactDirectory: string;
}): DaemonRuntimeOptions {
  const { ingestionDatabase } = input;
  return {
    registryDatabaseLocation: input.paths.registryDatabase,
    embeddingArtifactDirectory: input.embeddingArtifactDirectory,
    sourceConfigurations: input.sourceConfigurations,
    vectorIndex: input.vectorBackend.vectorIndex,
    meanings: input.meaningBackend.generator,
    ingestionStores: {
      observations: new SqliteSourceObservationStore(ingestionDatabase),
      checkpoints: new SqliteMarkdownPublicationCheckpointStore(ingestionDatabase),
      publications: new SqliteIngestionPublicationStore(ingestionDatabase),
      indexPublications: new SqliteIndexPublicationStore(ingestionDatabase),
      stagingAttempts: new SqliteIndexStagingAttemptStore(ingestionDatabase),
    },
  };
}


/**
 * The composition refused to start because no usable revision is installed.
 *
 * A distinct type rather than a generic failure, because the CLI answers it
 * with an install instruction and answers nothing else that way. It also keeps
 * the distinction the adapter cannot make: `verifyLocalEmbeddingAssets` folds a
 * missing install, a wrong digest and a short file into one
 * `embedding_artifact_unavailable`, and "you have not installed it" needs a
 * different next step from "what is installed is not what this build pins".
 */
export class EmbeddingAssetsUnavailableError extends Error {
  readonly problem: AssetDirectoryProblem;

  constructor(problem: AssetDirectoryProblem) {
    super(describeAssetDirectoryProblem(problem));
    this.name = "EmbeddingAssetsUnavailableError";
    this.problem = problem;
  }
}
