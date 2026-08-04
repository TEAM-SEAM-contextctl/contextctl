import type {
  ApprovedDocumentIndexRef,
  ApprovedDocumentSelection,
} from "../domain/card-catalog.js";

/** One search against one published document index, bounded by its Scope. */
export interface DocumentChunkQuery {
  readonly queryText: string;
  readonly documentIndex: ApprovedDocumentIndexRef;
  readonly selection: ApprovedDocumentSelection;
  readonly limit: number;
}

/**
 * A chunk the index returned, carrying enough identity to cite it.
 *
 * `score` is normalized to [0, 1] by the adapter, not by this domain: the
 * ranking band in `selection-verdict.ts` is expressed on that scale, and each
 * vector store reports similarity differently.
 */
export interface RetrievedChunk {
  readonly chunkId: string;
  readonly chunkRevisionId: string;
  readonly semanticUnitId: string;
  readonly documentId: string;
  readonly contentDigest: string;
  readonly text: string;
  readonly score: number;
}

/**
 * Searches the document indexes we published. ADR 0002 places this port in
 * Selection and leaves the Vector DB adapter for the daemon to assemble.
 *
 * Two obligations sit on the adapter rather than on this domain, because only
 * the adapter can enforce them at the store: scores are normalized to [0, 1],
 * and no chunk outside the requested `selection` is ever returned.
 */
export interface ManagedDocumentRetriever {
  searchChunks(query: DocumentChunkQuery): Promise<readonly RetrievedChunk[]>;
}

export type DocumentRetrievalFaultCode =
  | "index_unavailable"
  | "index_version_mismatch"
  | "access_denied";

/**
 * Raised by an adapter when retrieval cannot be attempted or trusted. Declared
 * beside the port it belongs to, following `SourceAdapterFault` in
 * ingestion-indexing, so an adapter author finds the contract and its failure
 * vocabulary in one file.
 */
export class DocumentRetrievalFault extends Error {
  constructor(readonly code: DocumentRetrievalFaultCode) {
    super(`Document retrieval failed: ${code}`);
    this.name = "DocumentRetrievalFault";
  }
}
