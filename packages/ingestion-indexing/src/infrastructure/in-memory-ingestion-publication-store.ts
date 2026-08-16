import {
  assertIngestionPublicationV2Transition as assertIngestionPublicationTransition,
  parseIngestionPublicationV2 as parseIngestionPublication,
  parsePublicationReady,
  type IngestionPublicationV2 as IngestionPublication,
  type PublicationReady,
} from "@contextctl/contracts";

import { canonicalJson } from "../domain/revision-identity.js";
import type {
  CommitIngestionPublicationResult,
  IngestionPublicationStore,
} from "../ports/markdown-publication.js";
import { IngestionPublicationStoreConflict } from "../ports/markdown-publication.js";

interface StoredPublication {
  readonly publication: IngestionPublication;
  notified: boolean;
}

export class InMemoryIngestionPublicationStore
  implements IngestionPublicationStore
{
  readonly #publications = new Map<string, StoredPublication>();
  readonly #latestBySource = new Map<string, string>();
  readonly #scopeDefinitions = new Map<string, string>();

  async commitReady(
    input: IngestionPublication,
  ): Promise<CommitIngestionPublicationResult> {
    let publication: IngestionPublication;
    try {
      publication = parseIngestionPublication(
        JSON.parse(JSON.stringify(input)) as unknown,
      );
    } catch {
      throw new IngestionPublicationStoreConflict();
    }
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
    const previous =
      latestId === undefined
        ? undefined
        : this.#publications.get(latestId)?.publication;
    try {
      assertIngestionPublicationTransition(previous, publication);
      for (const unit of publication.knowledgeUnits) {
        for (const scope of unit.publishedScopes) {
          const key = `${scope.scopeId}\u0000${scope.scopeVersion}`;
          const definition = canonicalJson(scope);
          const existingDefinition = this.#scopeDefinitions.get(key);
          if (
            existingDefinition !== undefined &&
            existingDefinition !== definition
          ) {
            throw new IngestionPublicationStoreConflict();
          }
        }
      }
    } catch {
      throw new IngestionPublicationStoreConflict();
    }
    this.#publications.set(publication.publicationId, {
      publication: structuredClone(publication),
      notified: false,
    });
    this.#latestBySource.set(publication.sourceId, publication.publicationId);
    for (const unit of publication.knowledgeUnits) {
      for (const scope of unit.publishedScopes) {
        this.#scopeDefinitions.set(
          `${scope.scopeId}\u0000${scope.scopeVersion}`,
          canonicalJson(scope),
        );
      }
    }
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
