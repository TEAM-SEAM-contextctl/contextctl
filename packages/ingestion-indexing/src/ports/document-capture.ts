import type {
  BlockIdSource,
  CandidateDocument,
} from "../domain/document-capture.js";

export interface MarkdownSourceSnapshot {
  readonly kind: "markdown";
  readonly targetKey: string;
  readonly capturedAt: string;
  readonly content: string;
  readonly contentDigest: string;
}

export interface MarkdownDocumentParser {
  readonly id: string;
  readonly version: string;
  parse(source: string): CandidateDocument;
}

export interface MarkdownCaptureDependencies {
  readonly parser: MarkdownDocumentParser;
  readonly ids: BlockIdSource;
}
