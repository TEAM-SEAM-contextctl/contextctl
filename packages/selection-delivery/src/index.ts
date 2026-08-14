export type {
  ApprovedCard,
  ApprovedCardMeaning,
  ApprovedCardPolicy,
  ApprovedDocumentIndexRef,
  ApprovedDocumentSelection,
  ApprovedHttpScope,
  ApprovedManagedDocumentScope,
  ApprovedScope,
  ApprovedScopeReference,
  ApprovedSqlScope,
} from "./domain/card-catalog.js";
export {
  buildRetrievalGuide,
  type ContextResolution,
  type HttpRetrievalGuide,
  type ManagedDocumentGuide,
  type ResolutionFaultCode,
  type ResolutionItem,
  type ResolutionPolicy,
  type RetrievalGuide,
  type RetrievedDocumentContext,
  type SqlRetrievalGuide,
} from "./domain/context-resolution.js";
export {
  EvidenceBudgetInvariantError,
  SelectionCandidateInvariantError,
  SelectionScopeInvariantError,
  SelectionThresholdsInvariantError,
} from "./domain/errors.js";
// `assembleDocumentEvidence` and its result are deliberately absent: assembly
// is a step inside `resolveContext`, and exporting it would let a caller
// reassemble evidence outside the one place that knows the budget the response
// was built under. The vocabulary a resolution is read with does cross.
export {
  DEFAULT_EVIDENCE_BUDGET,
  EVIDENCE_ASSEMBLY_POLICY_VERSION,
  type EvidenceBudget,
  type EvidenceChunk,
  type EvidenceOmission,
} from "./domain/evidence-assembly.js";
export {
  buildFulfillmentTarget,
  type ManagedDocumentFulfillmentTarget,
} from "./domain/fulfillment-target.js";
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
export { EmptyQueryError } from "./application/errors.js";
export {
  resolveContext,
  type ResolveContextOptions,
  type ResolveContextPorts,
} from "./application/resolve-context.js";
export type { ApprovedCardCatalog } from "./ports/approved-card-catalog.js";
export {
  DocumentRetrievalFault,
  type DocumentChunkQuery,
  type DocumentRetrievalFaultCode,
  type ManagedDocumentRetriever,
  type RetrievedChunk,
} from "./ports/managed-document-retriever.js";
export {
  FixtureDocumentRetriever,
  type FixtureChunk,
} from "./infrastructure/fixture-document-retriever.js";
export { InMemoryCardCatalog } from "./infrastructure/in-memory-card-catalog.js";
export {
  createHttpQueryHandler,
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
