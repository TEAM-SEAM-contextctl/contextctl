import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";

import type { ContextResolution } from "@contextctl/selection-delivery";

import type {
  CommandSpec,
  EvaluationConfiguration,
} from "./config.js";
import type { RetrievedChunk } from "./types.js";

export interface PreparedProduct {
  readonly version: string;
  readonly corpusDirectory: string;
  readonly documentCount: number;
  readonly environment: NodeJS.ProcessEnv;
}

export interface ProductResolution {
  readonly resolution: ContextResolution;
  readonly chunks: readonly RetrievedChunk[];
  readonly latencyMs: number;
  readonly candidateCount: number;
}

export interface ProductServer {
  resolve(
    query: string,
    maxContextCharacters: number,
  ): Promise<ProductResolution>;
  close(): Promise<void>;
}

const CARD_MEANING_VARIABLES = [
  "CONTEXTCTL_CARD_MEANING_BASE_URL",
  "CONTEXTCTL_CARD_MEANING_MODEL",
  "CONTEXTCTL_CARD_MEANING_API_KEY",
  "CONTEXTCTL_CARD_MEANING_TIMEOUT_MS",
  "CONTEXTCTL_CARD_MEANING_CONTEXT_TOKENS",
  "CONTEXTCTL_CARD_MEANING_MAX_OUTPUT_TOKENS",
] as const;

export async function prepareProduct(
  configuration: EvaluationConfiguration,
): Promise<PreparedProduct> {
  const qdrantUrl = required(configuration.qdrantUrl, "Qdrant URL");
  const assetDirectory = required(
    configuration.embeddingAssetDirectory,
    "embedding asset directory",
  );
  const home = join(configuration.workDirectory, "home");
  const corpusDirectory = join(configuration.workDirectory, "corpus");
  await mkdir(configuration.workDirectory, { recursive: true });
  await mkdir(home, { recursive: false });
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    CONTEXTCTL_HOME: home,
    CONTEXTCTL_QDRANT_URL: qdrantUrl,
    CONTEXTCTL_EMBEDDING_ASSET_DIRECTORY: assetDirectory,
    CONTEXTCTL_STATE_NAMESPACE_ID: configuration.stateNamespaceId,
    CONTEXTCTL_SECURITY_DOMAIN: configuration.securityDomain,
    CONTEXTCTL_SENSITIVE_ACCESS: "deny",
    CONTEXTCTL_HTTP_HOST: "127.0.0.1",
    CONTEXTCTL_HTTP_PORT: String(configuration.httpPort),
  };
  if (configuration.qdrantApiKey !== undefined) {
    environment["CONTEXTCTL_QDRANT_API_KEY"] = configuration.qdrantApiKey;
  }
  for (const key of CARD_MEANING_VARIABLES) delete environment[key];

  const version = (
    await runCommand(configuration.command, ["--version"], environment, 30_000)
  ).stdout.trim();
  await runCli(configuration, ["demo", "init", corpusDirectory], environment);
  const documents = (await readdir(corpusDirectory))
    .filter((name) => name.endsWith(".md"))
    .sort(compareText);
  if (documents.length === 0) throw new Error("demo init produced no documents");
  for (const document of documents) {
    await runCli(
      configuration,
      ["source", "add", join(corpusDirectory, document)],
      environment,
    );
  }
  await runCli(configuration, ["ingest"], environment, 15 * 60_000);
  const listed = await runCli(
    configuration,
    ["cards", "list", "--pending", "--json"],
    environment,
  );
  const approvals = parsePendingCards(listed.stdout);
  if (approvals.length === 0) {
    throw new Error("ingest produced no pending Card versions");
  }
  for (const approval of approvals) {
    await runCli(
      configuration,
      [
        "cards",
        "approve",
        approval.cardId,
        approval.versionId,
        "--by",
        "utility-evaluation",
        "--note",
        "fixed benchmark corpus",
      ],
      environment,
    );
  }
  await runCli(configuration, ["reachability"], environment);
  return {
    version,
    corpusDirectory,
    documentCount: documents.length,
    environment,
  };
}

export async function startProductServer(input: {
  readonly configuration: EvaluationConfiguration;
  readonly product: PreparedProduct;
}): Promise<ProductServer> {
  const { configuration } = input;
  if (await portOpen(configuration.httpPort)) {
    throw new Error(
      `utility evaluation HTTP port is already in use: ${String(configuration.httpPort)}`,
    );
  }
  const child = spawn(
    configuration.command.file,
    [...configuration.command.prefixArguments, "serve"],
    {
      cwd: configuration.repositoryRoot,
      env: input.product.environment,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  await waitForPort(child, configuration.httpPort, stderr);

  return {
    async resolve(query, maxContextCharacters) {
      const started = performance.now();
      const response = await fetch(
        `http://127.0.0.1:${String(configuration.httpPort)}/v1/context/resolve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query, maxContextCharacters }),
          signal: AbortSignal.timeout(30_000),
        },
      );
      const latencyMs = performance.now() - started;
      const raw: unknown = await response.json();
      if (!response.ok) {
        throw new Error(
          `Contextctl HTTP resolve failed with ${String(response.status)}: ${JSON.stringify(raw)}`,
        );
      }
      const resolution = parseResolution(raw, query);
      return {
        resolution,
        chunks: chunksFromResolution(resolution).slice(0, configuration.topK),
        latencyMs,
        candidateCount:
          resolution.selection.counts.admitted +
          resolution.selection.counts.deferred +
          resolution.selection.counts.rejected,
      };
    },
    async close() {
      child.stdin.end();
      child.kill("SIGTERM");
      const exitCode = await waitForExit(child, 10_000);
      if (exitCode === undefined) {
        child.kill("SIGKILL");
        await waitForExit(child, 5_000);
      }
      const unexpected = child.exitCode;
      if (unexpected !== null && unexpected !== 0) {
        throw new Error(
          `Contextctl serve exited with ${String(unexpected)}: ${Buffer.concat(stderr).toString("utf8").trim() || Buffer.concat(stdout).toString("utf8").trim()}`,
        );
      }
    },
  };
}

async function runCli(
  configuration: EvaluationConfiguration,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  timeoutMs = 120_000,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return await runCommand(
    configuration.command,
    arguments_,
    environment,
    timeoutMs,
    configuration.repositoryRoot,
  );
}

function runCommand(
  command: CommandSpec,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
  cwd?: string,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      command.file,
      [...command.prefixArguments, ...arguments_],
      { cwd, env: environment, stdio: ["ignore", "pipe", "pipe"] },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const collect = (target: Buffer[], chunk: Buffer): void => {
      size += chunk.byteLength;
      if (size > 16 * 1024 * 1024) {
        child.kill("SIGTERM");
        fail(new Error("contextctl command output exceeded 16 MiB"));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      fail(
        new Error(
          `contextctl command timed out: ${arguments_.join(" ")}`,
        ),
      );
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      fail(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      const output = Buffer.concat(stdout).toString("utf8");
      const diagnostics = Buffer.concat(stderr).toString("utf8");
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(
          new Error(
            `contextctl ${arguments_.join(" ")} exited with ${String(code)}: ${diagnostics.trim() || output.trim()}`,
          ),
        );
      } else {
        resolve({ stdout: output, stderr: diagnostics });
      }
    });
  });
}

function parsePendingCards(
  raw: string,
): readonly { readonly cardId: string; readonly versionId: string }[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("cards list JSON is not an array");
  return parsed.map((entry, index) => {
    if (!isRecord(entry) || !isRecord(entry["card"])) {
      throw new Error(`cards list entry ${String(index)} is invalid`);
    }
    const cardId = entry["card"]["id"];
    const pending = entry["pendingVersionIds"];
    if (
      typeof cardId !== "string" ||
      !Array.isArray(pending) ||
      pending.length !== 1 ||
      typeof pending[0] !== "string"
    ) {
      throw new Error(
        `fresh Card ${String(cardId)} must have exactly one pending version`,
      );
    }
    return { cardId, versionId: pending[0] };
  });
}

function parseResolution(value: unknown, expectedQuery: string): ContextResolution {
  if (
    !isRecord(value) ||
    value["query"] !== expectedQuery ||
    !isRecord(value["policy"]) ||
    value["policy"]["payloadSchemaVersion"] !== 3 ||
    !isRecord(value["selection"]) ||
    !isRecord(value["selection"]["counts"]) ||
    !Array.isArray(value["selection"]["selected"]) ||
    !Array.isArray(value["items"])
  ) {
    throw new Error("Contextctl returned an invalid ContextResolution payload");
  }
  for (const key of ["admitted", "deferred", "rejected"]) {
    if (!Number.isSafeInteger(value["selection"]["counts"][key])) {
      throw new Error(`ContextResolution selection count is invalid: ${key}`);
    }
  }
  return value as unknown as ContextResolution;
}

function chunksFromResolution(
  resolution: ContextResolution,
): readonly RetrievedChunk[] {
  return resolution.items
    .flatMap((item) =>
      item.fulfillment.status === "fulfilled"
        ? item.fulfillment.context.chunks
        : [],
    )
    .sort((left, right) => left.contextRank - right.contextRank)
    .map((chunk) => ({
      chunkId: chunk.chunkId,
      chunkRevisionId: chunk.chunkRevisionId,
      semanticUnitId: chunk.semanticUnitId,
      documentId: chunk.documentId,
      text: chunk.text,
      vector: [],
      score: 1 / chunk.contextRank,
      scoreKind: "product" as const,
    }));
}

async function waitForPort(
  child: ChildProcessWithoutNullStreams,
  port: number,
  stderr: readonly Buffer[],
): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Contextctl serve exited during startup: ${Buffer.concat(stderr).toString("utf8").trim()}`,
      );
    }
    if (await portOpen(port)) return;
    await delay(100);
  }
  child.kill("SIGTERM");
  throw new Error("Contextctl serve did not open its HTTP port in 120 seconds");
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(250);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    const unavailable = (): void => {
      socket.destroy();
      resolve(false);
    };
    socket.once("timeout", unavailable);
    socket.once("error", unavailable);
  });
}

function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<number | null | undefined> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(undefined), timeoutMs);
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function required(value: string | undefined, label: string): string {
  if (value === undefined) throw new Error(`missing ${label}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
