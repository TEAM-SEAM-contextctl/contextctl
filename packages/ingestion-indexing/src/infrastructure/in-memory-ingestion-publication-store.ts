import {
  assertIngestionPublicationV2Transition as assertIngestionPublicationTransition,
  parseIngestionPublicationV2 as parseIngestionPublication,
  parsePublicationReady,
  type IngestionPublicationV2 as IngestionPublication,
} from "@contextctl/contracts";

import { canonicalJson } from "../domain/revision-identity.js";
import { expirationAfter } from "../domain/index-staging-attempt.js";
import { isIsoTimestamp } from "../domain/model-validation.js";
import type {
  ClaimedPublicationReady,
  ClaimPublicationReadyBatchInput,
  CommitIngestionPublicationResult,
  CompletePublicationReadyDeliveryInput,
  IngestionPublicationStore,
  PreparePublicationRecoveryIntentResult,
  PublicationRecoveryIntent,
  ReschedulePublicationReadyDeliveryInput,
} from "../ports/markdown-publication.js";
import {
  IngestionPublicationCommitIncomplete,
  IngestionPublicationStoreConflict,
  MAX_PUBLICATION_READY_BATCH_SIZE,
} from "../ports/markdown-publication.js";

interface StoredPublication {
  readonly publication: IngestionPublication;
  readyState: "pending" | "delivering" | "delivered";
  readyOwnerId?: string;
  readyOwnerExpiresAt?: string;
  readyAttemptCount: number;
  readyNextAttemptAt: string;
  readyLastDiagnosticCode?: string;
  readyDeliveredAt?: string;
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
      readyState: "pending",
      readyAttemptCount: 0,
      readyNextAttemptAt: publication.producedAt,
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

  async claimReadyBatch(
    input: ClaimPublicationReadyBatchInput,
  ): Promise<readonly ClaimedPublicationReady[]> {
    assertClaimInput(input);
    const ownerExpiresAt = expirationAfter(input.now, input.leaseDurationMs);
    return [...this.#publications.values()]
      .filter((stored) => isReadyEligible(stored, input.now))
      .sort(
        (left, right) =>
          left.publication.producedAt.localeCompare(
            right.publication.producedAt,
          ) ||
          left.publication.publicationId.localeCompare(
            right.publication.publicationId,
          ),
      )
      .slice(0, input.limit)
      .map((stored) => {
        stored.readyState = "delivering";
        stored.readyOwnerId = input.ownerId;
        stored.readyOwnerExpiresAt = ownerExpiresAt;
        stored.readyAttemptCount += 1;
        delete stored.readyLastDiagnosticCode;
        const notification = parsePublicationReady({
          schemaVersion: 1,
          publicationId: stored.publication.publicationId,
        });
        return {
          ...notification,
          ownerId: input.ownerId,
          ownerExpiresAt,
          attemptCount: stored.readyAttemptCount,
        };
      });
  }

  async completeReadyDelivery(
    input: CompletePublicationReadyDeliveryInput,
  ): Promise<void> {
    if (!isIsoTimestamp(input.deliveredAt)) {
      throw new IngestionPublicationStoreConflict();
    }
    const stored = this.#requiredOwnedDelivery(
      input.publicationId,
      input.ownerId,
    );
    stored.readyState = "delivered";
    stored.readyDeliveredAt = input.deliveredAt;
    delete stored.readyOwnerId;
    delete stored.readyOwnerExpiresAt;
    delete stored.readyLastDiagnosticCode;
  }

  async rescheduleReadyDelivery(
    input: ReschedulePublicationReadyDeliveryInput,
  ): Promise<void> {
    if (
      !isIsoTimestamp(input.nextAttemptAt) ||
      !isDiagnosticCode(input.diagnosticCode)
    ) {
      throw new IngestionPublicationStoreConflict();
    }
    const stored = this.#requiredOwnedDelivery(
      input.publicationId,
      input.ownerId,
    );
    stored.readyState = "pending";
    stored.readyNextAttemptAt = input.nextAttemptAt;
    stored.readyLastDiagnosticCode = input.diagnosticCode;
    delete stored.readyOwnerId;
    delete stored.readyOwnerExpiresAt;
  }

  #latestPublication(sourceId: string): IngestionPublication | undefined {
    const latestId = this.#latestBySource.get(sourceId);
    return latestId === undefined
      ? undefined
      : this.#publications.get(latestId)?.publication;
  }

  #requiredOwnedDelivery(
    publicationId: string,
    ownerId: string,
  ): StoredPublication {
    const stored = this.#publications.get(publicationId);
    if (
      ownerId.trim() === "" ||
      stored?.readyState !== "delivering" ||
      stored.readyOwnerId !== ownerId
    ) {
      throw new IngestionPublicationStoreConflict();
    }
    return stored;
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

function assertClaimInput(input: ClaimPublicationReadyBatchInput): void {
  if (
    input.ownerId.trim() === "" ||
    !isIsoTimestamp(input.now) ||
    !Number.isSafeInteger(input.leaseDurationMs) ||
    input.leaseDurationMs <= 0 ||
    !Number.isSafeInteger(input.limit) ||
    input.limit <= 0 ||
    input.limit > MAX_PUBLICATION_READY_BATCH_SIZE
  ) {
    throw new IngestionPublicationStoreConflict();
  }
}

function isReadyEligible(stored: StoredPublication, now: string): boolean {
  return (
    (stored.readyState === "pending" && stored.readyNextAttemptAt <= now) ||
    (stored.readyState === "delivering" &&
      stored.readyOwnerExpiresAt !== undefined &&
      stored.readyOwnerExpiresAt <= now)
  );
}

function isDiagnosticCode(value: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(value);
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
