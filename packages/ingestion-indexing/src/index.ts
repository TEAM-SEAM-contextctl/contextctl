export {
  MarkdownCapture,
  type CaptureMarkdownCommand,
} from "./application/markdown-capture.js";
export {
  buildMarkdownPublication,
  type BuildMarkdownPublicationInput,
} from "./application/build-markdown-publication.js";
export {
  MarkdownPublicationWorkflow,
  MarkdownPublicationWorkflowError,
  type MarkdownPublicationDiagnostic,
  type MarkdownPublicationWorkflowDependencies,
  type MarkdownPublicationWorkflowErrorCode,
  type PublishMarkdownSourceCommand,
  type PublishMarkdownSourceResult,
} from "./application/markdown-publication-workflow.js";
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
  ManagedChunkGenerationError,
  type GenerateManagedChunksInput,
  type ManagedChunkGenerationErrorCode,
  type ManagedChunkIdSource,
} from "./domain/managed-chunk-generation.js";
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
  type DocumentIndexPublisherDependencies,
  type DocumentIndexPublicationErrorCode,
  type PublishDocumentIndexCommand,
} from "./application/publish-document-index.js";
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
  embeddingProfilesMatch,
  validateEmbeddingProfile,
  type EmbeddingDistance,
  type EmbeddingProfile,
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
  InMemoryVectorIndexAdapter,
} from "./infrastructure/in-memory-vector-index-adapter.js";
export {
  InMemoryIndexPublicationStore,
} from "./infrastructure/in-memory-index-publication-store.js";
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
  INGESTION_DATABASE_SCHEMA_VERSION,
  IngestionDatabaseSchemaError,
  openIngestionDatabase,
  type IngestionDatabaseSchemaErrorCode,
} from "./infrastructure/sqlite-ingestion-database.js";
export {
  SqliteIndexPublicationStore,
} from "./infrastructure/sqlite-index-publication-store.js";
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
  type EmbeddingProviderFaultCode,
  type EmbeddingProviderInput,
  type EmbeddingProviderOutput,
  type EmbeddingProviderRequest,
} from "./ports/embedding.js";
export {
  MAX_VECTOR_SEARCH_LIMIT,
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
} from "./ports/vector-index.js";
export {
  createVectorRecordId,
} from "./domain/vector-index.js";
export {
  computeRecordSetDigest,
  createDocumentIndexId,
  createIndexVersion,
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
} from "./ports/index-publication-store.js";
export {
  IngestionPublicationStoreConflict,
  MarkdownPublicationCheckpointConflict,
  type CommitIngestionPublicationResult,
  type IngestionPublicationStore,
  type MarkdownPublicationCheckpoint,
  type MarkdownPublicationCheckpointStore,
  type MarkdownPublicationEventSink,
  type MarkdownPublicationStage,
  type MarkdownPublicationStageEvent,
  type MarkdownPublicationStageStatus,
  type PublicationReadyNotifier,
  type RegisterMarkdownCheckpointResult,
} from "./ports/markdown-publication.js";
export {
  type QueryEmbeddingProviderBinding,
  type QueryEmbeddingProviderResolver,
  type VectorIndexConnectorResolver,
} from "./ports/managed-document-search.js";
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
  type ObservedSourceChangeSignal,
  type SourceObservationAttempt,
  type ValidatedSourceConfiguration,
} from "./ports/source-adapter.js";
