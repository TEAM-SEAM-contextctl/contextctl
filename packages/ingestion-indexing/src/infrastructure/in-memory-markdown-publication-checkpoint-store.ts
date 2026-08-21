import type { KnowledgeSource } from "../domain/knowledge-source.js";
import { assertValidDocumentIndexingSnapshot } from "../domain/document-incremental-update.js";
import { isUuidV7Id } from "../domain/model-validation.js";
import { canonicalJson } from "../domain/revision-identity.js";
import type {
  MarkdownPublicationCheckpoint,
  MarkdownPublicationCheckpointStore,
  RegisterMarkdownCheckpointResult,
} from "../ports/markdown-publication.js";
import { MarkdownPublicationCheckpointConflict } from "../ports/markdown-publication.js";

export class InMemoryMarkdownPublicationCheckpointStore
  implements MarkdownPublicationCheckpointStore
{
  readonly #bySourceId = new Map<string, MarkdownPublicationCheckpoint>();
  readonly #sourceIdByTargetKey = new Map<string, string>();

  async register(
    source: KnowledgeSource,
    documentId: string,
  ): Promise<RegisterMarkdownCheckpointResult> {
    const existingSourceId = this.#sourceIdByTargetKey.get(source.targetKey);
    if (existingSourceId !== undefined) {
      const existing = this.#bySourceId.get(existingSourceId);
      if (
        existing === undefined ||
        existing.source.sourceType !== source.sourceType
      ) {
        throw new MarkdownPublicationCheckpointConflict();
      }
      return { status: "existing", checkpoint: structuredClone(existing) };
    }
    const checkpoint: MarkdownPublicationCheckpoint = { source, documentId };
    assertCheckpointSnapshot(checkpoint);
    this.#bySourceId.set(source.id, structuredClone(checkpoint));
    this.#sourceIdByTargetKey.set(source.targetKey, source.id);
    return { status: "registered", checkpoint: structuredClone(checkpoint) };
  }

  async save(checkpoint: MarkdownPublicationCheckpoint): Promise<void> {
    const existing = this.#bySourceId.get(checkpoint.source.id);
    assertCheckpointSnapshot(checkpoint);
    const existingDocument = checkpointDocument(existing);
    const nextDocument = checkpointDocument(checkpoint);
    if (
      existing === undefined ||
      existing.source.targetKey !== checkpoint.source.targetKey ||
      existing.documentId !== checkpoint.documentId ||
      (existing.previousChangeToken !== undefined &&
        checkpoint.previousChangeToken === undefined) ||
      (existing.observationId !== undefined &&
        checkpoint.observationId === undefined) ||
      !validPendingTransition(existing, checkpoint) ||
      (existingDocument !== undefined &&
        nextDocument !== undefined &&
        existingDocument.sourceId !== nextDocument.sourceId)
    ) {
      throw new MarkdownPublicationCheckpointConflict();
    }
    this.#bySourceId.set(checkpoint.source.id, structuredClone(checkpoint));
  }

  async findBySourceId(
    sourceId: string,
  ): Promise<MarkdownPublicationCheckpoint | undefined> {
    const checkpoint = this.#bySourceId.get(sourceId);
    return checkpoint === undefined ? undefined : structuredClone(checkpoint);
  }
}

function checkpointDocument(
  checkpoint: MarkdownPublicationCheckpoint | undefined,
) {
  return checkpoint?.indexingSnapshot?.document ?? checkpoint?.document;
}

function assertCheckpointSnapshot(
  checkpoint: MarkdownPublicationCheckpoint,
): void {
  if (
    !isUuidV7Id(checkpoint.source.id, "src") ||
    !isUuidV7Id(checkpoint.documentId, "doc") ||
    (checkpoint.observationId !== undefined &&
      !isUuidV7Id(checkpoint.observationId, "obs")) ||
    (checkpoint.observationId !== undefined &&
      checkpoint.indexingSnapshot === undefined) ||
    (checkpoint.document === undefined) !==
      (checkpoint.semanticUnits === undefined) ||
    (checkpoint.indexingSnapshot !== undefined &&
      checkpoint.document !== undefined)
  ) {
    throw new MarkdownPublicationCheckpointConflict();
  }
  if (checkpoint.indexingSnapshot !== undefined) {
    try {
      assertValidDocumentIndexingSnapshot(
        checkpoint.indexingSnapshot,
        "previous",
      );
    } catch {
      throw new MarkdownPublicationCheckpointConflict();
    }
    if (
      checkpoint.indexingSnapshot.document.sourceId !== checkpoint.source.id ||
      checkpoint.indexingSnapshot.document.documentId !== checkpoint.documentId ||
      (checkpoint.observationId !== undefined &&
        checkpoint.indexingSnapshot.document.observationId !==
          checkpoint.observationId)
    ) {
      throw new MarkdownPublicationCheckpointConflict();
    }
  }
  if (checkpoint.pendingIndexingSnapshot !== undefined) {
    try {
      assertValidDocumentIndexingSnapshot(
        checkpoint.pendingIndexingSnapshot,
        "previous",
      );
    } catch {
      throw new MarkdownPublicationCheckpointConflict();
    }
    if (
      checkpoint.pendingIndexingSnapshot.document.sourceId !==
        checkpoint.source.id ||
      checkpoint.pendingIndexingSnapshot.document.documentId !==
        checkpoint.documentId ||
      checkpoint.pendingIndexingSnapshot.document.observationId ===
        checkpoint.observationId
    ) {
      throw new MarkdownPublicationCheckpointConflict();
    }
  }
}

function validPendingTransition(
  existing: MarkdownPublicationCheckpoint,
  next: MarkdownPublicationCheckpoint,
): boolean {
  const pending = existing.pendingIndexingSnapshot;
  if (pending === undefined) return true;
  if (next.pendingIndexingSnapshot !== undefined) {
    return (
      canonicalJson(next.pendingIndexingSnapshot) === canonicalJson(pending)
    );
  }
  return (
    next.indexingSnapshot?.document.observationId ===
    pending.document.observationId
  );
}
