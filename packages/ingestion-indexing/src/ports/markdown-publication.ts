import type {
  IngestionPublication,
  PublicationReady,
} from "@contextctl/contracts";

import type {
  DocumentSemanticUnit,
  NormalizedDocument,
} from "../domain/document-model.js";
import type { DocumentIndexingSnapshot } from "../domain/document-incremental-update.js";
import type { KnowledgeSource } from "../domain/knowledge-source.js";

export type MarkdownPublicationStage =
  | "registration"
  | "inspection"
  | "observation"
  | "capture"
  | "segmentation"
  | "chunking"
  | "index_update"
  | "ingestion_publication";

export type MarkdownPublicationStageStatus =
  | "started"
  | "completed"
  | "skipped"
  | "failed";

export interface MarkdownPublicationStageEvent {
  readonly occurredAt: string;
  readonly operationId: string;
  readonly stage: MarkdownPublicationStage;
  readonly status: MarkdownPublicationStageStatus;
  readonly sourceId?: string;
  readonly observationId?: string;
  readonly indexVersion?: string;
  readonly diagnosticCode?: string;
}

/** Receives bounded structured events; raw source and query text are forbidden. */
export interface MarkdownPublicationEventSink {
  record(event: MarkdownPublicationStageEvent): void;
}

export interface MarkdownPublicationCheckpoint {
  readonly source: KnowledgeSource;
  readonly documentId: string;
  /** Observation whose derived snapshot is the incremental comparison baseline. */
  readonly observationId?: string;
  readonly previousChangeToken?: string;
  readonly document?: NormalizedDocument;
  readonly semanticUnits?: readonly DocumentSemanticUnit[];
  /** Complete durable baseline used by incremental re-indexing. */
  readonly indexingSnapshot?: DocumentIndexingSnapshot;
}

export interface RegisterMarkdownCheckpointResult {
  readonly status: "existing" | "registered";
  readonly checkpoint: MarkdownPublicationCheckpoint;
}

/** Checkpoint boundary; production compositions bind a durable adapter. */
export interface MarkdownPublicationCheckpointStore {
  register(
    source: KnowledgeSource,
    documentId: string,
  ): Promise<RegisterMarkdownCheckpointResult>;
  save(checkpoint: MarkdownPublicationCheckpoint): Promise<void>;
  findBySourceId(
    sourceId: string,
  ): Promise<MarkdownPublicationCheckpoint | undefined>;
}

export interface PublicationRootIdGenerator {
  nextDocumentId(): string;
  nextPublicationId(): string;
}

export interface CommitIngestionPublicationResult {
  readonly status: "already_published" | "published";
  readonly publication: IngestionPublication;
}

export type PublicationRecoveryIntentState = "committed" | "pending";

/**
 * Durable, byte-stable intent captured before the first external Index Catalog
 * binding commit. The canonical payload is retained for conflict detection and
 * recovery; callers must commit the exact stored Publication.
 */
export interface PublicationRecoveryIntent {
  readonly publication: IngestionPublication;
  readonly canonicalPayload: string;
  readonly state: PublicationRecoveryIntentState;
}

export interface PreparePublicationRecoveryIntentResult {
  readonly status: "already_prepared" | "prepared";
  readonly intent: PublicationRecoveryIntent;
}

export const MAX_PUBLICATION_READY_BATCH_SIZE = 100;

export interface ClaimPublicationReadyBatchInput {
  readonly ownerId: string;
  readonly now: string;
  readonly leaseDurationMs: number;
  readonly limit: number;
}

export interface ClaimedPublicationReady extends PublicationReady {
  readonly ownerId: string;
  readonly ownerExpiresAt: string;
  /** One-based delivery attempt count after this claim. */
  readonly attemptCount: number;
}

export interface CompletePublicationReadyDeliveryInput {
  readonly publicationId: string;
  readonly ownerId: string;
  readonly deliveredAt: string;
}

export interface ReschedulePublicationReadyDeliveryInput {
  readonly publicationId: string;
  readonly ownerId: string;
  readonly nextAttemptAt: string;
  readonly diagnosticCode: string;
}

/**
 * Stores immutable Publications and a ready-notification outbox together.
 * There is deliberately no purge operation before Registry acknowledgement.
 */
export interface IngestionPublicationStore {
  prepareRecoveryIntent(
    publication: IngestionPublication,
  ): Promise<PreparePublicationRecoveryIntentResult>;
  findRecoveryIntent(
    publicationId: string,
  ): Promise<PublicationRecoveryIntent | undefined>;
  pendingRecoveryIntentForSource(
    sourceId: string,
  ): Promise<PublicationRecoveryIntent | undefined>;
  commitReady(
    publication: IngestionPublication,
  ): Promise<CommitIngestionPublicationResult>;
  find(publicationId: string): Promise<IngestionPublication | undefined>;
  latestForSource(
    sourceId: string,
  ): Promise<IngestionPublication | undefined>;
  claimReadyBatch(
    input: ClaimPublicationReadyBatchInput,
  ): Promise<readonly ClaimedPublicationReady[]>;
  completeReadyDelivery(
    input: CompletePublicationReadyDeliveryInput,
  ): Promise<void>;
  rescheduleReadyDelivery(
    input: ReschedulePublicationReadyDeliveryInput,
  ): Promise<void>;
}

export interface PublicationReadyNotifier {
  notify(notification: PublicationReady): Promise<void>;
}

export class IngestionPublicationStoreConflict extends Error {
  readonly code = "publication_conflict";

  constructor() {
    super("Ingestion Publication store rejected conflicting immutable content");
    this.name = "IngestionPublicationStoreConflict";
  }
}

export class IngestionPublicationCommitIncomplete extends Error {
  readonly code = "publication_commit_incomplete";

  constructor() {
    super("Ingestion Publication has no durable recovery intent");
    this.name = "IngestionPublicationCommitIncomplete";
  }
}

export class MarkdownPublicationCheckpointConflict extends Error {
  readonly code = "checkpoint_conflict";

  constructor() {
    super("Markdown publication checkpoint is inconsistent");
    this.name = "MarkdownPublicationCheckpointConflict";
  }
}
