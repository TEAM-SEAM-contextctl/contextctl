import type {
  IngestionPublication,
  PublicationReady,
} from "@contextctl/contracts";

import type {
  DocumentSemanticUnit,
  NormalizedDocument,
} from "../domain/document-model.js";
import type { KnowledgeSource } from "../domain/knowledge-source.js";

export type MarkdownPublicationStage =
  | "registration"
  | "inspection"
  | "observation"
  | "capture"
  | "segmentation"
  | "chunking"
  | "embedding"
  | "index_publication"
  | "ingestion_publication"
  | "ready_notification";

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
  readonly previousChangeToken?: string;
  readonly document?: NormalizedDocument;
  readonly semanticUnits?: readonly DocumentSemanticUnit[];
}

export interface RegisterMarkdownCheckpointResult {
  readonly status: "existing" | "registered";
  readonly checkpoint: MarkdownPublicationCheckpoint;
}

/** Process-local in I5; a durable replacement is part of Index hardening. */
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

export interface CommitIngestionPublicationResult {
  readonly status: "already_published" | "published";
  readonly publication: IngestionPublication;
}

/**
 * Stores immutable Publications and a ready-notification outbox together.
 * There is deliberately no purge operation before Registry acknowledgement.
 */
export interface IngestionPublicationStore {
  commitReady(
    publication: IngestionPublication,
  ): Promise<CommitIngestionPublicationResult>;
  find(publicationId: string): Promise<IngestionPublication | undefined>;
  latestForSource(
    sourceId: string,
  ): Promise<IngestionPublication | undefined>;
  pendingReady(): Promise<readonly PublicationReady[]>;
  markReadyNotified(publicationId: string): Promise<void>;
}

export interface PublicationReadyNotifier {
  notify(notification: PublicationReady): Promise<void>;
}
