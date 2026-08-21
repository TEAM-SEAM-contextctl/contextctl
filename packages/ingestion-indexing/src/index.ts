export {
  MarkdownCapture,
  type CaptureMarkdownCommand,
} from "./application/markdown-capture.js";
export {
  buildEmptyMarkdownPublication,
  buildMarkdownPublication,
  MarkdownPublicationBuildError,
  type BuildEmptyMarkdownPublicationInput,
  type BuildMarkdownPublicationInput,
  type MarkdownPublicationBuildErrorCode,
} from "./application/build-markdown-publication.js";
export {
  MarkdownPublicationWorkflow,
  MarkdownPublicationWorkflowError,
  DEFAULT_MARKDOWN_OBSERVATION_RETENTION_LEASE_MS,
  type MarkdownPublicationDiagnostic,
  type MarkdownPublicationWorkflowDependencies,
  type MarkdownPublicationWorkflowErrorCode,
  type PublishMarkdownSourceCommand,
  type PublishMarkdownSourceResult,
} from "./application/markdown-publication-workflow.js";
export {
  SourceObservationRetention,
  DEFAULT_SOURCE_OBSERVATION_RETENTION_POLICY,
  type SourceObservationRetentionDependencies,
  type SourceObservationRetentionItem,
  type SourceObservationRetentionPolicy,
  type SourceObservationRetentionReport,
} from "./application/retain-source-observations.js";
export {
  createSourceObservation,
  assertValidSourceObservation,
  SourceObservationValidationError,
  type CreateSourceObservationInput,
  type SourceObservation,
  type SourceObservationPayload,
} from "./domain/source-observation.js";
export {
  SourceManagement,
  SourceManagementError,
  type RegisterSourceCommand,
  type RequestObservationOptions,
  type SourceInspection,
  type SourceManagementDependencies,
  type SourceManagementErrorCode,
  type SourceObservationResult,
} from "./application/source-management.js";
export {
  assembleNormalizedMarkdownDocument,
  BLOCK_LINEAGE_POLICY_VERSION,
  canonicalizeDocumentText,
  DocumentCaptureError,
  MARKDOWN_NORMALIZATION_POLICY_VERSION,
  sha256Digest,
  toAnalysisText,
  type AssembleDocumentInput,
  type BlockIdSource,
  type CandidateDocument,
  type CandidateDocumentBlock,
  type CandidateSourceCoverage,
} from "./domain/document-capture.js";
export {
  generateManagedChunks,
  createManagedChunkRevisionId,
  ManagedChunkGenerationError,
  type GenerateManagedChunksInput,
  type ManagedChunkGenerationErrorCode,
  type ManagedChunkIdSource,
} from "./domain/managed-chunk-generation.js";
export {
  assertValidDocumentIndexingSnapshot,
  decideDocumentCapture,
  documentIndexEquivalenceViolations,
  DocumentIncrementalUpdateError,
  inheritableScopeUnitIds,
  planDocumentIncrementalUpdate,
  type AffectedChunkClosure,
  type DocumentBlockChange,
  type DocumentCaptureDecision,
  type DocumentFullRebuildReason,
  type DocumentIncrementalUpdateErrorCode,
  type DocumentIncrementalUpdateMetrics,
  type DocumentIncrementalUpdateOperations,
  type DocumentIncrementalUpdatePlan,
  type DocumentIndexingSnapshot,
  type DocumentSemanticUnitChange,
  type DocumentSourceChangeSignal,
  type PlanDocumentIncrementalUpdateInput,
  type PlannedChunkRevision,
  type PublishedDocumentContentView,
} from "./domain/document-incremental-update.js";
export {
  EmbeddingPipeline,
  EmbeddingPipelineError,
  DEFAULT_EMBEDDING_PIPELINE_POLICY,
  type ChunkEmbedding,
  type EmbeddingPipelineDependencies,
  type EmbeddingPipelineErrorCode,
  type EmbeddingPipelinePolicy,
  type EmbedManagedChunksCommand,
  type EmbedManagedChunksResult,
  type ReusableChunkEmbedding,
} from "./application/embed-managed-chunks.js";
export {
  DocumentIndexPublisher,
  DocumentIndexPublicationError,
  DEFAULT_INDEX_STAGING_PUBLICATION_LEASE_MS,
  type DocumentIndexPublisherDependencies,
  type DocumentIndexPublicationErrorCode,
  type PublishDocumentIndexCommand,
} from "./application/publish-document-index.js";
export {
  FailedIndexStagingCleanup,
  DEFAULT_FAILED_INDEX_STAGING_CLEANUP_POLICY,
  type FailedIndexStagingCleanupDependencies,
  type FailedIndexStagingCleanupItem,
  type FailedIndexStagingCleanupItemCode,
  type FailedIndexStagingCleanupOutcome,
  type FailedIndexStagingCleanupPolicy,
  type FailedIndexStagingCleanupReport,
} from "./application/cleanup-failed-index-staging.js";
export {
  IncrementalDocumentReindexer,
  ReindexDocumentError,
  type IncrementalDocumentReindexerDependencies,
  type ReindexDocumentCommand,
  type ReindexDocumentErrorCode,
  type ReindexDocumentMetrics,
  type ReindexDocumentResult,
  type PreparedReindexDocumentPublication,
  type VectorReuseDegradation,
} from "./application/reindex-document-incrementally.js";
export {
  ManagedDocumentSearch,
  ManagedDocumentSearchError,
  DEFAULT_MANAGED_SEARCH_CONCURRENCY,
  MAX_MANAGED_SEARCH_BATCH_TARGETS,
  MAX_MANAGED_SEARCH_QUERY_CHARACTERS,
  type BatchManagedDocumentSearchCommand,
  type BatchManagedDocumentSearchItem,
  type BatchManagedDocumentSearchTarget,
  type DocumentSearchHit,
  type ManagedDocumentSearchCommand,
  type ManagedDocumentSearchDependencies,
  type ManagedDocumentSearchErrorCode,
  type ManagedDocumentSearchFailure,
} from "./application/managed-document-search.js";
export {
  PublicationReadyReconciler,
  type PublicationReadyReconciliationItem,
  type ReconcilePublicationReadyDependencies,
} from "./application/reconcile-publication-ready.js";
export {
  createPublishedDocumentScopes,
  PublishedDocumentScopeError,
  type CreatePublishedDocumentScopesInput,
  type PublishedDocumentScopeErrorCode,
  type SemanticPublishedScopeInput,
} from "./application/published-document-scope.js";
export {
  assertValidEmbeddingProfile,
  documentEmbeddingProfileChangeRequiresFullRebuild,
  EMBEDDING_L2_NORM_TOLERANCE,
  embeddingProfilesMatch,
  embeddingVectorMatchesProfile,
  isDocumentRetrievalEmbeddingProfile,
  validateDocumentRetrievalEmbeddingProfile,
  validateEmbeddingProfile,
  type DocumentEmbeddingExecution,
  type DocumentRetrievalEmbeddingProfile,
  type EmbeddingDistance,
  type EmbeddingProfile,
  type LocalDocumentEmbeddingExecution,
  type RemoteDocumentEmbeddingExecution,
} from "./domain/embedding-profile.js";
export {
  type ChunkSourceSlice,
  type DocumentSemanticUnit,
  type ManagedChunk,
  type SegmentationDiagnostic,
  type SemanticBoundary,
  type BlockStructure,
  type CodeStructure,
  type DividerStructure,
  type DocumentBlock,
  type DocumentMediaType,
  type HeadingStructure,
  type ListItemStructure,
  type NormalizedDocument,
  type PageBreakStructure,
  type ParagraphStructure,
  type ParserDiagnostic,
  type PdfBoundingBox,
  type PdfSourceSpan,
  type QuoteStructure,
  type TableStructure,
  type TextSourceSpan,
} from "./domain/document-model.js";
export {
  DocumentSegmentationError,
  segmentNormalizedDocument,
  type DocumentSegmentationErrorCode,
  type SegmentNormalizedDocumentInput,
  type SemanticUnitIdSource,
} from "./domain/document-segmentation.js";
export {
  reconcileSemanticUnitLineage,
  SemanticUnitLineageError,
  type ReconcileSemanticUnitLineageInput,
  type SemanticUnitLineageDecision,
  type SemanticUnitLineageErrorCode,
  type SemanticUnitLineageResult,
} from "./domain/semantic-unit-lineage.js";
export {
  canonicalizeDocumentIndexingPolicy,
  CHUNK_POLICY_VERSION,
  DEFAULT_CHUNK_POLICY,
  DEFAULT_DOCUMENT_INDEXING_POLICY,
  DEFAULT_LINEAGE_POLICY,
  DEFAULT_SEGMENTATION_POLICY,
  DEFAULT_TEXT_MEASURE_PROFILE,
  digestDocumentIndexingPolicy,
  DocumentIndexingPolicyValidationError,
  LINEAGE_POLICY_VERSION,
  measureText,
  parseDocumentIndexingPolicy,
  SEGMENTATION_POLICY_VERSION,
  TEXT_MEASURE_ALGORITHM,
  TEXT_MEASURE_PROFILE_VERSION,
  validateDocumentIndexingPolicy,
  type ChunkPolicy,
  type DocumentIndexingPolicyIssue,
  type DocumentIndexingPolicySet,
  type LineagePolicy,
  type SegmentationPolicy,
  type TextMeasureProfile,
} from "./domain/document-indexing-policy.js";
export {
  isMarkdownSourceSnapshot,
  MarkdownFileSourceAdapter,
  type MarkdownFileSourceAdapterOptions,
} from "./infrastructure/markdown-file-source-adapter.js";
export {
  DeterministicEmbeddingAdapter,
} from "./infrastructure/deterministic-embedding-adapter.js";
export {
  UuidV7StructuralIdGenerator,
  type StructuralIdGenerator,
  type UuidV7StructuralIdGeneratorOptions,
} from "./infrastructure/uuid-v7-structural-id-generator.js";
export {
  InMemoryVectorIndexAdapter,
} from "./infrastructure/in-memory-vector-index-adapter.js";
export {
  InMemoryIndexPublicationStore,
} from "./infrastructure/in-memory-index-publication-store.js";
export {
  InMemoryIndexStagingAttemptStore,
} from "./infrastructure/in-memory-index-staging-attempt-store.js";
export {
  InMemoryIngestionPublicationStore,
} from "./infrastructure/in-memory-ingestion-publication-store.js";
export {
  InMemoryMarkdownPublicationCheckpointStore,
} from "./infrastructure/in-memory-markdown-publication-checkpoint-store.js";
export {
  InMemoryMarkdownPublicationEventSink,
} from "./infrastructure/in-memory-markdown-publication-event-sink.js";
export {
  InMemoryPublicationReadyNotifier,
} from "./infrastructure/in-memory-publication-ready-notifier.js";
export {
  InMemorySourceObservationStore,
} from "./infrastructure/in-memory-source-observation-store.js";
export {
  INGESTION_DATABASE_APPLICATION_ID,
  INGESTION_DATABASE_SCHEMA_VERSION,
  IngestionDatabaseSchemaError,
  openIngestionDatabase,
  type IngestionDatabaseSchemaErrorCode,
} from "./infrastructure/sqlite-ingestion-database.js";
export {
  SqliteIndexPublicationStore,
} from "./infrastructure/sqlite-index-publication-store.js";
export {
  SqliteIndexStagingAttemptStore,
} from "./infrastructure/sqlite-index-staging-attempt-store.js";
export {
  IngestionPublicationStoreCorrupt,
  IngestionPublicationStoreUnavailable,
  SqliteIngestionPublicationStore,
} from "./infrastructure/sqlite-ingestion-publication-store.js";
export {
  MarkdownPublicationCheckpointStoreUnavailable,
  SqliteMarkdownPublicationCheckpointStore,
} from "./infrastructure/sqlite-markdown-publication-checkpoint-store.js";
export {
  SqliteSourceObservationStore,
} from "./infrastructure/sqlite-source-observation-store.js";
export {
  StaticQueryEmbeddingProviderRegistry,
  StaticVectorIndexConnectorRegistry,
  type QueryEmbeddingProviderRegistration,
  type VectorIndexConnectorRegistration,
} from "./infrastructure/static-managed-search-registries.js";
export {
  createLocalMarkdownPublicationRuntime,
  type LocalMarkdownPublicationRuntime,
  type LocalMarkdownPublicationRuntimeOptions,
} from "./infrastructure/local-markdown-publication-runtime.js";
export {
  OpenAiCompatibleEmbeddingAdapter,
  type OpenAiCompatibleEmbeddingAdapterOptions,
} from "./infrastructure/openai-compatible-embedding-adapter.js";
export {
  assertProductionEmbeddingProvider,
  DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
  DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST,
  DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST_SHA256,
  LOCAL_EMBEDDING_ASSET_MANIFEST_FILE,
  serializeLocalEmbeddingAssetManifest,
  TransformersJsLocalEmbeddingAdapter,
  verifyLocalEmbeddingAssets,
  type LocalEmbeddingAssetFile,
  type LocalEmbeddingAssetManifest,
  type LocalFeatureExtractionRuntime,
  type LocalFeatureExtractionRuntimeFactory,
  type TransformersJsLocalEmbeddingAdapterOptions,
} from "./infrastructure/transformers-js-local-embedding-adapter.js";
export {
  DirectoryLocalEmbeddingAssetSource,
  installLocalEmbeddingAssets,
  LOCAL_EMBEDDING_ACTIVE_POINTER_FILE,
  resolveActiveLocalEmbeddingAssets,
  type InstallLocalEmbeddingAssetsInput,
  type InstallLocalEmbeddingAssetsResult,
  type LocalEmbeddingAssetSource,
} from "./infrastructure/local-embedding-asset-installation.js";
export {
  QdrantVectorIndexAdapter,
  type QdrantVectorIndexAdapterOptions,
} from "./infrastructure/qdrant-vector-index-adapter.js";
export { RemarkMarkdownParser } from "./infrastructure/remark-markdown-parser.js";
export {
  SourceAdapterRegistry,
} from "./infrastructure/source-adapter-registry.js";
export {
  UuidV7BlockIdSource,
  type UuidV7BlockIdSourceOptions,
} from "./infrastructure/uuid-v7-block-id-source.js";
export {
  UuidSourceIdGenerator,
  type UuidSourceIdGeneratorOptions,
} from "./infrastructure/uuid-source-id-generator.js";
export {
  UuidV7RootIdGenerator,
  type UuidV7RootIdGeneratorOptions,
} from "./infrastructure/uuid-v7-root-id-generator.js";
export {
  type KnowledgeSource,
  type ObservationCapability,
  type SourceDiagnostic,
  type SourceExecutionStatus,
  type SourceInspectionStatus,
  type SourceLifecycleStatus,
  type SourcePollingPolicy,
} from "./domain/knowledge-source.js";
export {
  type MarkdownCaptureDependencies,
  type MarkdownDocumentParser,
  type MarkdownSourceSnapshot,
} from "./ports/document-capture.js";
export {
  EmbeddingProviderFault,
  type EmbeddingPort,
  type EmbeddingProviderKind,
  type EmbeddingProviderFaultCode,
  type EmbeddingProviderInput,
  type EmbeddingProviderOutput,
  type EmbeddingProviderRequest,
} from "./ports/embedding.js";
export {
  MAX_VECTOR_SEARCH_LIMIT,
  MAX_VECTOR_VECTOR_READ,
  VectorIndexFault,
  type PreparedVectorIndex,
  type RehydratedVectorIndex,
  type VectorIndexCompatibility,
  type VectorIndexFaultCode,
  type VectorIndexPort,
  type VectorIndexRetentionLease,
  type VectorIndexScope,
  type VectorIndexSearchHit,
  type VectorIndexStoredRecord,
  type VectorIndexStoredVector,
} from "./ports/vector-index.js";
export {
  createVectorRecordId,
} from "./domain/vector-index.js";
export {
  computeRecordSetDigest,
  createDocumentIndexId,
  createIndexChunkBindings,
  createIndexVersion,
  type IndexChunkBinding,
  type IndexManifest,
  type ScopeRevision,
  type VectorIndexRecord,
  type VectorIndexRecordMetadata,
} from "./domain/index-manifest.js";
export {
  IndexCatalogFault,
  IndexPublicationStoreConflict,
  type IndexCatalogFaultCode,
  type CommitIndexPublicationResult,
  type IndexPublicationStore,
  type PublishedIndexVersion,
  type PublishedScopeCatalogEntry,
} from "./ports/index-publication-store.js";
export {
  IndexStagingAttemptStoreConflict,
  IndexStagingAttemptStoreUnavailable,
  type AcquireIndexStagingPublicationInput,
  type AcquireIndexStagingPublicationResult,
  type ClaimIndexStagingCleanupInput,
  type IndexStagingAttempt,
  type IndexStagingAttemptKey,
  type IndexStagingAttemptState,
  type IndexStagingAttemptStore,
  type IndexStagingLeaseInput,
  type RenewIndexStagingCleanupInput,
  type RenewIndexStagingPublicationInput,
} from "./ports/index-staging-attempt.js";
export {
  IngestionPublicationCommitIncomplete,
  IngestionPublicationStoreConflict,
  MAX_PUBLICATION_READY_BATCH_SIZE,
  MarkdownPublicationCheckpointConflict,
  type ClaimedPublicationReady,
  type ClaimPublicationReadyBatchInput,
  type CommitIngestionPublicationResult,
  type CompletePublicationReadyDeliveryInput,
  type IngestionPublicationStore,
  type MarkdownPublicationCheckpoint,
  type MarkdownPublicationCheckpointStore,
  type MarkdownPublicationEventSink,
  type MarkdownPublicationStage,
  type MarkdownPublicationStageEvent,
  type MarkdownPublicationStageStatus,
  type PreparePublicationRecoveryIntentResult,
  type PublicationRecoveryIntent,
  type PublicationRecoveryIntentState,
  type PublicationRootIdGenerator,
  type PublicationReadyNotifier,
  type RegisterMarkdownCheckpointResult,
  type ReschedulePublicationReadyDeliveryInput,
} from "./ports/markdown-publication.js";
export {
  type QueryEmbeddingProviderBinding,
  type QueryEmbeddingProviderResolver,
  type VectorIndexConnectorResolver,
} from "./ports/managed-document-search.js";
export {
  SourceObservationStoreConflict,
  SourceObservationStoreUnavailable,
  type CommitSourceObservationInput,
  type CommitSourceObservationResult,
  type DeleteSourceObservationResult,
  type SourceObservationRetentionCandidateInput,
  type SourceObservationRetentionLease,
  type SourceObservationStore,
} from "./ports/source-observation.js";
export {
  SourceAdapterFault,
  type CredentialResolver,
  type ProbedObservationCapability,
  type SourceAdapter,
  type SourceAdapterContext,
  type SourceAdapterFaultCode,
  type SourceAdapterResolver,
  type SourceChangeSignal,
  type SourceConfigurationResolver,
  type SourceIdGenerator,
  type SourceRootIdGenerator,
  type ObservedSourceChangeSignal,
  type SourceObservationAttempt,
  type ValidatedSourceConfiguration,
} from "./ports/source-adapter.js";
