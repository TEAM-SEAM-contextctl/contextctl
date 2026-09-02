import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import type {
  EvaluationSplit,
  GenerationConfiguration,
} from "./types.js";

export interface CommandSpec {
  readonly file: string;
  readonly prefixArguments: readonly string[];
  readonly source: "workspace" | "external";
}

export interface EvaluationConfiguration {
  readonly validateOnly: boolean;
  readonly split: EvaluationSplit;
  readonly repositoryRoot: string;
  readonly benchmarkDirectory: string;
  readonly corpusDirectory: string;
  readonly fixturePath: string;
  readonly resultsDirectory: string;
  readonly workDirectory: string;
  readonly runId: string;
  readonly qdrantUrl?: string;
  readonly qdrantApiKey?: string;
  readonly embeddingAssetDirectory?: string;
  readonly httpPort: number;
  readonly repetitions: number;
  readonly topK: number;
  readonly prefetchK: number;
  readonly maxContextCharacters: number;
  readonly stateNamespaceId: string;
  readonly securityDomain: string;
  readonly command: CommandSpec;
  readonly generation?: GenerationConfiguration;
}

const DIST_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const BENCHMARK_DIRECTORY = resolve(DIST_DIRECTORY);
const REPOSITORY_ROOT = resolve(BENCHMARK_DIRECTORY, "../..");

export function readConfiguration(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): EvaluationConfiguration {
  let validateOnly = false;
  let split: EvaluationSplit = "holdout";
  for (const argument of argv) {
    if (argument === "--validate-only") {
      validateOnly = true;
    } else if (argument === "--development") {
      split = "development";
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }

  const generated = new Date().toISOString().replaceAll(":", "-");
  const entropy = createHash("sha256")
    .update(`${generated}\0${String(process.pid)}`)
    .digest("hex")
    .slice(0, 12);
  const runId = `run-${generated}-${entropy}`;
  const externalCommand = nonEmpty(
    environment["CONTEXTCTL_UTILITY_EVAL_CONTEXTCTL"],
  );
  const command: CommandSpec =
    externalCommand === undefined
      ? {
          file: process.execPath,
          prefixArguments: [
            resolve(
              REPOSITORY_ROOT,
              "apps/contextctl-daemon/bin/contextctl.mjs",
            ),
          ],
          source: "workspace",
        }
      : {
          file: resolve(externalCommand),
          prefixArguments: [],
          source: "external",
        };

  const configuration: EvaluationConfiguration = {
    validateOnly,
    split,
    repositoryRoot: REPOSITORY_ROOT,
    benchmarkDirectory: BENCHMARK_DIRECTORY,
    corpusDirectory: resolve(
      REPOSITORY_ROOT,
      "apps/contextctl-daemon/demo/docs",
    ),
    fixturePath: resolve(BENCHMARK_DIRECTORY, "fixtures", `${split}.json`),
    resultsDirectory: resolve(BENCHMARK_DIRECTORY, "results", runId),
    workDirectory: resolve(BENCHMARK_DIRECTORY, ".work", runId),
    runId,
    httpPort: positiveInteger(
      environment["CONTEXTCTL_UTILITY_EVAL_HTTP_PORT"],
      18_080,
      "CONTEXTCTL_UTILITY_EVAL_HTTP_PORT",
      65_535,
    ),
    repetitions: positiveInteger(
      environment["CONTEXTCTL_UTILITY_EVAL_REPETITIONS"],
      5,
      "CONTEXTCTL_UTILITY_EVAL_REPETITIONS",
      100,
    ),
    topK: positiveInteger(
      environment["CONTEXTCTL_UTILITY_EVAL_TOP_K"],
      5,
      "CONTEXTCTL_UTILITY_EVAL_TOP_K",
      100,
    ),
    prefetchK: positiveInteger(
      environment["CONTEXTCTL_UTILITY_EVAL_PREFETCH_K"],
      20,
      "CONTEXTCTL_UTILITY_EVAL_PREFETCH_K",
      1_000,
    ),
    maxContextCharacters: positiveInteger(
      environment["CONTEXTCTL_UTILITY_EVAL_MAX_CONTEXT"],
      8_000,
      "CONTEXTCTL_UTILITY_EVAL_MAX_CONTEXT",
      1_000_000,
    ),
    stateNamespaceId: `utility-eval-${entropy}`,
    securityDomain: "utility-evaluation",
    command,
    ...optional(nonEmpty(environment["CONTEXTCTL_QDRANT_URL"]), "qdrantUrl"),
    ...optional(
      nonEmpty(environment["CONTEXTCTL_QDRANT_API_KEY"]),
      "qdrantApiKey",
    ),
    ...optional(
      nonEmpty(environment["CONTEXTCTL_EMBEDDING_ASSET_DIRECTORY"]),
      "embeddingAssetDirectory",
    ),
    ...readGeneration(environment),
  };

  if (configuration.prefetchK < configuration.topK) {
    throw new Error("CONTEXTCTL_UTILITY_EVAL_PREFETCH_K must be >= TOP_K");
  }
  if (
    !validateOnly &&
    (configuration.qdrantUrl === undefined ||
      configuration.embeddingAssetDirectory === undefined)
  ) {
    throw new Error(
      "evaluation requires CONTEXTCTL_QDRANT_URL and CONTEXTCTL_EMBEDDING_ASSET_DIRECTORY",
    );
  }
  return configuration;
}

function readGeneration(
  environment: NodeJS.ProcessEnv,
): { readonly generation?: GenerationConfiguration } {
  const endpoint = nonEmpty(
    environment["CONTEXTCTL_UTILITY_EVAL_GENERATION_ENDPOINT"],
  );
  const model = nonEmpty(
    environment["CONTEXTCTL_UTILITY_EVAL_GENERATION_MODEL"],
  );
  const apiKey = nonEmpty(
    environment["CONTEXTCTL_UTILITY_EVAL_GENERATION_API_KEY"],
  );
  const supplied = [endpoint, model, apiKey].filter(
    (value) => value !== undefined,
  ).length;
  if (supplied === 0) return {};
  if (supplied !== 3) {
    throw new Error(
      "generation requires ENDPOINT, MODEL, and API_KEY together",
    );
  }
  return {
    generation: {
      endpoint: endpoint as string,
      model: model as string,
      apiKey: apiKey as string,
    },
  };
}

function positiveInteger(
  raw: string | undefined,
  fallback: number,
  name: string,
  maximum: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^[1-9][0-9]*$/u.test(raw)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) {
    throw new Error(`${name} is outside its supported range`);
  }
  return value;
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized === ""
    ? undefined
    : normalized;
}

function optional<K extends string, V>(
  value: V | undefined,
  key: K,
): { readonly [P in K]?: V } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]: V });
}
