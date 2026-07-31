import {
  assembleNormalizedMarkdownDocument,
  canonicalizeDocumentText,
  DocumentCaptureError,
  sha256Digest,
} from "../domain/document-capture.js";
import type { KnowledgeSource } from "../domain/knowledge-source.js";
import { isIsoTimestamp } from "../domain/model-validation.js";
import type { NormalizedDocument } from "../domain/document-model.js";
import type {
  MarkdownCaptureDependencies,
  MarkdownSourceSnapshot,
} from "../ports/document-capture.js";

export interface CaptureMarkdownCommand {
  readonly source: Pick<KnowledgeSource, "id" | "targetKey">;
  readonly observationId: string;
  readonly documentId: string;
  readonly snapshot: MarkdownSourceSnapshot;
  readonly previousDocument?: NormalizedDocument;
}

export class MarkdownCapture {
  readonly #dependencies: MarkdownCaptureDependencies;

  constructor(dependencies: MarkdownCaptureDependencies) {
    this.#dependencies = dependencies;
  }

  capture(command: CaptureMarkdownCommand): NormalizedDocument {
    if (
      command.snapshot.kind !== "markdown" ||
      command.source.targetKey.trim().length === 0 ||
      command.snapshot.targetKey !== command.source.targetKey ||
      !isIsoTimestamp(command.snapshot.capturedAt) ||
      canonicalizeDocumentText(command.snapshot.content) !==
        command.snapshot.content ||
      sha256Digest(command.snapshot.content) !== command.snapshot.contentDigest
    ) {
      throw new DocumentCaptureError("invalid_candidate");
    }
    const candidate = this.#dependencies.parser.parse(command.snapshot.content);
    return assembleNormalizedMarkdownDocument({
      sourceId: command.source.id,
      observationId: command.observationId,
      documentId: command.documentId,
      parser: {
        id: this.#dependencies.parser.id,
        version: this.#dependencies.parser.version,
      },
      canonicalText: command.snapshot.content,
      candidate,
      ids: this.#dependencies.ids,
      ...(command.previousDocument === undefined
        ? {}
        : { previousDocument: command.previousDocument }),
    });
  }
}
