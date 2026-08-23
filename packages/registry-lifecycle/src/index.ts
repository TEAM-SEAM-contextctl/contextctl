export {
  createContextCard,
  isCardApproved,
  withCardMeaning,
  withCardVersions,
  type CardMeaning,
  type CardMeaningOrigin,
  type CardPolicy,
  type ContextCard,
} from "./domain/context-card.js";
export {
  appendCardVersion,
  compareCardVersionMeaning,
  createCardVersionHistory,
  getCurrentCardVersion,
  precedesCurrentCardVersion,
  promoteCardVersion,
  withdrawCurrentVersion,
  type CardId,
  type CardValidationState,
  type CardVersion,
  type CardVersionHistory,
  type CardVersionId,
  type MeaningChangeComparison,
} from "./domain/card-version.js";
export {
  checkCatalogSnapshotLimits,
  computeCatalogSnapshotVersion,
  toApprovedCardCatalogSnapshot,
  toCardCatalogEntry,
  type ApprovedCardCatalogSnapshot,
  type CardCatalogEntry,
} from "./domain/card-catalog.js";
export {
  CONSUMPTION_DIAGNOSTIC_CODE_PATTERN,
  locateInChain,
  type ChainCursor,
  type ChainLink,
  type ChainPosition,
  type ConsumptionDiagnostic,
  type ConsumptionDiagnosticCode,
} from "./domain/publication-chain.js";
export {
  judgeSourceProcessingLag,
  stalePendingRegistryScopes,
  STALE_PENDING_REGISTRY_MS,
  type SourceConsumptionSighting,
  type SourceCheckpoint,
  type SourceFreshnessLag,
  type SourceProcessingLag,
} from "./domain/processing-lag.js";
export {
  collectScopeObservations,
  judgeScopeReachability,
  reachabilityGateViolations,
  summarizeScopeReachability,
  toScopeDecisions,
  type ReachabilityGateViolation,
  type ReachabilityReport,
  type ScopeCarrier,
  type ScopeDecision,
  type ScopeObservation,
  type ScopeReachability,
  type ScopeReachabilityState,
  type ScopeSighting,
} from "./domain/scope-reachability.js";
export {
  CardVersionInvariantError,
  ScopeReachabilityInvariantError,
} from "./domain/errors.js";
export type { CardLineage } from "./domain/lineage.js";
export {
  translatePublishedScope,
  type DocumentIndexRef,
  type HttpParameterRef,
  type HttpSourceScope,
  type ManagedDocumentScope,
  type ManagedDocumentSelection,
  type RetrievalScope,
  type RetrievalScopeReference,
  type SqlSourceScope,
} from "./domain/retrieval-scope.js";
export {
  groundCardVersion,
  type FactCoverage,
  type GroundingFinding,
  type GroundingInput,
  type GroundingReport,
  type GroundingVerdict,
} from "./domain/fact-grounding.js";
export {
  analyzeCardImpact,
  type CardImpact,
  type CardImpactDecision,
  type CardImpactReason,
} from "./domain/card-impact.js";
export {
  lifecycleEventsForCard,
  recordLifecycleEvent,
  type CardImpactAssessedEvent,
  type CardVersionAddedEvent,
  type CardVersionPromotedEvent,
  type CardVersionRefusedEvent,
  type CardWithdrawnEvent,
  type LifecycleEvent,
  type LifecycleEventId,
} from "./domain/lifecycle-event.js";
export {
  claimPublication,
  type ClaimedCardVersion,
  type ClaimPublicationPorts,
  type ClaimPublicationResult,
} from "./application/claim-publication.js";
export {
  intakePublication,
  type IntakePublicationOptions,
  type IntakePublicationPorts,
} from "./application/intake-publication.js";
export {
  assessPublicationImpact,
  type AssessPublicationImpactPorts,
  type PublicationImpactAssessment,
} from "./application/assess-publication-impact.js";
export {
  buildReachabilityReport,
  type BuildReachabilityReportPorts,
} from "./application/build-reachability-report.js";
export {
  approveCardVersion,
  disableCard,
  rejectCardVersion,
  rollbackCardVersion,
  type CardDecisionPorts,
  type OperatorDecision,
} from "./application/approve-card-version.js";
export {
  CardNotFoundError,
  PublicationNotFoundError,
} from "./application/errors.js";
export type {
  CardMeaningGenerator,
  CardMeaningRequest,
} from "./ports/card-meaning-generator.js";
export type { CardStore } from "./ports/card-store.js";
export type { Clock } from "./ports/clock.js";
export type { ConsumerCheckpointStore } from "./ports/consumer-checkpoint-store.js";
export type { IdGenerator } from "./ports/id-generator.js";
export type {
  IntakeStore,
  IntakenCard,
  PublicationIntake,
} from "./ports/intake-store.js";
export type { LifecycleEventStore } from "./ports/lifecycle-event-store.js";
export type {
  PublicationRepository,
  SourcePublicationFeed,
} from "./ports/publication-repository.js";
export type { ScopeReachabilityStore } from "./ports/scope-reachability-store.js";
export {
  runOperatorCommand,
  type OperatorCommandPorts,
  type OperatorCommandResult,
} from "./infrastructure/cli/operator-command.js";
export { DeterministicCardMeaningGenerator } from "./infrastructure/deterministic-card-meaning-generator.js";
export {
  FallbackCardMeaningGenerator,
  type CardMeaningFallbackReport,
} from "./infrastructure/llm/fallback-card-meaning-generator.js";
export {
  CardMeaningGenerationError,
  OpenAiCompatibleCardMeaningGenerator,
  type CardMeaningFailureKind,
  type OpenAiCompatibleGeneratorConfig,
} from "./infrastructure/llm/openai-compatible-card-meaning-generator.js";
export {
  openRegistryDatabase,
  RegistryDatabaseIdentityError,
  REGISTRY_DATABASE_APPLICATION_ID,
  type RegistryDatabaseIdentityErrorCode,
} from "./infrastructure/sqlite/registry-database.js";
export { SqliteCardStore } from "./infrastructure/sqlite/sqlite-card-store.js";
export { SqliteConsumerCheckpointStore } from "./infrastructure/sqlite/sqlite-consumer-checkpoint-store.js";
export { SqliteIntakeStore } from "./infrastructure/sqlite/sqlite-intake-store.js";
export { SqliteLifecycleEventStore } from "./infrastructure/sqlite/sqlite-lifecycle-event-store.js";
export { SqliteScopeReachabilityStore } from "./infrastructure/sqlite/sqlite-scope-reachability-store.js";
