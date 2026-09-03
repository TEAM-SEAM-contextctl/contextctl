import type { ContextResolution } from "@contextctl/selection-delivery";

export type EvaluationSplit = "development" | "holdout" | "shadow";

export type SelectionExpectationKind =
  | "answerable"
  | "close_unanswerable"
  | "legacy_unclassified_unanswerable"
  | "unrelated"
  | "forbidden";

export interface SelectionExpectation {
  readonly kind: SelectionExpectationKind;
  readonly allowedCardDescriptions: readonly string[];
}

export interface QueryFixture {
  readonly id: string;
  readonly category: string;
  readonly query: string;
  readonly expectedAnswerable: boolean;
  readonly requiredFacts: readonly string[];
  readonly relevantChunkAnchors: readonly string[];
  readonly selectionExpectation: SelectionExpectation;
}

export interface EvaluationDataset {
  readonly split: EvaluationSplit;
  readonly sealedAt?: string;
  readonly queries: readonly QueryFixture[];
  readonly sha256: string;
  readonly frozenPolicyDigest?: string;
  readonly frozenPolicySourceSha256?: string;
}

export interface ProductChunk {
  readonly chunkId: string;
  readonly chunkRevisionId: string;
  readonly semanticUnitId: string;
  readonly documentId: string;
  readonly text: string;
  readonly vector: readonly number[];
}

export interface RetrievedChunk extends ProductChunk {
  readonly score: number;
  readonly scoreKind: "rrf" | "product";
}

export interface GenerationConfiguration {
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey: string;
}

export interface GenerationObservation {
  readonly answer: string;
  readonly latencyMs: number;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
}

export interface PathObservation {
  readonly path: "hybrid_rag" | "contextctl" | "selection_candidate";
  readonly chunks: readonly RetrievedChunk[];
  readonly candidateCount: number;
  readonly candidateUnit: "cards" | "chunks";
  readonly contextCharacters: number;
  readonly latencySamplesMs: readonly number[];
  readonly latencyP50Ms: number;
  readonly latencyP95Ms: number;
  readonly requiredFactCoverage?: number;
  readonly relevantChunkRecallAtK?: number;
  readonly reciprocalRank?: number;
  readonly ndcgAtK?: number;
  readonly irrelevantContextRatio: number;
  readonly rejectedUnanswerable: boolean;
  readonly generation?: GenerationObservation;
}

export interface QueryEvaluation {
  readonly fixture: QueryFixture;
  readonly hybridRag: PathObservation;
  readonly contextctl: PathObservation;
  readonly contextctlResolution: ContextResolution;
}

export interface PathSummary {
  readonly answerableQueries: number;
  readonly unanswerableQueries: number;
  readonly meanRequiredFactCoverage?: number;
  readonly meanRelevantChunkRecallAtK?: number;
  readonly meanReciprocalRank?: number;
  readonly meanNdcgAtK?: number;
  readonly meanIrrelevantContextRatio: number;
  readonly unanswerableRejectionRate: number;
  readonly meanContextCharacters: number;
  readonly meanPromptTokens?: number;
  readonly latencyP50Ms: number;
  readonly latencyP95Ms: number;
}

export interface ComparisonSummary {
  readonly contextCharacterReductionRatio: number;
  readonly promptTokenReductionRatio?: number;
  readonly requiredFactCoverageDelta?: number;
  readonly relevantChunkRecallDelta?: number;
  readonly reciprocalRankDelta?: number;
  readonly ndcgDelta?: number;
  readonly irrelevantContextReduction: number;
  readonly unanswerableRejectionDelta: number;
  readonly latencyP50DeltaMs: number;
  readonly latencyP95DeltaMs: number;
}

export interface EvaluationResult {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly experiment: "contextctl-utility-evaluation-v1";
  readonly commit: string;
  readonly contextctlVersion: string;
  readonly dataset: {
    readonly split: EvaluationSplit;
    readonly sha256: string;
    readonly queryCount: number;
    readonly sealedAt?: string;
    readonly frozenPolicyDigest?: string;
    readonly frozenPolicySourceSha256?: string;
  };
  readonly environment: {
    readonly node: string;
    readonly npm: string;
    readonly platform: string;
    readonly architecture: string;
    readonly qdrantUrl: string;
    readonly qdrantVersion: string;
    readonly stateNamespaceId: string;
    readonly securityDomain: string;
  };
  readonly configuration: {
    readonly repetitions: number;
    readonly topK: number;
    readonly prefetchK: number;
    readonly maxContextCharacters: number;
    readonly rrfRankConstant: number;
    readonly generationEnabled: boolean;
    readonly promptTokenUsageComplete: boolean;
    readonly documentEmbeddingProfileId: string;
    readonly cardSelectionEmbeddingProfileId: string;
    readonly selectionScoringPolicy: string;
    readonly selectionRankingPolicy: string;
    readonly selectionPlanningPolicy: string;
    readonly baselinePolicy: "global-bm25+qdrant-dense+rrf-v1";
    readonly contextctlCommandSource: "workspace" | "external";
  };
  readonly corpus: {
    readonly documents: number;
    readonly chunks: number;
    readonly vectorDimensions: number;
    readonly sha256: string;
  };
  readonly queries: readonly QueryEvaluation[];
  readonly summary: {
    readonly hybridRag: PathSummary;
    readonly contextctl: PathSummary;
    readonly comparison: ComparisonSummary;
  };
  readonly warnings: readonly string[];
}
