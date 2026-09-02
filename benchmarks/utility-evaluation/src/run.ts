import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
} from "@contextctl/ingestion-indexing";
import {
  CARD_SELECTION_EMBEDDING_PROFILE,
} from "@contextctl/selection-delivery";

import { buildHybridIndex, retrieveHybrid, RRF_RANK_CONSTANT } from "./baseline.js";
import { readConfiguration } from "./config.js";
import { corpusDigest, readEvaluationDataset } from "./dataset.js";
import { createQueryEmbedder } from "./embedding.js";
import { generateGroundedAnswer } from "./generation.js";
import { observePath, summarize } from "./metrics.js";
import {
  prepareProduct,
  startProductServer,
  type ProductResolution,
} from "./product.js";
import { readPublishedCorpus } from "./qdrant.js";
import { writeEvaluationArtifacts } from "./report.js";
import type {
  EvaluationResult,
  GenerationObservation,
  QueryEvaluation,
  RetrievedChunk,
} from "./types.js";

const execFileAsync = promisify(execFile);

await main();

async function main(): Promise<void> {
  const configuration = readConfiguration(process.argv.slice(2));
  if (configuration.validateOnly) {
    for (const split of ["development", "holdout"] as const) {
      const dataset = await readEvaluationDataset({
        path: join(configuration.benchmarkDirectory, "fixtures", `${split}.json`),
        expectedSplit: split,
        corpusDirectory: configuration.corpusDirectory,
      });
      process.stdout.write(
        `validated ${split}: ${String(dataset.queries.length)} queries, sha256 ${dataset.sha256}\n`,
      );
    }
    return;
  }

  const dataset = await readEvaluationDataset({
    path: configuration.fixturePath,
    expectedSplit: configuration.split,
    corpusDirectory: configuration.corpusDirectory,
  });
  const expectedCorpus = await corpusDigest(configuration.corpusDirectory);
  const product = await prepareProduct(configuration);
  const actualCorpus = await corpusDigest(product.corpusDirectory);
  if (actualCorpus.sha256 !== expectedCorpus.sha256) {
    throw new Error(
      "contextctl demo init corpus differs from the fixture validation corpus",
    );
  }

  const qdrantUrl = required(configuration.qdrantUrl, "Qdrant URL");
  const corpus = await readPublishedCorpus({
    qdrant: {
      url: qdrantUrl,
      ...(configuration.qdrantApiKey === undefined
        ? {}
        : { apiKey: configuration.qdrantApiKey }),
    },
    stateNamespaceId: configuration.stateNamespaceId,
    securityDomain: configuration.securityDomain,
  });
  const chunks = corpus.chunks;
  const embedder = await createQueryEmbedder(
    required(configuration.embeddingAssetDirectory, "embedding assets"),
  );
  if (chunks[0]?.vector.length !== embedder.dimensions) {
    throw new Error(
      "Qdrant vectors and the query embedder have different dimensions",
    );
  }
  const index = buildHybridIndex(chunks);
  const server = await startProductServer({ configuration, product });
  const queries: QueryEvaluation[] = [];
  try {
    for (const [queryIndex, fixture] of dataset.queries.entries()) {
      const baseline = async (): Promise<{
        readonly chunks: readonly RetrievedChunk[];
        readonly candidateCount: number;
        readonly latencyMs: number;
      }> => {
        const started = performance.now();
        const queryVector = await embedder.embed(fixture.query);
        const denseRanking = await corpus.searchDense(
          queryVector,
          configuration.prefetchK,
        );
        const retrieval = retrieveHybrid({
          index,
          chunks,
          query: fixture.query,
          denseRanking,
          topK: configuration.topK,
          prefetchK: configuration.prefetchK,
          maxContextCharacters: configuration.maxContextCharacters,
        });
        return {
          chunks: retrieval.chunks,
          candidateCount: retrieval.candidateCount,
          latencyMs: performance.now() - started,
        };
      };

      await baseline();
      await server.resolve(fixture.query, configuration.maxContextCharacters);
      const baselineSamples: number[] = [];
      const productSamples: number[] = [];
      let baselineRepresentative:
        | Awaited<ReturnType<typeof baseline>>
        | undefined;
      let productRepresentative: ProductResolution | undefined;
      for (
        let repetition = 0;
        repetition < configuration.repetitions;
        repetition += 1
      ) {
        const productFirst = (queryIndex + repetition) % 2 === 0;
        if (productFirst) {
          const productRun = await server.resolve(
            fixture.query,
            configuration.maxContextCharacters,
          );
          productRepresentative = stableProduct(
            productRepresentative,
            productRun,
          );
          productSamples.push(productRun.latencyMs);
          const baselineRun = await baseline();
          baselineRepresentative ??= baselineRun;
          baselineSamples.push(baselineRun.latencyMs);
        } else {
          const baselineRun = await baseline();
          baselineRepresentative ??= baselineRun;
          baselineSamples.push(baselineRun.latencyMs);
          const productRun = await server.resolve(
            fixture.query,
            configuration.maxContextCharacters,
          );
          productRepresentative = stableProduct(
            productRepresentative,
            productRun,
          );
          productSamples.push(productRun.latencyMs);
        }
      }
      if (
        baselineRepresentative === undefined ||
        productRepresentative === undefined
      ) {
        throw new Error(`query ${fixture.id} produced no timed observation`);
      }

      const [baselineGeneration, productGeneration] =
        configuration.generation === undefined
          ? [undefined, undefined] as const
          : await Promise.all([
              generateGroundedAnswer({
                configuration: configuration.generation,
                query: fixture.query,
                chunks: baselineRepresentative.chunks,
              }),
              generateGroundedAnswer({
                configuration: configuration.generation,
                query: fixture.query,
                chunks: productRepresentative.chunks,
              }),
            ]);
      queries.push({
        fixture,
        hybridRag: observePath({
          path: "hybrid_rag",
          fixture,
          chunks: baselineRepresentative.chunks,
          allChunks: chunks,
          candidateCount: baselineRepresentative.candidateCount,
          cutoff: configuration.topK,
          latencySamplesMs: baselineSamples,
          ...generationField(baselineGeneration),
        }),
        contextctl: observePath({
          path: "contextctl",
          fixture,
          chunks: productRepresentative.chunks,
          allChunks: chunks,
          candidateCount: productRepresentative.candidateCount,
          cutoff: configuration.topK,
          latencySamplesMs: productSamples,
          ...generationField(productGeneration),
        }),
        contextctlResolution: productRepresentative.resolution,
      });
      process.stdout.write(
        `[${String(queryIndex + 1)}/${String(dataset.queries.length)}] ${fixture.id}\n`,
      );
    }
  } finally {
    await server.close();
  }

  const promptTokenUsageComplete =
    configuration.generation !== undefined &&
    queries.every(
      (query) =>
        query.hybridRag.generation?.promptTokens !== undefined &&
        query.contextctl.generation?.promptTokens !== undefined,
    );

  const result: EvaluationResult = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    experiment: "contextctl-utility-evaluation-v1",
    commit: await gitCommit(configuration.repositoryRoot),
    contextctlVersion: product.version,
    dataset: {
      split: dataset.split,
      sha256: dataset.sha256,
      queryCount: dataset.queries.length,
      ...(dataset.sealedAt === undefined ? {} : { sealedAt: dataset.sealedAt }),
    },
    environment: {
      node: process.version,
      npm: npmVersion(),
      platform: process.platform,
      architecture: process.arch,
      qdrantUrl: safeUrl(qdrantUrl),
      qdrantVersion: corpus.version,
      stateNamespaceId: configuration.stateNamespaceId,
      securityDomain: configuration.securityDomain,
    },
    configuration: {
      repetitions: configuration.repetitions,
      topK: configuration.topK,
      prefetchK: configuration.prefetchK,
      maxContextCharacters: configuration.maxContextCharacters,
      rrfRankConstant: RRF_RANK_CONSTANT,
      generationEnabled: configuration.generation !== undefined,
      promptTokenUsageComplete,
      documentEmbeddingProfileId:
        DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE.id,
      cardSelectionEmbeddingProfileId: CARD_SELECTION_EMBEDDING_PROFILE.id,
      selectionScoringPolicy:
        queries[0]?.contextctlResolution.policy.scoring ?? "unknown",
      selectionRankingPolicy:
        queries[0]?.contextctlResolution.policy.ranking ?? "unknown",
      selectionPlanningPolicy:
        queries[0]?.contextctlResolution.policy.planning ?? "unknown",
      baselinePolicy: "global-bm25+qdrant-dense+rrf-v1",
      contextctlCommandSource: configuration.command.source,
    },
    corpus: {
      documents: product.documentCount,
      chunks: chunks.length,
      vectorDimensions: embedder.dimensions,
      sha256: expectedCorpus.sha256,
    },
    queries,
    summary: summarize(queries),
    warnings: [
      "The corpus is the bundled five-document demo and does not represent arbitrary production corpora.",
      `The ${dataset.split} fixture contains ${String(dataset.queries.length)} questions and is a bounded regression/evidence set.`,
      "The baseline reuses Contextctl-published Chunks and vectors, so ingestion quality is held constant; the two complete retrieval strategies still differ.",
      ...(configuration.generation === undefined
        ? [
            "Answer generation was disabled; prompt-token reduction and answer-quality parity are not established.",
          ]
        : []),
      ...(configuration.generation !== undefined && !promptTokenUsageComplete
        ? [
            "The generation endpoint did not report prompt_tokens for every answer; token reduction is not established.",
          ]
        : []),
      "Card meanings use the deterministic built-in generator so the run does not depend on a private meaning-generation API.",
    ],
  };
  await writeEvaluationArtifacts({
    directory: configuration.resultsDirectory,
    result,
  });
  process.stdout.write(`wrote ${configuration.resultsDirectory}\n`);
}

function stableProduct(
  previous: ProductResolution | undefined,
  current: ProductResolution,
): ProductResolution {
  if (previous === undefined) return current;
  const before = previous.chunks.map((chunk) => chunk.chunkRevisionId).join("\0");
  const after = current.chunks.map((chunk) => chunk.chunkRevisionId).join("\0");
  if (before !== after) {
    throw new Error(
      "Contextctl returned non-deterministic Chunk revisions across repetitions",
    );
  }
  return previous;
}

function generationField(
  generation: GenerationObservation | undefined,
): { readonly generation?: GenerationObservation } {
  return generation === undefined ? {} : { generation };
}

async function gitCommit(repositoryRoot: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
  });
  return stdout.trim();
}

function safeUrl(raw: string): string {
  const url = new URL(raw);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function required(value: string | undefined, label: string): string {
  if (value === undefined) throw new Error(`missing ${label}`);
  return value;
}

function npmVersion(): string {
  const userAgent = process.env["npm_config_user_agent"] ?? "";
  return /(?:^|\s)npm\/([^\s]+)/u.exec(userAgent)?.[1] ?? "unknown";
}
