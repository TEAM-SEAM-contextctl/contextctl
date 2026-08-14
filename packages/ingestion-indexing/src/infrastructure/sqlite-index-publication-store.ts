import type { DatabaseSync } from "node:sqlite";

import {
  parsePublishedIndexVersion,
  PublishedIndexVersionValidationError,
  publishedIndexVersionFingerprint,
} from "../domain/published-index-version.js";
import { canonicalJson } from "../domain/revision-identity.js";
import {
  IndexCatalogFault,
  IndexPublicationStoreConflict,
  type CommitIndexPublicationResult,
  type IndexPublicationStore,
  type PublishedIndexVersion,
} from "../ports/index-publication-store.js";
import { inIngestionTransaction } from "./sqlite-ingestion-database.js";

interface IndexVersionRow {
  readonly document_index_id: string;
  readonly index_version: string;
  readonly payload_schema_version: number;
  readonly publication_json: string;
  readonly fingerprint: string;
  readonly published_at: string;
}

export class SqliteIndexPublicationStore implements IndexPublicationStore {
  constructor(private readonly database: DatabaseSync) {}

  async findVersion(input: {
    readonly documentIndexId: string;
    readonly indexVersion: string;
  }): Promise<PublishedIndexVersion | undefined> {
    try {
      const row = this.database
        .prepare(
          `SELECT * FROM index_versions
           WHERE document_index_id = ? AND index_version = ?`,
        )
        .get(input.documentIndexId, input.indexVersion) as
        | IndexVersionRow
        | undefined;
      return row === undefined ? undefined : parseRow(row);
    } catch (error) {
      throw mapReadError(error);
    }
  }

  async current(
    documentIndexId: string,
  ): Promise<PublishedIndexVersion | undefined> {
    try {
      const row = this.database
        .prepare(
          `SELECT versions.*
             FROM current_index_versions current_version
             JOIN index_versions versions
               ON versions.document_index_id = current_version.document_index_id
              AND versions.index_version = current_version.index_version
            WHERE current_version.document_index_id = ?`,
        )
        .get(documentIndexId) as IndexVersionRow | undefined;
      if (row !== undefined) return parseRow(row);
      const pointer = this.database
        .prepare(
          "SELECT 1 AS present FROM current_index_versions WHERE document_index_id = ?",
        )
        .get(documentIndexId);
      if (pointer !== undefined) {
        throw new IndexCatalogFault("corrupt_record", false);
      }
      return undefined;
    } catch (error) {
      throw mapReadError(error);
    }
  }

  async commitCurrent(
    input: PublishedIndexVersion,
  ): Promise<CommitIndexPublicationResult> {
    let publication: PublishedIndexVersion;
    try {
      publication = parsePublishedIndexVersion(
        JSON.parse(JSON.stringify(input)) as unknown,
      );
    } catch {
      throw new IndexPublicationStoreConflict();
    }
    const fingerprint = publishedIndexVersionFingerprint(publication);
    try {
      return inIngestionTransaction(this.database, () => {
        const existing = this.database
          .prepare(
            `SELECT * FROM index_versions
             WHERE document_index_id = ? AND index_version = ?`,
          )
          .get(
            publication.manifest.documentIndexId,
            publication.manifest.indexVersion,
          ) as IndexVersionRow | undefined;
        if (existing !== undefined) {
          const stored = parseRow(existing);
          if (publishedIndexVersionFingerprint(stored) !== fingerprint) {
            throw new IndexPublicationStoreConflict();
          }
          return { status: "already_published", publication: stored };
        }

        this.database
          .prepare(
            `INSERT INTO index_versions (
               document_index_id, index_version, payload_schema_version,
               publication_json, fingerprint, published_at
             ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            publication.manifest.documentIndexId,
            publication.manifest.indexVersion,
            publication.manifest.payloadSchemaVersion,
            canonicalJson(publication),
            fingerprint,
            publication.manifest.publishedAt,
          );
        this.database
          .prepare(
            `INSERT INTO current_index_versions (document_index_id, index_version)
             VALUES (?, ?)
             ON CONFLICT (document_index_id) DO UPDATE
               SET index_version = excluded.index_version`,
          )
          .run(
            publication.manifest.documentIndexId,
            publication.manifest.indexVersion,
          );
        return {
          status: "published",
          publication: structuredClone(publication),
        };
      });
    } catch (error) {
      if (
        error instanceof IndexPublicationStoreConflict ||
        error instanceof IndexCatalogFault
      ) {
        throw error;
      }
      throw new IndexCatalogFault("catalog_unavailable", true);
    }
  }
}

function parseRow(row: IndexVersionRow): PublishedIndexVersion {
  let decoded: unknown;
  try {
    decoded = JSON.parse(row.publication_json) as unknown;
  } catch {
    throw new IndexCatalogFault("corrupt_record", false);
  }
  let publication: PublishedIndexVersion;
  try {
    publication = parsePublishedIndexVersion(decoded);
  } catch (error) {
    if (error instanceof PublishedIndexVersionValidationError) {
      throw new IndexCatalogFault(error.code, false);
    }
    throw error;
  }
  if (
    row.document_index_id !== publication.manifest.documentIndexId ||
    row.index_version !== publication.manifest.indexVersion ||
    row.payload_schema_version !== publication.manifest.payloadSchemaVersion ||
    row.published_at !== publication.manifest.publishedAt ||
    row.fingerprint !== publishedIndexVersionFingerprint(publication)
  ) {
    throw new IndexCatalogFault("corrupt_record", false);
  }
  return publication;
}

function mapReadError(error: unknown): IndexCatalogFault {
  if (error instanceof IndexCatalogFault) return error;
  return new IndexCatalogFault("catalog_unavailable", true);
}
