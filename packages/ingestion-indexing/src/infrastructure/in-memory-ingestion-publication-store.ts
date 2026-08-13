import {
  parseIngestionPublication,
  parsePublicationReady,
  type IngestionPublication,
  type PublicationReady,
} from "@contextctl/contracts";

import { canonicalJson } from "../domain/revision-identity.js";
import type {
  CommitIngestionPublicationResult,
  IngestionPublicationStore,
} from "../ports/markdown-publication.js";

interface StoredPublication {
  readonly publication: IngestionPublication;
  notified: boolean;
}

export class InMemoryIngestionPublicationStore
  implements IngestionPublicationStore
{
  readonly #publications = new Map<string, StoredPublication>();
  readonly #latestBySource = new Map<string, string>();

  async commitReady(
    input: IngestionPublication,
  ): Promise<CommitIngestionPublicationResult> {
    const publication = parseIngestionPublication(
      JSON.parse(JSON.stringify(input)) as unknown,
    );
    const existing = this.#publications.get(publication.publicationId);
    if (existing !== undefined) {
      if (canonicalJson(existing.publication) !== canonicalJson(publication)) {
        throw new IngestionPublicationStoreConflict();
      }
      return {
        status: "already_published",
        publication: structuredClone(existing.publication),
      };
    }
    const latestId = this.#latestBySource.get(publication.sourceId);
    if (publication.previousPublicationId !== latestId) {
      throw new IngestionPublicationStoreConflict();
    }
    this.#publications.set(publication.publicationId, {
      publication: structuredClone(publication),
      notified: false,
    });
    this.#latestBySource.set(publication.sourceId, publication.publicationId);
    return { status: "published", publication: structuredClone(publication) };
  }

  async find(
    publicationId: string,
  ): Promise<IngestionPublication | undefined> {
    const stored = this.#publications.get(publicationId);
    return stored === undefined
      ? undefined
      : structuredClone(stored.publication);
  }

  async latestForSource(
    sourceId: string,
  ): Promise<IngestionPublication | undefined> {
    const publicationId = this.#latestBySource.get(sourceId);
    return publicationId === undefined ? undefined : this.find(publicationId);
  }

  async pendingReady(): Promise<readonly PublicationReady[]> {
    return [...this.#publications.values()]
      .filter((stored) => !stored.notified)
      .map((stored) =>
        parsePublicationReady({
          schemaVersion: 1,
          publicationId: stored.publication.publicationId,
        }),
      )
      .sort((left, right) =>
        left.publicationId.localeCompare(right.publicationId),
      );
  }

  async markReadyNotified(publicationId: string): Promise<void> {
    const stored = this.#publications.get(publicationId);
    if (stored === undefined) {
      throw new IngestionPublicationStoreConflict();
    }
    stored.notified = true;
  }
}

export class IngestionPublicationStoreConflict extends Error {
  readonly code = "publication_conflict";

  constructor() {
    super("Ingestion Publication store rejected conflicting immutable content");
    this.name = "IngestionPublicationStoreConflict";
  }
}
