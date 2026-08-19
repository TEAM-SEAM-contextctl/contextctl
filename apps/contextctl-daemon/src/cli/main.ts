#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
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
  runCardsDecision,
  runReachability,
  runCardsList,
  runDoctor,
  runInstallAssets,
  runPaths,
  runIngest,
  runQuery,
  runSourceAdd,
  runSourceList,
  runSourceRemove,
  type CommandOutcome,
} from "./commands.js";
import {
  buildCliRuntime,
  cliRuntimeOptions,
  EmbeddingAssetsUnavailableError,
  openRegistryOnlyRuntime,
  type CliRuntime,
} from "./runtime.js";
import { resolveActiveAssetDirectory } from "./asset-directory.js";
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
  "  contextctl install-assets",
  "  (약 415MB를 내려받는다. 설치 위치는 CONTEXTCTL_EMBEDDING_ASSET_DIRECTORY 로 바꿀 수 있다.)",
  "  상태를 먼저 보려면: contextctl doctor",
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
    command.kind === "query"
  );
}

/*
 * The operator decisions and the reachability report take a different path from
 * every other command: they need Registry's database and nothing else.
 *
 * They decide about Cards — promote, refuse, withdraw, roll back — and report
 * which Scopes an approved Card can reach. None of them embeds anything, so none
 * should require the 415MB embedding artifact to be installed. Routing them
 * through the full runtime meant an operator could not disable a Card that was
 * serving badly, or find out which Scopes were unreachable, on a machine where
 * the model was never downloaded. See the branch in `runCli`.
 */

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
    input.stdout(`contextctl ${await readPackageVersion()}`);
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

  // Both run before any runtime is built, and deliberately so: they are the two
  // commands an operator reaches for when the runtime will not build. Asking
  // them to install a 415MB model in order to be told the model is missing
  // would be the same trap `source` avoids.
  if (command.kind === "install_assets") {
    return emit(
      input,
      await runInstallAssets({
        command,
        environment: input.environment,
        workingDirectory,
        progress: input.stderr,
        ...(shouldPromptForConsent(command.yes)
          ? { confirm: () => promptForConsent(input.stderr) }
          : {}),
      }),
    );
  }
  if (command.kind === "paths") {
    return emit(
      input,
      await runPaths({ environment: input.environment, workingDirectory }),
    );
  }
  if (command.kind === "doctor") {
    return emit(
      input,
      await runDoctor({
        command,
        environment: input.environment,
        workingDirectory,
      }),
    );
  }

  try {
    if (command.kind === "cards_decision" || command.kind === "reachability") {
      // Inside the same guard as every other command on purpose: an unreadable
      // database has to reach an operator as a sentence, and a branch outside it
      // reported the first `contextctl reachability` on a fresh machine as an
      // uncaught SQLite stack trace.
      const registry = openRegistryOnlyRuntime({
        environment: input.environment,
        workingDirectory,
      });
      try {
        return emit(
          input,
          command.kind === "cards_decision"
            ? await runCardsDecision(registry, command)
            : await runReachability(registry, command),
        );
      } finally {
        registry.close();
      }
    }
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
  // `serve` resolves the pointer exactly as `buildCliRuntime` does. It cannot
  // reuse that function — a served process holds its databases open for life
  // while `buildCliRuntime` returns something the caller closes — so the one
  // thing it must not do is work the directory out for itself.
  const assets = await resolveActiveAssetDirectory(paths.embeddingAssetDirectory);
  if (assets.status === "unavailable") {
    throw new EmbeddingAssetsUnavailableError(assets.problem);
  }
  const options = cliRuntimeOptions({
    paths,
    embeddingArtifactDirectory: assets.directory,
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

/**
 * The version this build was packed at, read from the manifest beside it.
 *
 * A literal here was wrong in a way that only shows up after a release: the
 * string said `0.0.0` while the installed package said `0.1.0`, and nothing in
 * the build could notice, because the two are only compared by a person running
 * the command. Reading the manifest makes the number a fact about the artifact
 * rather than a copy someone has to remember to update.
 *
 * Two levels up from `dist/cli/`, which is the package root in both the packed
 * tarball and a repository build. Read on demand rather than at import, so the
 * commands that never print it pay nothing.
 */
async function readPackageVersion(): Promise<string> {
  try {
    const manifest = await readFile(
      new URL("../../package.json", import.meta.url),
      "utf8",
    );
    const parsed: unknown = JSON.parse(manifest);
    const version =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { readonly version?: unknown }).version
        : undefined;
    return typeof version === "string" ? version : "unknown";
  } catch {
    // A missing or unreadable manifest is not worth failing `--version` over:
    // the command exists so a user can say what they are running, and "unknown"
    // is a truthful answer where a stale literal was not.
    return "unknown";
  }
}

/**
 * Whether there is anyone at the other end to answer.
 *
 * `--yes` is an answer already given. Absent that, a prompt is only meaningful
 * on a terminal: in a pipeline or a CI job there is no one to type, and blocking
 * on stdin there would hang the job rather than ask it anything. Non-interactive
 * therefore proceeds, which is the same reading the flag has — the operator
 * arranged for this command to run unattended.
 */
function shouldPromptForConsent(yes: boolean): boolean {
  return !yes && process.stdin.isTTY === true;
}

/**
 * Asks once, on stderr, and treats anything but an explicit yes as no.
 *
 * The question goes to stderr because stdout carries the command's result and
 * may be redirected to a file; a prompt written there would be invisible and
 * the terminal would look frozen.
 */
async function promptForConsent(write: (text: string) => void): Promise<boolean> {
  write("계속하려면 y 를 입력하십시오 [y/N]:");
  const reader = createInterface({ input: process.stdin });
  try {
    for await (const line of reader) {
      const answer = line.trim().toLowerCase();
      return answer === "y" || answer === "yes";
    }
    // stdin closed without a line. Silence is not consent.
    return false;
  } finally {
    reader.close();
  }
}

/** Turns an exception into the one sentence an operator can act on. */
function describeFailure(error: unknown): string {
  if (error instanceof EmbeddingAssetsUnavailableError) {
    // Reported before the generic fault below, and with the pointer problem's
    // own sentence: the adapter's `embedding_artifact_unavailable` cannot say
    // which of several situations it is in, and this can.
    return [error.message, "", INSTALL_ASSETS_HINT].join("\n");
  }
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
