import type { KnowledgeSource } from "../domain/knowledge-source.js";
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
    this.#bySourceId.set(source.id, structuredClone(checkpoint));
    this.#sourceIdByTargetKey.set(source.targetKey, source.id);
    return { status: "registered", checkpoint: structuredClone(checkpoint) };
  }

  async save(checkpoint: MarkdownPublicationCheckpoint): Promise<void> {
    const existing = this.#bySourceId.get(checkpoint.source.id);
    if (
      existing === undefined ||
      existing.source.targetKey !== checkpoint.source.targetKey ||
      existing.documentId !== checkpoint.documentId ||
      (existing.previousChangeToken !== undefined &&
        checkpoint.previousChangeToken === undefined) ||
      (existing.document !== undefined &&
        checkpoint.document !== undefined &&
        existing.document.sourceId !== checkpoint.document.sourceId)
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
