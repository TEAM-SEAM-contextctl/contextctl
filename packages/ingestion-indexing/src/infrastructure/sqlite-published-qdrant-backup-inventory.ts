import type { DatabaseSync } from "node:sqlite";

import {
  parsePublishedIndexVersion,
  PublishedIndexVersionValidationError,
} from "../domain/published-index-version.js";

export interface PublishedQdrantBackupTarget {
  readonly collectionName: string;
}

export type PublishedQdrantBackupInventoryErrorCode =
  | "catalog_corrupt"
  | "identity_mismatch"
  | "unsupported_vector_binding";

/** A durable catalog cannot be mapped to an exact Qdrant backup set. */
export class PublishedQdrantBackupInventoryError extends Error {
  constructor(readonly code: PublishedQdrantBackupInventoryErrorCode) {
    super(`Published Qdrant backup inventory is invalid: ${code}`);
    this.name = "PublishedQdrantBackupInventoryError";
  }
}

/**
 * Lists the physical Qdrant collections needed by every immutable published
 * Index version in this Ingestion state.
 *
 * Old versions are included deliberately: an approved or rollbackable Card can
 * still name one even when it is not the current Index pointer. The physical
 * binding remains private to Indexing; callers receive only the exact
 * collection backup targets needed by the operational snapshot coordinator.
 */
export function listPublishedQdrantBackupTargets(
  database: DatabaseSync,
  expectedIdentity: {
    readonly stateNamespaceId: string;
    readonly securityDomain: string;
  },
): readonly PublishedQdrantBackupTarget[] {
  assertDatabaseIdentity(database, expectedIdentity);

  let rows: readonly { readonly publication_json?: unknown }[];
  try {
    rows = database
      .prepare("SELECT publication_json FROM index_versions")
      .all() as readonly { readonly publication_json?: unknown }[];
  } catch {
    throw new PublishedQdrantBackupInventoryError("catalog_corrupt");
  }

  const collections = new Set<string>();
  for (const row of rows) {
    if (typeof row.publication_json !== "string") {
      throw new PublishedQdrantBackupInventoryError("catalog_corrupt");
    }
    try {
      const publication = parsePublishedIndexVersion(
        JSON.parse(row.publication_json) as unknown,
      );
      if (
        publication.binding.stateNamespaceId !==
          expectedIdentity.stateNamespaceId ||
        publication.binding.securityDomain !== expectedIdentity.securityDomain
      ) {
        throw new PublishedQdrantBackupInventoryError("identity_mismatch");
      }
      collections.add(
        collectionNameFromAccessHandle(publication.binding.accessHandle),
      );
    } catch (error) {
      if (error instanceof PublishedQdrantBackupInventoryError) throw error;
      if (
        error instanceof SyntaxError ||
        error instanceof PublishedIndexVersionValidationError
      ) {
        throw new PublishedQdrantBackupInventoryError("catalog_corrupt");
      }
      throw error;
    }
  }

  return [...collections]
    .sort((left, right) => left.localeCompare(right))
    .map((collectionName) => ({ collectionName }));
}

function assertDatabaseIdentity(
  database: DatabaseSync,
  expected: {
    readonly stateNamespaceId: string;
    readonly securityDomain: string;
  },
): void {
  let row:
    | {
        readonly state_namespace_id?: unknown;
        readonly security_domain?: unknown;
      }
    | undefined;
  try {
    row = database
      .prepare(
        "SELECT state_namespace_id, security_domain FROM ingestion_metadata WHERE singleton = 1",
      )
      .get() as typeof row;
  } catch {
    throw new PublishedQdrantBackupInventoryError("catalog_corrupt");
  }
  if (
    row?.state_namespace_id !== expected.stateNamespaceId ||
    row.security_domain !== expected.securityDomain
  ) {
    throw new PublishedQdrantBackupInventoryError("identity_mismatch");
  }
}

function collectionNameFromAccessHandle(accessHandle: string): string {
  const match = /^qdrant:v1:([a-f0-9]{32})$/.exec(accessHandle);
  if (match?.[1] === undefined) {
    throw new PublishedQdrantBackupInventoryError(
      "unsupported_vector_binding",
    );
  }
  return `contextctl_${match[1]}`;
}
