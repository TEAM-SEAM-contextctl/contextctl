export type {
  ApprovedCard,
  ApprovedCardMeaning,
  ApprovedCardPolicy,
  ApprovedDocumentIndexRef,
  ApprovedDocumentSelection,
  ApprovedHttpParameter,
  ApprovedHttpScope,
  ApprovedManagedDocumentScope,
  ApprovedScope,
  ApprovedScopeReference,
  ApprovedSqlScope,
} from "./domain/card-catalog.js";
export {
  canonicalDigest,
  canonicalJson,
  CANONICAL_DIGEST_PREFIX,
} from "./domain/canonical-digest.js";
export {
  CardCandidateIndex,
  catalogSnapshotVersion,
  cosineSimilarity,
  type CardCandidateRecord,
  type CardSimilarity,
} from "./domain/card-candidate-index.js";
export {
  assertValidCardSelectionProfile,
  cardSelectionProfilesMatch,
  DEFAULT_CARD_ADMISSION_LIMITS,
  isCardSelectionEmbeddingProfile,
  type CardAdmissionLimits,
  type CardEmbeddingExecution,
  type CardSelectionEmbeddingProfile,
  type CardSelectionProfile,
  type LocalCardEmbeddingExecution,
  type RemoteCardEmbeddingExecution,
} from "./domain/card-selection-profile.js";
export {
  buildCardSelectionEntry,
  buildCardSelectionText,
  CARD_SELECTION_TEXT_SCHEMA,
  cardSelectionTextDigest,
  cardSelectionTextPayload,
  normalizeSelectionText,
  type CardSelectionEntry,
  type CardSelectionHttpParameter,
  type CardSelectionScope,
  type CardSelectionTextV1,
} from "./domain/card-selection-text.js";
export {
  assertSelectionScoringPairing,
  combineHybridScore,
  HYBRID_AGREEMENT_BONUS,
  HYBRID_SCORING_POLICY_VERSION,
  rankHybridCandidates,
  scoringPolicyVersionFor,
  SEMANTIC_SIMILARITY_FLOOR,
  semanticScoreFor,
  type HybridCandidateScore,
  type SelectionMode,
  type SelectionScoringPolicyVersion,
} from "./domain/hybrid-ranking.js";
export {
  measureTextUnits,
  TEXT_MEASURE_PROFILE_VERSION,
} from "./domain/text-measure.js";
export type {
  ContextResolution,
  ContextResolutionItem,
  DelegatedFulfillment,
  ManagedFulfillment,
  ManagedFulfillmentFailure,
  ResolutionPolicy,
  RetrievedDocumentChunk,
  RetrievedDocumentContext,
  SelectionCounts,
  SelectionSummary,
} from "./domain/context-resolution.js";
export {
  buildRetrievalGuide,
  retrievalGuideKey,
  type HttpRetrievalGuide,
  type ManagedDocumentGuide,
  type RetrievalGuide,
  type SqlRetrievalGuide,
} from "./domain/retrieval-guide.js";
export {
  CanonicalDigestInvariantError,
  CardCandidateIndexInvariantError,
  CardCatalogInvariantError,
  CardSelectionInputLimitError,
  CardSelectionProfileInvariantError,
  ContextBudgetInvariantError,
  ManagedResolutionInvariantError,
  PolicyContextInvariantError,
  SelectionCandidateInvariantError,
  SelectionModeInvariantError,
  SelectionPlanInvariantError,
  SelectionScopeInvariantError,
  SelectionThresholdsInvariantError,
} from "./domain/errors.js";
// `assembleDocumentContext` and its result are deliberately absent: assembly is
// a step inside `assembleContext`, and exporting it would let a caller
// reassemble a response outside the one place that knows the budget it was
// built under. `ContextChunk` and `ContextCandidate` are absent for the same
// reason — both carry the internal `rank` and `score` a response never shows.
// The vocabulary a resolution is read with does cross.
export {
  CONTEXT_ASSEMBLY_POLICY_VERSION,
  CONTEXT_FUSION_POLICY_VERSION,
  DEFAULT_CONTEXT_BUDGET,
  RRF_RANK_CONSTANT,
  type ContextBudget,
  type ContextOmission,
} from "./domain/context-assembly.js";
export {
  assertOpaqueFailure,
  MANAGED_FAILURE_CODE_PATTERN,
  type ManagedResolutionFailure,
  type ManagedResolutionOutcome,
  type ManagedResolutionStage,
  type ResolvedDocumentChunk,
} from "./domain/managed-resolution.js";
export {
  isManagedPlannedItem,
  managedTargetKey,
  planningLimitViolations,
  planSelectedScopes,
  SELECTION_PLANNING_LIMITS,
  SELECTION_PLANNING_POLICY_VERSION,
  verifySelectionPlan,
  type PlanningLimitViolation,
  type SelectionPlanningLimit,
  type ApprovedCardReference,
  type ManagedDocumentResolutionTarget,
  type PlannedDelegatedItem,
  type PlannedManagedItem,
  type PlannedResolutionItem,
  type SelectedByList,
  type SelectionPlan,
  type SelectionPlanSummary,
  type SelectionPolicySummary,
} from "./domain/selection-plan.js";
export {
  applyPolicyContext,
  assertValidPolicyContext,
  DEFAULT_POLICY_CONTEXT,
  validateCatalogPolicies,
  type PolicyApplication,
  type PolicyContext,
  type PolicyExclusion,
  type PolicyExclusionReason,
} from "./domain/policy-context.js";
export {
  QUERY_SCORING_POLICY_VERSION,
  scoreCardsAgainstQuery,
  type CandidateScore,
  type ScoreSignal,
} from "./domain/query-scoring.js";
export {
  DEFAULT_SELECTION_THRESHOLDS,
  judgeCandidates,
  SELECTION_RANKING_POLICY_VERSION,
  type RankedCandidate,
  type RankingProvenance,
  type ScoredCandidate,
  type SelectionFinding,
  type SelectionOutcome,
  type SelectionResult,
  type SelectionThresholds,
  type SelectionVerdict,
} from "./domain/selection-verdict.js";
export {
  CardEmbeddingUnavailableError,
  EmptyQueryError,
  InvalidContextBudgetError,
  QueryInputLimitExceededError,
  RESOLVE_CONTEXT_ERROR_TABLE,
  resolveContextError,
  resolveContextErrorStatus,
  ResolveContextFailure,
  SelectionPlanLimitExceededError,
  toResolveContextErrorCode,
  type ResolveContextError,
  type ResolveContextErrorCode,
} from "./application/errors.js";
export {
  DEFAULT_CHUNK_LIMIT_PER_SCOPE,
  DEFAULT_LEXICAL_TOP_K,
  DEFAULT_SEMANTIC_TOP_K,
  selectContext,
  type SelectContextOptions,
  type SelectContextPorts,
  type SemanticSelectionPolicy,
  type SemanticSelectionPorts,
} from "./application/select-context.js";
export {
  assembleContext,
  type AssembleContextOptions,
} from "./application/assemble-context.js";
export {
  narrowContextBudget,
  type ResolveContextApplication,
  type ResolveContextRequest,
} from "./application/context-application.js";
export type { ApprovedCardCatalog } from "./ports/approved-card-catalog.js";
export {
  CardEmbeddingFault,
  type CardEmbeddingFaultCode,
  type CardEmbeddingInput,
  type CardEmbeddingOutput,
  type CardEmbeddingPort,
  type CardEmbeddingProviderKind,
  type CardEmbeddingRequest,
} from "./ports/card-embedding.js";
export type {
  CardCandidateIndexRequest,
  CardCandidateIndexStore,
} from "./ports/card-candidate-index-store.js";
export { InMemoryCardCatalog } from "./infrastructure/in-memory-card-catalog.js";
export {
  assertCardEmbeddingProviderKind,
  DeterministicCardEmbeddingAdapter,
} from "./infrastructure/deterministic-card-embedding-adapter.js";
export { InMemoryCardCandidateIndexStore } from "./infrastructure/in-memory-card-candidate-index-store.js";
export {
  createHttpQueryHandler,
  RESOLVE_PATH,
  type DeliveryHttpHandler,
  type DeliveryHttpRequest,
  type DeliveryHttpResponse,
} from "./infrastructure/http/http-query-handler.js";
export { createDeliveryHttpServer } from "./infrastructure/http/node-http-server.js";
export {
  createMcpQueryServer,
  MCP_PROTOCOL_VERSION,
  SELECTION_MCP_TOOL_NAMES,
  type McpQueryServer,
} from "./infrastructure/mcp/mcp-query-server.js";
export { runStdioServer } from "./infrastructure/mcp/stdio-transport.js";
