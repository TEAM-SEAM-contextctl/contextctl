#!/usr/bin/env node
import {
  EmbeddingProviderFault,
  openIngestionDatabase,
} from "@contextctl/ingestion-indexing";

import {
  DEFAULT_SECURITY_DOMAIN,
  DEFAULT_STATE_NAMESPACE_ID,
  EMBEDDING_ASSETS_MISSING_GUIDANCE,
  runDaemon,
} from "../main.js";
import { parseCliArguments, usageText, type CliCommand } from "./arguments.js";
import {
  failed,
  runCardsApprove,
  runCardsList,
  runIngest,
  runQuery,
  runSourceAdd,
  runSourceList,
  runSourceRemove,
  type CommandOutcome,
} from "./commands.js";
import { buildCliRuntime, cliRuntimeOptions, type CliRuntime } from "./runtime.js";
import { resolveContextctlPaths } from "./paths.js";
import { readSourcesFile, SourcesFileError, toSourceConfigurations } from "./sources-file.js";
import { resolveCardMeaningBackend } from "./meaning-generator.js";
import { resolveVectorBackend } from "./vector-backend.js";

/**
 * The command line entry point.
 *
 * Two rules shape this file and nothing else does. Command results go to
 * stdout; everything advisory goes to stderr — so `contextctl query ... > out`
 * captures the answer and still shows the operator why it might be empty. And
 * `serve` is exempt from the first rule entirely: it hands stdout to the MCP
 * JSON-RPC stream, where one stray line desynchronises the peer, so nothing on
 * that path may print at all.
 */

export const INSTALL_ASSETS_HINT = [
  EMBEDDING_ASSETS_MISSING_GUIDANCE,
  "  node apps/contextctl-daemon/scripts/install-embedding-assets.mjs",
  "  (약 390MB를 내려받는다. 설치 위치는 CONTEXTCTL_EMBEDDING_ASSET_DIRECTORY 로 바꿀 수 있다.)",
].join("\n");

/**
 * Which commands need an assembled runtime.
 *
 * `source` does not, and that is the point: registering a file is a statement
 * about the filesystem, and requiring 390MB of embedding weights to record one
 * would block an operator at the first step they take.
 */
function needsRuntime(command: CliCommand): boolean {
  return (
    command.kind === "ingest" ||
    command.kind === "cards_list" ||
    command.kind === "cards_approve" ||
    command.kind === "query"
  );
}

export async function runCli(input: {
  readonly argv: readonly string[];
  readonly environment: Readonly<Partial<Record<string, string>>>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly workingDirectory?: string;
}): Promise<number> {
  const parsed = parseCliArguments(input.argv);
  if (parsed.status === "usage_error") {
    input.stderr(parsed.message);
    return 2;
  }
  const command = parsed.command;

  if (command.kind === "help") {
    input.stdout(usageText(command.topic));
    return 0;
  }
  if (command.kind === "version") {
    input.stdout("contextctl 0.0.0");
    return 0;
  }
  if (command.kind === "serve") {
    // Nothing is written here, on either stream. `runDaemon` owns stdout from
    // this point, and the options it receives are the CLI's own — file-backed
    // Registry, durable Ingestion stores, the configured vector backend — so a
    // `serve` process and a `query` process see the same state.
    await runServe(input.environment, input.workingDirectory ?? process.cwd());
    return 0;
  }

  const paths = resolveContextctlPaths(input.environment, input.workingDirectory);
  const workingDirectory = input.workingDirectory ?? process.cwd();

  try {
    if (!needsRuntime(command)) {
      return emit(input, await runWithoutRuntime(command, paths.sourcesFile, workingDirectory));
    }
    const cli = await openRuntime(input);
    try {
      return emit(input, await runWithRuntime(cli, command));
    } finally {
      cli.close();
    }
  } catch (error: unknown) {
    input.stderr(describeFailure(error));
    return 1;
  }
}

function emit(
  input: { readonly stdout: (text: string) => void; readonly stderr: (text: string) => void },
  outcome: CommandOutcome,
): number {
  if (outcome.stdout !== "") {
    input.stdout(outcome.stdout);
  }
  for (const line of outcome.stderr) {
    input.stderr(line);
  }
  return outcome.exitCode;
}

async function runWithoutRuntime(
  command: CliCommand,
  sourcesFile: string,
  workingDirectory: string,
): Promise<CommandOutcome> {
  switch (command.kind) {
    case "source_add":
      return runSourceAdd(command, sourcesFile, workingDirectory);
    case "source_list":
      return runSourceList(sourcesFile);
    case "source_remove":
      return runSourceRemove(command.reference, sourcesFile);
    default:
      return failed(`이 명령은 런타임 없이 실행할 수 없다: ${command.kind}`);
  }
}

async function runWithRuntime(
  cli: CliRuntime,
  command: CliCommand,
): Promise<CommandOutcome> {
  switch (command.kind) {
    case "ingest":
      return runIngest(cli, command.reference);
    case "cards_list":
      return runCardsList(cli, command.json);
    case "cards_approve":
      return runCardsApprove(cli, command);
    case "query":
      return runQuery(cli, command);
    default:
      return failed(`알 수 없는 명령: ${command.kind}`);
  }
}

/**
 * Builds the runtime with a de-duplicating diagnostic sink.
 *
 * The Card meaning generator reports one fallback per Knowledge Unit, so an
 * endpoint that is simply down produces the same sentence once per Card. Repeated
 * verbatim it buries the rest of the run; suppressed entirely it would hide that
 * the model was unreachable at all. Reporting each distinct message once, with a
 * count when it recurs, keeps both facts.
 */
async function openRuntime(input: {
  readonly environment: Readonly<Partial<Record<string, string>>>;
  readonly stderr: (text: string) => void;
  readonly workingDirectory?: string;
}): Promise<CliRuntime> {
  const seen = new Map<string, number>();
  const diagnostics = (message: string): void => {
    const count = (seen.get(message) ?? 0) + 1;
    seen.set(message, count);
    if (count === 1) {
      input.stderr(message);
    } else if (count === 2) {
      input.stderr(`  (위 경고는 이후 반복되며, 반복분은 생략한다)`);
    }
  };
  return buildCliRuntime({
    environment: input.environment,
    diagnostics,
    ...(input.workingDirectory === undefined ? {} : { workingDirectory: input.workingDirectory }),
  });
}

/**
 * Starts the daemon under the CLI's own composition.
 *
 * It cannot reuse `buildCliRuntime`, which returns a runtime the caller closes;
 * a served process holds its databases open for its whole life. What it does
 * reuse is `cliRuntimeOptions`, so the two paths cannot drift into serving from
 * one Registry while the CLI writes to another.
 */
async function runServe(
  environment: Readonly<Partial<Record<string, string>>>,
  workingDirectory: string,
): Promise<void> {
  const paths = resolveContextctlPaths(environment, workingDirectory);
  const sources = await readSourcesFile(paths.sourcesFile);
  const ingestionDatabase = openIngestionDatabase({
    location: paths.ingestionDatabase,
    stateNamespaceId: DEFAULT_STATE_NAMESPACE_ID,
    securityDomain: DEFAULT_SECURITY_DOMAIN,
  });
  const options = cliRuntimeOptions({
    paths,
    sourceConfigurations: toSourceConfigurations(sources),
    ingestionDatabase,
    vectorBackend: resolveVectorBackend(environment),
    meaningBackend: resolveCardMeaningBackend({
      environment,
      // stdout belongs to JSON-RPC from here on, so every notice goes to stderr.
      onFallback: (message) => process.stderr.write(`${message}\n`),
    }),
  });
  await runDaemon(environment, options);
}

/** Turns an exception into the one sentence an operator can act on. */
function describeFailure(error: unknown): string {
  if (
    error instanceof EmbeddingProviderFault &&
    error.code === "embedding_artifact_unavailable"
  ) {
    return INSTALL_ASSETS_HINT;
  }
  if (error instanceof SourcesFileError) {
    return `Source 설정 파일을 읽을 수 없다 (${error.code}): ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Dispatches on import, with no entry-point guard.
 *
 * `main.ts` guards itself and must keep doing so: it is what `exports["."]`
 * resolves to, so anything depending on `@contextctl/daemon` loads it, and an
 * unguarded `runStdioServer` there would hang on stdin. This file is the
 * opposite case. It is a `bin` target, reached only because someone typed the
 * command, and nothing imports it.
 *
 * The guard that used to stand here compared `import.meta.url` against
 * `process.argv[1]`, and npm installs a `bin` as a symlink — so `argv[1]` was
 * `node_modules/.bin/contextctl` while `import.meta.url` was the real
 * `dist/cli/main.js`. The comparison was therefore false for every invocation
 * that went through the installed command, and the CLI exited 0 having done
 * nothing at all. Resolving the symlink instead would fix that one case and
 * leave the same shape of bug available to the next indirection — a wrapper
 * script, a shim on Windows, `npm exec`. A `bin` entry is by definition an
 * execution, so the honest form is to have no condition.
 */
process.exitCode = await runCli({
  argv: process.argv.slice(2),
  environment: process.env,
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
});
