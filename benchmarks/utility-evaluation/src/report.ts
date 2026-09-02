import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { EvaluationResult, QueryEvaluation } from "./types.js";

export async function writeEvaluationArtifacts(input: {
  readonly directory: string;
  readonly result: EvaluationResult;
}): Promise<void> {
  await mkdir(input.directory, { recursive: false });
  await Promise.all([
    writeJson(join(input.directory, "result.json"), input.result),
    writeFile(join(input.directory, "report.md"), renderReport(input.result)),
    writeJson(
      join(input.directory, "blind-review.json"),
      blindReview(input.result.queries),
    ),
    writeJson(
      join(input.directory, "answer-key.json"),
      answerKey(input.result.queries),
    ),
  ]);
}

export function renderReport(result: EvaluationResult): string {
  const baseline = result.summary.hybridRag;
  const product = result.summary.contextctl;
  const comparison = result.summary.comparison;
  const rows = [
    row("Required-fact coverage", baseline.meanRequiredFactCoverage, product.meanRequiredFactCoverage, percent),
    row("Relevant Chunk recall@k", baseline.meanRelevantChunkRecallAtK, product.meanRelevantChunkRecallAtK, percent),
    row("MRR", baseline.meanReciprocalRank, product.meanReciprocalRank, decimal),
    row("nDCG@k", baseline.meanNdcgAtK, product.meanNdcgAtK, decimal),
    row("Irrelevant Chunk ratio", baseline.meanIrrelevantContextRatio, product.meanIrrelevantContextRatio, percent),
    row("Unanswerable rejection", baseline.unanswerableRejectionRate, product.unanswerableRejectionRate, percent),
    row("Mean context characters", baseline.meanContextCharacters, product.meanContextCharacters, whole),
    row("Mean prompt tokens", baseline.meanPromptTokens, product.meanPromptTokens, decimal),
    row("Retrieval latency p50 (ms)", baseline.latencyP50Ms, product.latencyP50Ms, decimal),
    row("Retrieval latency p95 (ms)", baseline.latencyP95Ms, product.latencyP95Ms, decimal),
  ].join("\n");
  const differences = result.queries.filter((query) =>
    isMaterialDifference(query),
  );
  return `# Contextctl utility evaluation\n\n` +
    `Generated: ${result.generatedAt}  \nCommit: \`${result.commit}\`  \n` +
    `Contextctl: \`${result.contextctlVersion}\`  \nDataset: \`${result.dataset.split}\` / \`${result.dataset.sha256}\`  \n\n` +
    `## Controlled comparison\n\n` +
    `Both paths use the same ${String(result.corpus.chunks)} immutable Chunks, ` +
    `${String(result.corpus.vectorDimensions)}-dimensional document vectors, document-query embedding profile, ` +
    `top-k (${String(result.configuration.topK)}), and context budget (${String(result.configuration.maxContextCharacters)} characters). ` +
    `Hybrid RAG performs global BM25 + Qdrant dense retrieval + RRF. Contextctl performs hybrid Card selection and then Qdrant dense retrieval inside the selected Scopes. ` +
    `This compares the complete retrieval strategies rather than isolating one variable.\n\n` +
    `Document profile: \`${result.configuration.documentEmbeddingProfileId}\`; ` +
    `Card profile: \`${result.configuration.cardSelectionEmbeddingProfileId}\`; ` +
    `Selection: \`${result.configuration.selectionScoringPolicy}\` / ` +
    `\`${result.configuration.selectionRankingPolicy}\` / ` +
    `\`${result.configuration.selectionPlanningPolicy}\`.\n\n` +
    `| Metric | Hybrid RAG | Contextctl |\n| --- | ---: | ---: |\n${rows}\n\n` +
    `Context characters changed by ${percent(comparison.contextCharacterReductionRatio)} (positive means reduction). ` +
    `Retrieval p95 changed by ${signed(comparison.latencyP95DeltaMs)} ms.\n\n` +
    `## Differences requiring review\n\n` +
    (differences.length === 0
      ? `No query-level evidence or abstention regression was observed.\n\n`
      : differences.map(renderDifference).join("\n") + "\n\n") +
    `## Claim boundary\n\n` +
    result.warnings.map((warning) => `- ${warning}`).join("\n") +
    `\n\nThis run is evidence for the bundled scenario, not a claim of general RAG superiority.\n`;
}

function isMaterialDifference(query: QueryEvaluation): boolean {
  const baseline = query.hybridRag;
  const product = query.contextctl;
  if (query.fixture.expectedAnswerable) {
    return (
      (product.requiredFactCoverage ?? 0) <
        (baseline.requiredFactCoverage ?? 0) ||
      (product.relevantChunkRecallAtK ?? 0) <
        (baseline.relevantChunkRecallAtK ?? 0)
    );
  }
  return baseline.rejectedUnanswerable && !product.rejectedUnanswerable;
}

function renderDifference(query: QueryEvaluation): string {
  return (
    `- \`${query.fixture.id}\`: ${query.fixture.query} ` +
    `(facts ${metric(query.hybridRag.requiredFactCoverage)} → ` +
    `${metric(query.contextctl.requiredFactCoverage)}, recall ` +
    `${metric(query.hybridRag.relevantChunkRecallAtK)} → ` +
    `${metric(query.contextctl.relevantChunkRecallAtK)}, chunks ` +
    `${String(query.hybridRag.chunks.length)} → ${String(query.contextctl.chunks.length)})`
  );
}

function metric(value: number | undefined): string {
  return value === undefined ? "n/a" : percent(value);
}

function blindReview(queries: readonly QueryEvaluation[]): unknown {
  return {
    schemaVersion: 1,
    instructions:
      "Score answer A and B independently for factual correctness, completeness, grounding, and abstention. Do not infer system identity.",
    items: queries.flatMap((query) => {
      const left = query.hybridRag.generation?.answer;
      const right = query.contextctl.generation?.answer;
      if (left === undefined || right === undefined) return [];
      const swap = swapPair(query.fixture.id);
      return [{
        queryId: query.fixture.id,
        query: query.fixture.query,
        expectedAnswerable: query.fixture.expectedAnswerable,
        requiredFacts: query.fixture.requiredFacts,
        answerA: swap ? right : left,
        answerB: swap ? left : right,
      }];
    }),
  };
}

function answerKey(queries: readonly QueryEvaluation[]): unknown {
  return {
    schemaVersion: 1,
    items: queries.flatMap((query) => {
      if (
        query.hybridRag.generation === undefined ||
        query.contextctl.generation === undefined
      ) return [];
      const swap = swapPair(query.fixture.id);
      return [{
        queryId: query.fixture.id,
        answerA: swap ? "contextctl" : "hybrid_rag",
        answerB: swap ? "hybrid_rag" : "contextctl",
        hybridRagUsage: usage(query.hybridRag.generation),
        contextctlUsage: usage(query.contextctl.generation),
      }];
    }),
  };
}

function usage(generation: NonNullable<QueryEvaluation["hybridRag"]["generation"]>): unknown {
  return {
    promptTokens: generation.promptTokens,
    completionTokens: generation.completionTokens,
    totalTokens: generation.totalTokens,
    latencyMs: generation.latencyMs,
  };
}

function swapPair(queryId: string): boolean {
  return (createHash("sha256").update(`utility-evaluation-v1\0${queryId}`).digest()[0] ?? 0) % 2 === 1;
}

function row(
  label: string,
  baseline: number | undefined,
  product: number | undefined,
  format: (value: number) => string,
): string {
  return `| ${label} | ${baseline === undefined ? "n/a" : format(baseline)} | ${product === undefined ? "n/a" : format(product)} |`;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function decimal(value: number): string {
  return value.toFixed(2);
}

function whole(value: number): string {
  return value.toFixed(0);
}

function signed(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, undefined, 2)}\n`);
}
