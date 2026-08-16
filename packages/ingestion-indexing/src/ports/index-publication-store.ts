import type {
  PublishedIndexVersion,
  PublishedIndexVersionV2,
} from "../domain/published-index-version.js";
import type {
  PublishedDocumentScopeV2 as PublishedDocumentScope,
  PublishedScopeRefV2 as PublishedScopeRef,
} from "@contextctl/contracts";

export type {
  PublishedIndexVersion,
  PublishedIndexVersionV2,
} from "../domain/published-index-version.js";

export interface CommitIndexPublicationResult {
  readonly status: "already_published" | "published";
  readonly publication: PublishedIndexVersion;
}

export interface CommitIndexPublicationV2Result {
  readonly status: "already_published" | "published";
  readonly publication: PublishedIndexVersionV2;
}

export interface PublishedScopeCatalogEntry {
  readonly publication: PublishedIndexVersionV2;
  readonly scope: PublishedDocumentScope;
}

/** @deprecated Pre-release v1 boundary retained for downstream migration. */
export interface IndexPublicationStore {
  findVersion(input: {
    readonly documentIndexId: string;
    readonly indexVersion: string;
  }): Promise<PublishedIndexVersion | undefined>;
  current(documentIndexId: string): Promise<PublishedIndexVersion | undefined>;
  commitCurrent(
    publication: PublishedIndexVersion,
  ): Promise<CommitIndexPublicationResult>;
}

/** Final v2 catalog boundary owned and consumed inside Indexing. */
export interface IndexPublicationStoreV2 {
  findVersion(input: {
    readonly documentIndexId: string;
    readonly indexVersion: string;
  }): Promise<PublishedIndexVersionV2 | undefined>;
  current(documentIndexId: string): Promise<PublishedIndexVersionV2 | undefined>;
  findScope(
    scopeRef: PublishedScopeRef,
  ): Promise<PublishedScopeCatalogEntry | undefined>;
  commitCurrent(
    publication: PublishedIndexVersionV2,
  ): Promise<CommitIndexPublicationV2Result>;
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
