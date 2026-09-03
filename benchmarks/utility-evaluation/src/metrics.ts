import type {
  ComparisonSummary,
  PathObservation,
  PathSummary,
  QueryEvaluation,
  QueryFixture,
  ProductChunk,
  RetrievedChunk,
} from "./types.js";

export function observePath(input: {
  readonly path: PathObservation["path"];
  readonly fixture: QueryFixture;
  readonly chunks: readonly RetrievedChunk[];
  readonly allChunks: readonly ProductChunk[];
  readonly candidateCount: number;
  readonly cutoff: number;
  readonly latencySamplesMs: readonly number[];
  readonly generation?: PathObservation["generation"];
}): PathObservation {
  const relevant = relevantRevisionIds(input.fixture, input.allChunks);
  if (input.fixture.expectedAnswerable && relevant.size === 0) {
    throw new Error(
      `answer evidence did not map to a published Chunk: ${input.fixture.id}`,
    );
  }
  const returnedRelevant = input.chunks.filter((chunk) =>
    relevant.has(chunk.chunkRevisionId),
  );
  const context = input.chunks.map((chunk) => chunk.text).join("\n");
  const requiredFactCoverage = input.fixture.expectedAnswerable
    ? fraction(
        input.fixture.requiredFacts.filter((fact) => context.includes(fact))
          .length,
        input.fixture.requiredFacts.length,
      )
    : undefined;
  const relevantChunkRecallAtK = input.fixture.expectedAnswerable
    ? fraction(returnedRelevant.length, relevant.size)
    : undefined;
  const firstRelevant = input.chunks.findIndex((chunk) =>
    relevant.has(chunk.chunkRevisionId),
  );
  const reciprocalRank = input.fixture.expectedAnswerable
    ? firstRelevant < 0
      ? 0
      : 1 / (firstRelevant + 1)
    : undefined;
  const ndcgAtK = input.fixture.expectedAnswerable
    ? ndcg(input.chunks, relevant, input.cutoff)
    : undefined;
  return {
    path: input.path,
    chunks: input.chunks,
    candidateCount: input.candidateCount,
    candidateUnit: input.path === "hybrid_rag" ? "chunks" : "cards",
    contextCharacters: input.chunks.reduce(
      (sum, chunk) => sum + chunk.text.length,
      0,
    ),
    latencySamplesMs: input.latencySamplesMs,
    latencyP50Ms: percentile(input.latencySamplesMs, 0.5),
    latencyP95Ms: percentile(input.latencySamplesMs, 0.95),
    ...(requiredFactCoverage === undefined ? {} : { requiredFactCoverage }),
    ...(relevantChunkRecallAtK === undefined
      ? {}
      : { relevantChunkRecallAtK }),
    ...(reciprocalRank === undefined ? {} : { reciprocalRank }),
    ...(ndcgAtK === undefined ? {} : { ndcgAtK }),
    irrelevantContextRatio:
      input.chunks.length === 0
        ? 0
        : (input.chunks.length - returnedRelevant.length) / input.chunks.length,
    rejectedUnanswerable:
      !input.fixture.expectedAnswerable && input.chunks.length === 0,
    ...(input.generation === undefined ? {} : { generation: input.generation }),
  };
}

export function summarize(
  queries: readonly QueryEvaluation[],
): {
  readonly hybridRag: PathSummary;
  readonly contextctl: PathSummary;
  readonly comparison: ComparisonSummary;
} {
  const hybridRag = summarizePath(queries.map((query) => query.hybridRag));
  const contextctl = summarizePath(queries.map((query) => query.contextctl));
  return {
    hybridRag,
    contextctl,
    comparison: {
      contextCharacterReductionRatio: reduction(
        hybridRag.meanContextCharacters,
        contextctl.meanContextCharacters,
      ),
      ...optionalDelta(
        hybridRag.meanPromptTokens,
        contextctl.meanPromptTokens,
        "promptTokenReductionRatio",
        reduction,
      ),
      ...optionalDelta(
        hybridRag.meanRequiredFactCoverage,
        contextctl.meanRequiredFactCoverage,
        "requiredFactCoverageDelta",
      ),
      ...optionalDelta(
        hybridRag.meanRelevantChunkRecallAtK,
        contextctl.meanRelevantChunkRecallAtK,
        "relevantChunkRecallDelta",
      ),
      ...optionalDelta(
        hybridRag.meanReciprocalRank,
        contextctl.meanReciprocalRank,
        "reciprocalRankDelta",
      ),
      ...optionalDelta(
        hybridRag.meanNdcgAtK,
        contextctl.meanNdcgAtK,
        "ndcgDelta",
      ),
      irrelevantContextReduction:
        hybridRag.meanIrrelevantContextRatio -
        contextctl.meanIrrelevantContextRatio,
      unanswerableRejectionDelta:
        contextctl.unanswerableRejectionRate -
        hybridRag.unanswerableRejectionRate,
      latencyP50DeltaMs: contextctl.latencyP50Ms - hybridRag.latencyP50Ms,
      latencyP95DeltaMs: contextctl.latencyP95Ms - hybridRag.latencyP95Ms,
    },
  };
}

export function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) throw new Error("percentile requires samples");
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(0, Math.ceil(quantile * sorted.length) - 1);
  return sorted[rank] as number;
}

export function summarizePath(observations: readonly PathObservation[]): PathSummary {
  const answerable = observations.filter(
    (observation) => observation.requiredFactCoverage !== undefined,
  );
  const unanswerable = observations.filter(
    (observation) => observation.requiredFactCoverage === undefined,
  );
  const promptTokens = observations.flatMap((observation) =>
    observation.generation?.promptTokens === undefined
      ? []
      : [observation.generation.promptTokens],
  );
  const samples = observations.flatMap((observation) =>
    [...observation.latencySamplesMs],
  );
  return {
    answerableQueries: answerable.length,
    unanswerableQueries: unanswerable.length,
    ...meanField(answerable, "requiredFactCoverage", "meanRequiredFactCoverage"),
    ...meanField(
      answerable,
      "relevantChunkRecallAtK",
      "meanRelevantChunkRecallAtK",
    ),
    ...meanField(answerable, "reciprocalRank", "meanReciprocalRank"),
    ...meanField(answerable, "ndcgAtK", "meanNdcgAtK"),
    meanIrrelevantContextRatio: mean(
      observations.map((observation) => observation.irrelevantContextRatio),
    ),
    unanswerableRejectionRate:
      unanswerable.length === 0
        ? 0
        : mean(
            unanswerable.map((observation) =>
              observation.rejectedUnanswerable ? 1 : 0,
            ),
          ),
    meanContextCharacters: mean(
      observations.map((observation) => observation.contextCharacters),
    ),
    ...(promptTokens.length === observations.length
      ? { meanPromptTokens: mean(promptTokens) }
      : {}),
    latencyP50Ms: percentile(samples, 0.5),
    latencyP95Ms: percentile(samples, 0.95),
  };
}

function relevantRevisionIds(
  fixture: QueryFixture,
  chunks: readonly ProductChunk[],
): ReadonlySet<string> {
  return new Set(
    chunks
      .filter((chunk) =>
        fixture.relevantChunkAnchors.some((anchor) =>
          chunk.text.includes(anchor),
        ),
      )
      .map((chunk) => chunk.chunkRevisionId),
  );
}

function ndcg(
  chunks: readonly RetrievedChunk[],
  relevant: ReadonlySet<string>,
  cutoff: number,
): number {
  let dcg = 0;
  for (const [index, chunk] of chunks.entries()) {
    if (relevant.has(chunk.chunkRevisionId)) dcg += 1 / Math.log2(index + 2);
  }
  let ideal = 0;
  const limit = Math.min(cutoff, relevant.size);
  for (let index = 0; index < limit; index += 1) {
    ideal += 1 / Math.log2(index + 2);
  }
  return ideal === 0 ? 0 : dcg / ideal;
}

function meanField<
  K extends
    | "requiredFactCoverage"
    | "relevantChunkRecallAtK"
    | "reciprocalRank"
    | "ndcgAtK",
  O extends string,
>(
  values: readonly PathObservation[],
  key: K,
  output: O,
): { readonly [P in O]?: number } {
  const present = values.flatMap((value) =>
    value[key] === undefined ? [] : [value[key]],
  );
  return present.length === 0
    ? {}
    : ({ [output]: mean(present) } as { [P in O]: number });
}

function optionalDelta<K extends string>(
  baseline: number | undefined,
  product: number | undefined,
  key: K,
  calculate: (baseline: number, product: number) => number = (left, right) =>
    right - left,
): { readonly [P in K]?: number } {
  return baseline === undefined || product === undefined
    ? {}
    : ({ [key]: calculate(baseline, product) } as { [P in K]: number });
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function reduction(baseline: number, product: number): number {
  return baseline === 0 ? 0 : 1 - product / baseline;
}

function fraction(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}
