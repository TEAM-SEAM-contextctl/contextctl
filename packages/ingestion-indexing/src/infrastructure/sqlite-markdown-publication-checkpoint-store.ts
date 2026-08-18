import type { DatabaseSync } from "node:sqlite";

import {
  validateDocumentSemanticUnits,
  validateNormalizedDocument,
} from "../domain/document-model.js";
import { assertValidDocumentIndexingSnapshot } from "../domain/document-incremental-update.js";
import type { KnowledgeSource } from "../domain/knowledge-source.js";
import type {
  MarkdownPublicationCheckpoint,
  MarkdownPublicationCheckpointStore,
  RegisterMarkdownCheckpointResult,
} from "../ports/markdown-publication.js";
import { MarkdownPublicationCheckpointConflict } from "../ports/markdown-publication.js";
import { inIngestionTransaction } from "./sqlite-ingestion-database.js";

interface CheckpointRow {
  readonly source_id: string;
  readonly target_key: string;
  readonly source_type: string;
  readonly document_id: string;
  readonly checkpoint_json: string;
}

export class SqliteMarkdownPublicationCheckpointStore
  implements MarkdownPublicationCheckpointStore
{
  constructor(private readonly database: DatabaseSync) {}

  async register(
    source: KnowledgeSource,
    documentId: string,
  ): Promise<RegisterMarkdownCheckpointResult> {
    try {
      return inIngestionTransaction(this.database, () => {
        const existing = this.database
          .prepare(
            `SELECT * FROM markdown_publication_checkpoints
             WHERE target_key = ?`,
          )
          .get(source.targetKey) as CheckpointRow | undefined;
        if (existing !== undefined) {
          const checkpoint = parseRow(existing);
          if (checkpoint.source.sourceType !== source.sourceType) {
            throw new MarkdownPublicationCheckpointConflict();
          }
          return { status: "existing", checkpoint };
        }
        const checkpoint = parseCheckpoint({ source, documentId });
        this.database
          .prepare(
            `INSERT INTO markdown_publication_checkpoints (
               source_id, target_key, source_type, document_id, checkpoint_json
             ) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            checkpoint.source.id,
            checkpoint.source.targetKey,
            checkpoint.source.sourceType,
            checkpoint.documentId,
            JSON.stringify(checkpoint),
          );
        return {
          status: "registered",
          checkpoint: structuredClone(checkpoint),
        };
      });
    } catch (error) {
      throw mapCheckpointError(error);
    }
  }

  async save(checkpoint: MarkdownPublicationCheckpoint): Promise<void> {
    const validated = parseCheckpoint(
      JSON.parse(JSON.stringify(checkpoint)) as unknown,
    );
    try {
      inIngestionTransaction(this.database, () => {
        const existing = this.database
          .prepare(
            `SELECT * FROM markdown_publication_checkpoints
             WHERE source_id = ?`,
          )
          .get(validated.source.id) as CheckpointRow | undefined;
        if (existing === undefined) {
          throw new MarkdownPublicationCheckpointConflict();
        }
        const stored = parseRow(existing);
        const storedDocument = checkpointDocument(stored);
        const nextDocument = checkpointDocument(validated);
        if (
          stored.source.targetKey !== validated.source.targetKey ||
          stored.documentId !== validated.documentId ||
          (stored.previousChangeToken !== undefined &&
            validated.previousChangeToken === undefined) ||
          (storedDocument !== undefined &&
            nextDocument !== undefined &&
            storedDocument.sourceId !== nextDocument.sourceId)
        ) {
          throw new MarkdownPublicationCheckpointConflict();
        }
        this.database
          .prepare(
            `UPDATE markdown_publication_checkpoints
             SET source_type = ?, document_id = ?, checkpoint_json = ?
             WHERE source_id = ?`,
          )
          .run(
            validated.source.sourceType,
            validated.documentId,
            JSON.stringify(validated),
            validated.source.id,
          );
      });
    } catch (error) {
      throw mapCheckpointError(error);
    }
  }

  async findBySourceId(
    sourceId: string,
  ): Promise<MarkdownPublicationCheckpoint | undefined> {
    try {
      const row = this.database
        .prepare(
          `SELECT * FROM markdown_publication_checkpoints
           WHERE source_id = ?`,
        )
        .get(sourceId) as CheckpointRow | undefined;
      return row === undefined ? undefined : parseRow(row);
    } catch (error) {
      throw mapCheckpointError(error);
    }
  }
}

export class MarkdownPublicationCheckpointStoreUnavailable extends Error {
  readonly code = "checkpoint_store_unavailable";

  constructor() {
    super("Markdown Publication checkpoint store is unavailable");
    this.name = "MarkdownPublicationCheckpointStoreUnavailable";
  }
}

function parseRow(row: CheckpointRow): MarkdownPublicationCheckpoint {
  const checkpoint = parseCheckpoint(
    JSON.parse(row.checkpoint_json) as unknown,
  );
  if (
    checkpoint.source.id !== row.source_id ||
    checkpoint.source.targetKey !== row.target_key ||
    checkpoint.source.sourceType !== row.source_type ||
    checkpoint.documentId !== row.document_id
  ) {
    throw new MarkdownPublicationCheckpointConflict();
  }
  return checkpoint;
}

function parseCheckpoint(input: unknown): MarkdownPublicationCheckpoint {
  if (!isRecord(input) || !isRecord(input.source)) {
    throw new MarkdownPublicationCheckpointConflict();
  }
  const candidate = input as unknown as MarkdownPublicationCheckpoint;
  if (
    !isNonEmptyString(candidate.source.id) ||
    !isNonEmptyString(candidate.source.sourceType) ||
    !isNonEmptyString(candidate.source.displayName) ||
    !isNonEmptyString(candidate.source.targetKey) ||
    !isNonEmptyString(candidate.source.configReference) ||
    !isNonEmptyString(candidate.documentId) ||
    (candidate.previousChangeToken !== undefined &&
      !isNonEmptyString(candidate.previousChangeToken)) ||
    (candidate.document === undefined) !==
      (candidate.semanticUnits === undefined) ||
    (candidate.indexingSnapshot !== undefined &&
      candidate.document !== undefined)
  ) {
    throw new MarkdownPublicationCheckpointConflict();
  }
  if (
    candidate.document !== undefined &&
    candidate.semanticUnits !== undefined &&
    (validateNormalizedDocument(candidate.document).length > 0 ||
      validateDocumentSemanticUnits(
        candidate.document,
        candidate.semanticUnits,
      ).length > 0 ||
      candidate.document.sourceId !== candidate.source.id ||
      candidate.document.documentId !== candidate.documentId)
  ) {
    throw new MarkdownPublicationCheckpointConflict();
  }
  if (candidate.indexingSnapshot !== undefined) {
    try {
      assertValidDocumentIndexingSnapshot(
        candidate.indexingSnapshot,
        "previous",
      );
    } catch {
      throw new MarkdownPublicationCheckpointConflict();
    }
    if (
      candidate.indexingSnapshot.document.sourceId !== candidate.source.id ||
      candidate.indexingSnapshot.document.documentId !== candidate.documentId
    ) {
      throw new MarkdownPublicationCheckpointConflict();
    }
  }
  return structuredClone(candidate);
}

function checkpointDocument(checkpoint: MarkdownPublicationCheckpoint) {
  return checkpoint.indexingSnapshot?.document ?? checkpoint.document;
}

function mapCheckpointError(error: unknown): Error {
  if (
    error instanceof MarkdownPublicationCheckpointConflict ||
    error instanceof MarkdownPublicationCheckpointStoreUnavailable
  ) {
    return error;
  }
  return new MarkdownPublicationCheckpointStoreUnavailable();
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
