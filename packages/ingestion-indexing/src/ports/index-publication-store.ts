import type {
  PublishedDocumentIndexRef,
  PublishedDocumentScope,
} from "@contextctl/contracts";

import type { IndexManifest } from "../domain/index-manifest.js";

/** Immutable metadata made visible by one successful atomic current transition. */
export interface PublishedIndexVersion {
  readonly manifest: IndexManifest;
  /** Internal isolation key; never serialized into a Published Scope. */
  readonly securityDomain: string;
  readonly documentIndex: PublishedDocumentIndexRef;
  readonly scopes: readonly PublishedDocumentScope[];
}

export interface CommitIndexPublicationResult {
  readonly status: "already_published" | "published";
  readonly publication: PublishedIndexVersion;
}

/** Ingestion-owned transaction boundary for immutable versions and current. */
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

export class IndexPublicationStoreConflict extends Error {
  constructor() {
    super("Index publication store rejected conflicting immutable content");
    this.name = "IndexPublicationStoreConflict";
  }
}
