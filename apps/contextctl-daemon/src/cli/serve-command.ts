import { openIngestionDatabase } from "@contextctl/ingestion-indexing";

import {
  readDaemonStateIdentity,
  runDaemon,
} from "../main.js";
import { resolveVectorBackend } from "../vector-backend.js";
import {
  cliRuntimeOptions,
  preflightActiveEmbeddingConfiguration,
  resolveCliEmbeddingRuntime,
} from "./runtime.js";
import { resolveContextctlPaths } from "./paths.js";
import { readSourcesFile, toSourceConfigurations } from "./sources-file.js";
import { resolveCardMeaningBackend } from "./meaning-generator.js";

/** Starts the daemon under the CLI's durable production composition. */
export async function runServeCommand(
  environment: Readonly<Partial<Record<string, string>>>,
  workingDirectory: string,
): Promise<void> {
  // Resolve the required durable index before opening either database. A bad
  // production composition must leave no checkpoint that can later make an
  // ingest look complete while its vectors never existed.
  const vectorBackend = resolveVectorBackend(environment);
  const paths = resolveContextctlPaths(environment, workingDirectory);
  const stateIdentity = readDaemonStateIdentity(environment);
  const sources = await readSourcesFile(paths.sourcesFile);
  await preflightActiveEmbeddingConfiguration(
    environment,
    paths,
    stateIdentity,
  );
  const ingestionDatabase = openIngestionDatabase({
    location: paths.ingestionDatabase,
    ...stateIdentity,
  });
  const embeddingRuntime = await resolveCliEmbeddingRuntime({
    environment,
    paths,
    ingestionDatabase,
    stateIdentity,
  });
  const options = cliRuntimeOptions({
    environment,
    paths,
    embeddingRuntime,
    sourceConfigurations: toSourceConfigurations(sources),
    ingestionDatabase,
    vectorBackend,
    stateIdentity,
    meaningBackend: resolveCardMeaningBackend({
      environment,
      // stdout belongs to JSON-RPC from here on, so every notice goes to stderr.
      onFallback: (message) => process.stderr.write(`${message}\n`),
    }),
  });
  await runDaemon(environment, options);
}
