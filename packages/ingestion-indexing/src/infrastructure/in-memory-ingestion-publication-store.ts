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
  PreparePublicationRecoveryIntentResult,
  PublicationRecoveryIntent,
} from "../ports/markdown-publication.js";
import {
  IngestionPublicationCommitIncomplete,
  IngestionPublicationStoreConflict,
} from "../ports/markdown-publication.js";

interface StoredPublication {
  readonly publication: IngestionPublication;
  notified: boolean;
}

interface StoredRecoveryIntent {
  readonly publication: IngestionPublication;
  readonly canonicalPayload: string;
  committed: boolean;
}

export class InMemoryIngestionPublicationStore
  implements IngestionPublicationStore
{
  readonly #publications = new Map<string, StoredPublication>();
  readonly #latestBySource = new Map<string, string>();
  readonly #scopeDefinitions = new Map<string, string>();
  readonly #recoveryIntents = new Map<string, StoredRecoveryIntent>();
  readonly #pendingIntentBySource = new Map<string, string>();

  async prepareRecoveryIntent(
    input: IngestionPublication,
  ): Promise<PreparePublicationRecoveryIntentResult> {
    const publication = parsePublication(input);
    const canonicalPayload = canonicalJson(publication);
    const existing = this.#recoveryIntents.get(publication.publicationId);
    if (existing !== undefined) {
      if (existing.canonicalPayload !== canonicalPayload) {
        throw new IngestionPublicationStoreConflict();
      }
      return {
        status: "already_prepared",
        intent: cloneIntent(existing),
      };
    }
    const pendingId = this.#pendingIntentBySource.get(publication.sourceId);
    if (pendingId !== undefined) {
      throw new IngestionPublicationStoreConflict();
    }
    const previous = this.#latestPublication(publication.sourceId);
    assertTransition(previous, publication);
    const stored: StoredRecoveryIntent = {
      publication: structuredClone(publication),
      canonicalPayload,
      committed: false,
    };
    this.#recoveryIntents.set(publication.publicationId, stored);
    this.#pendingIntentBySource.set(
      publication.sourceId,
      publication.publicationId,
    );
    return { status: "prepared", intent: cloneIntent(stored) };
  }

  async findRecoveryIntent(
    publicationId: string,
  ): Promise<PublicationRecoveryIntent | undefined> {
    const intent = this.#recoveryIntents.get(publicationId);
    return intent === undefined ? undefined : cloneIntent(intent);
  }

  async pendingRecoveryIntentForSource(
    sourceId: string,
  ): Promise<PublicationRecoveryIntent | undefined> {
    const publicationId = this.#pendingIntentBySource.get(sourceId);
    return publicationId === undefined
      ? undefined
      : this.findRecoveryIntent(publicationId);
  }

  async commitReady(
    input: IngestionPublication,
  ): Promise<CommitIngestionPublicationResult> {
    const publication = parsePublication(input);
    const intent = this.#recoveryIntents.get(publication.publicationId);
    if (intent === undefined) {
      throw new IngestionPublicationCommitIncomplete();
    }
    if (intent.canonicalPayload !== canonicalJson(publication)) {
      throw new IngestionPublicationStoreConflict();
    }
    const existing = this.#publications.get(publication.publicationId);
    if (existing !== undefined) {
      if (canonicalJson(existing.publication) !== canonicalJson(publication)) {
        throw new IngestionPublicationStoreConflict();
      }
      this.#markIntentCommitted(intent);
      return {
        status: "already_published",
        publication: structuredClone(existing.publication),
      };
    }
    const previous = this.#latestPublication(publication.sourceId);
    assertTransition(previous, publication);
    this.#assertScopeDefinitions(publication);
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
    this.#markIntentCommitted(intent);
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

  #latestPublication(sourceId: string): IngestionPublication | undefined {
    const latestId = this.#latestBySource.get(sourceId);
    return latestId === undefined
      ? undefined
      : this.#publications.get(latestId)?.publication;
  }

  #assertScopeDefinitions(publication: IngestionPublication): void {
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
  }

  #markIntentCommitted(intent: StoredRecoveryIntent): void {
    intent.committed = true;
    if (
      this.#pendingIntentBySource.get(intent.publication.sourceId) ===
      intent.publication.publicationId
    ) {
      this.#pendingIntentBySource.delete(intent.publication.sourceId);
    }
  }
}

function parsePublication(input: IngestionPublication): IngestionPublication {
  try {
    return parseIngestionPublication(
      JSON.parse(JSON.stringify(input)) as unknown,
    );
  } catch {
    throw new IngestionPublicationStoreConflict();
  }
}

function assertTransition(
  previous: IngestionPublication | undefined,
  publication: IngestionPublication,
): void {
  if (publication.previousPublicationId !== previous?.publicationId) {
    throw new IngestionPublicationStoreConflict();
  }
  try {
    assertIngestionPublicationTransition(previous, publication);
  } catch {
    throw new IngestionPublicationStoreConflict();
  }
}

function cloneIntent(intent: StoredRecoveryIntent): PublicationRecoveryIntent {
  return {
    publication: structuredClone(intent.publication),
    canonicalPayload: intent.canonicalPayload,
    state: intent.committed ? "committed" : "pending",
  };
}
