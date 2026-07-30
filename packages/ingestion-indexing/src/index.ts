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
  SourceAdapterRegistry,
} from "./infrastructure/source-adapter-registry.js";
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
  type SourceObservationAttempt,
  type ValidatedSourceConfiguration,
} from "./ports/source-adapter.js";
