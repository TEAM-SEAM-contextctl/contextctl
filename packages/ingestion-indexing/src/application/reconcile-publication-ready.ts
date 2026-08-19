import { randomUUID } from "node:crypto";

import type {
  IngestionPublicationStore,
  PublicationReadyNotifier,
} from "../ports/markdown-publication.js";
import { MAX_PUBLICATION_READY_BATCH_SIZE } from "../ports/markdown-publication.js";
import { isIsoTimestamp } from "../domain/model-validation.js";

export interface PublicationReadyReconciliationItem {
  readonly publicationId: string;
  readonly status: "delivered" | "failed";
  readonly diagnosticCode?: string;
}

export interface ReconcilePublicationReadyDependencies {
  readonly publications: IngestionPublicationStore;
  readonly notifier: PublicationReadyNotifier;
  readonly ownerId?: string;
  readonly batchSize?: number;
  readonly leaseDurationMs?: number;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly clock?: () => string;
}

/** Redelivers durable ready records without requiring a new Source run. */
export class PublicationReadyReconciler {
  readonly #ownerId: string;
  readonly #batchSize: number;
  readonly #leaseDurationMs: number;
  readonly #baseBackoffMs: number;
  readonly #maxBackoffMs: number;
  readonly #clock: () => string;

  constructor(private readonly dependencies: ReconcilePublicationReadyDependencies) {
    this.#ownerId =
      dependencies.ownerId ?? `ready_${randomUUID().replaceAll("-", "")}`;
    this.#batchSize = dependencies.batchSize ?? 25;
    this.#leaseDurationMs = dependencies.leaseDurationMs ?? 30_000;
    this.#baseBackoffMs = dependencies.baseBackoffMs ?? 1_000;
    this.#maxBackoffMs = dependencies.maxBackoffMs ?? 300_000;
    this.#clock = dependencies.clock ?? (() => new Date().toISOString());
    if (
      this.#ownerId.trim() === "" ||
      !Number.isSafeInteger(this.#batchSize) ||
      this.#batchSize <= 0 ||
      this.#batchSize > MAX_PUBLICATION_READY_BATCH_SIZE ||
      !Number.isSafeInteger(this.#leaseDurationMs) ||
      this.#leaseDurationMs <= 0 ||
      !Number.isSafeInteger(this.#baseBackoffMs) ||
      this.#baseBackoffMs <= 0 ||
      !Number.isSafeInteger(this.#maxBackoffMs) ||
      this.#maxBackoffMs < this.#baseBackoffMs
    ) {
      throw new TypeError("PublicationReady reconciliation policy is invalid");
    }
  }

  async reconcile(): Promise<readonly PublicationReadyReconciliationItem[]> {
    const now = this.#now();
    const pending = await this.dependencies.publications.claimReadyBatch({
      ownerId: this.#ownerId,
      now,
      leaseDurationMs: this.#leaseDurationMs,
      limit: this.#batchSize,
    });
    const results: PublicationReadyReconciliationItem[] = [];
    for (const notification of pending) {
      try {
        await this.dependencies.notifier.notify({
          schemaVersion: notification.schemaVersion,
          publicationId: notification.publicationId,
        });
      } catch (error) {
        const diagnosticCode = safeDiagnosticCode(error);
        await this.dependencies.publications.rescheduleReadyDelivery({
          publicationId: notification.publicationId,
          ownerId: notification.ownerId,
          nextAttemptAt: this.#nextAttemptAt(notification.attemptCount),
          diagnosticCode,
        });
        results.push({
          publicationId: notification.publicationId,
          status: "failed",
          diagnosticCode,
        });
        continue;
      }
      await this.dependencies.publications.completeReadyDelivery({
        publicationId: notification.publicationId,
        ownerId: notification.ownerId,
        deliveredAt: this.#now(),
      });
      results.push({
        publicationId: notification.publicationId,
        status: "delivered",
      });
    }
    return results;
  }

  #now(): string {
    const now = this.#clock();
    if (!isIsoTimestamp(now)) {
      throw new TypeError("PublicationReady reconciliation clock is invalid");
    }
    return now;
  }

  #nextAttemptAt(attemptCount: number): string {
    const exponent = Math.max(0, Math.min(attemptCount - 1, 30));
    const delay = Math.min(
      this.#baseBackoffMs * 2 ** exponent,
      this.#maxBackoffMs,
    );
    const next = new Date(Date.parse(this.#now()) + delay).toISOString();
    if (!isIsoTimestamp(next)) {
      throw new TypeError("PublicationReady retry time is invalid");
    }
    return next;
  }
}

function safeDiagnosticCode(error: unknown): string {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[a-z][a-z0-9_]*$/.test(error.code)
  ) {
    return error.code;
  }
  return "notification_failed";
}
