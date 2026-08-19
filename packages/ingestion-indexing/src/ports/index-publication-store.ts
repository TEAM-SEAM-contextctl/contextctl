import type { PublishedIndexVersion } from "../domain/published-index-version.js";
import type {
  PublishedDocumentScope,
  PublishedScopeRef,
} from "@contextctl/contracts";

export type {
  PublishedIndexVersion,
} from "../domain/published-index-version.js";

export interface CommitIndexPublicationResult {
  readonly status: "already_published" | "published";
  readonly publication: PublishedIndexVersion;
}

export interface PublishedScopeCatalogEntry {
  readonly publication: PublishedIndexVersion;
  readonly scope: PublishedDocumentScope;
}

/** Durable logical Scope catalog owned and consumed inside Indexing. */
export interface IndexPublicationStore {
  findVersion(input: {
    readonly documentIndexId: string;
    readonly indexVersion: string;
  }): Promise<PublishedIndexVersion | undefined>;
  current(documentIndexId: string): Promise<PublishedIndexVersion | undefined>;
  commitCurrent(
    publication: PublishedIndexVersion,
  ): Promise<CommitIndexPublicationResult>;
  findScope(
    scopeRef: PublishedScopeRef,
  ): Promise<PublishedScopeCatalogEntry | undefined>;
}

export class IndexPublicationStoreConflict extends Error {
  constructor() {
    super("Index publication store rejected conflicting immutable content");
    this.name = "IndexPublicationStoreConflict";
  }
}

export type IndexCatalogFaultCode =
  | "catalog_unavailable"
  | "corrupt_record"
  | "schema_unsupported";

export class IndexCatalogFault extends Error {
  constructor(
    readonly code: IndexCatalogFaultCode,
    readonly retriable: boolean,
  ) {
    super(`Index catalog operation failed: ${code}`);
    this.name = "IndexCatalogFault";
  }
}
