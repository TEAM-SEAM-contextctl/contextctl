import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Where the CLI keeps everything it must remember between invocations.
 *
 * The daemon library defaults every one of these to something that needs no
 * disk — `:memory:` for Registry, in-memory adapters for Ingestion — and that
 * stays true: `createDaemonRuntime` is unchanged, and a program embedding it
 * still gets a runtime that writes nothing. File defaults live here instead,
 * because they are a property of *being a command line tool*, not of the
 * composition. A CLI process starts and exits between every step an operator
 * takes, so state that is merely in memory is state the next command cannot see.
 *
 * Every durable value is overridable, and the override is read from the
 * environment rather than from a config file. There is deliberately no second
 * configuration format here: `sources.json` records what an operator declared,
 * and everything else is deployment wiring that an operator sets once, in the
 * shell, beside the command they are running. The ephemeral activity file is
 * fixed under `home` so `serve`, `status` and `paths` cannot disagree about a
 * private process-to-process surface.
 */
export interface ContextctlPaths {
  /** Root of the CLI's own state. Everything below defaults inside it. */
  readonly home: string;
  readonly sourcesFile: string;
  readonly registryDatabase: string;
  readonly ingestionDatabase: string;
  /** Selection's bounded operator audit history. */
  readonly selectionAuditDatabase: string;
  /** Where the pinned embedding assets were installed. */
  readonly embeddingAssetDirectory: string;
  /** Protected, ephemeral per-process activity snapshots written by `serve`. */
  readonly runtimeActivityDirectory: string;
}

export const CONTEXTCTL_HOME_VARIABLE = "CONTEXTCTL_HOME";

/** The default root, `~/.contextctl`, matching the asset installer's own. */
export function defaultContextctlHome(): string {
  return join(homedir(), ".contextctl");
}

/**
 * Resolves every path the CLI uses, environment first.
 *
 * Each durable/configurable value is read independently rather than derived
 * from `home` at use time, so an operator can move exactly one thing — point
 * the registry at a scratch database, say — without restating the other four.
 * Relative values are
 * resolved against the process working directory, because a relative path in an
 * environment variable means "relative to where I am", and the stores below
 * receive absolute paths only: `verifyLocalEmbeddingAssets` refuses a relative
 * artifact directory outright.
 */
export function resolveContextctlPaths(
  environment: Readonly<Partial<Record<string, string>>>,
  workingDirectory: string = process.cwd(),
): ContextctlPaths {
  const absolute = (value: string): string =>
    isAbsolute(value) ? value : resolve(workingDirectory, value);
  const home = absolute(
    readNonEmpty(environment, CONTEXTCTL_HOME_VARIABLE) ??
      defaultContextctlHome(),
  );
  const inHome = (variable: string, fileName: string): string =>
    absolute(readNonEmpty(environment, variable) ?? join(home, fileName));

  return {
    home,
    sourcesFile: inHome("CONTEXTCTL_SOURCES_FILE", "sources.json"),
    registryDatabase: inHome("CONTEXTCTL_REGISTRY_DATABASE", "registry.db"),
    ingestionDatabase: inHome("CONTEXTCTL_INGESTION_DATABASE", "ingestion.db"),
    selectionAuditDatabase: inHome(
      "CONTEXTCTL_SELECTION_AUDIT_DATABASE",
      "selection-audit.db",
    ),
    embeddingAssetDirectory: inHome(
      "CONTEXTCTL_EMBEDDING_ASSET_DIRECTORY",
      "embedding-assets",
    ),
    runtimeActivityDirectory: join(home, "runtime-activity"),
  };
}

/**
 * A set variable, or `undefined` for one that is absent or blank.
 *
 * Blank counts as absent here, unlike `readDaemonRuntimeOptions`, which treats
 * an empty value as a value. The difference is deliberate and it is about who is
 * typing: that function reads a programmatic environment where an empty string
 * may be a deliberate setting, while this one reads a shell, where
 * `CONTEXTCTL_HOME=` is how someone unsets a variable — and honouring it as a
 * path would put the CLI's state at the filesystem root.
 */
export function readNonEmpty(
  environment: Readonly<Partial<Record<string, string>>>,
  variable: string,
): string | undefined {
  const value = environment[variable];
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}
