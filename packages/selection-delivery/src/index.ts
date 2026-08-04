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
  EvidenceBudgetInvariantError,
  SelectionCandidateInvariantError,
  SelectionScopeInvariantError,
  SelectionThresholdsInvariantError,
} from "./domain/errors.js";
export {
  assembleDocumentEvidence,
  DEFAULT_EVIDENCE_BUDGET,
  EVIDENCE_ASSEMBLY_POLICY_VERSION,
  type EvidenceBudget,
  type EvidenceChunk,
  type EvidenceOmission,
  type ManagedDocumentEvidence,
} from "./domain/evidence-assembly.js";
export {
  QUERY_SCORING_POLICY_VERSION,
  scoreCardsAgainstQuery,
  type CandidateScore,
  type ScoreSignal,
} from "./domain/query-scoring.js";
export {
  buildRetrievalContracts,
  type ContractSource,
  type HttpRetrievalContract,
  type RetrievalContract,
  type SqlRetrievalContract,
} from "./domain/retrieval-contract.js";
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
  selectContext,
  type DeliveryResult,
  type ScopeRetrievalFailure,
  type SelectContextOptions,
  type SelectContextPorts,
} from "./application/select-context.js";
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
