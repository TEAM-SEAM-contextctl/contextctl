export {
  MarkdownCapture,
  type CaptureMarkdownCommand,
} from "./application/markdown-capture.js";
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
  isMarkdownSourceSnapshot,
  MarkdownFileSourceAdapter,
  type MarkdownFileSourceAdapterOptions,
} from "./infrastructure/markdown-file-source-adapter.js";
export { RemarkMarkdownParser } from "./infrastructure/remark-markdown-parser.js";
export {
  SourceAdapterRegistry,
} from "./infrastructure/source-adapter-registry.js";
export {
  UuidV7BlockIdSource,
  type UuidV7BlockIdSourceOptions,
} from "./infrastructure/uuid-v7-block-id-source.js";
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
