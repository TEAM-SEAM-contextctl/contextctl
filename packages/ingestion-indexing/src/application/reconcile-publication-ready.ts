import type {
  IngestionPublicationStore,
  PublicationReadyNotifier,
} from "../ports/markdown-publication.js";

export interface PublicationReadyReconciliationItem {
  readonly publicationId: string;
  readonly status: "delivered" | "failed";
  readonly diagnosticCode?: string;
}

export interface ReconcilePublicationReadyDependencies {
  readonly publications: IngestionPublicationStore;
  readonly notifier: PublicationReadyNotifier;
}

/** Redelivers durable ready records without requiring a new Source run. */
export class PublicationReadyReconciler {
  constructor(
    private readonly dependencies: ReconcilePublicationReadyDependencies,
  ) {}

  async reconcile(): Promise<readonly PublicationReadyReconciliationItem[]> {
    const pending = await this.dependencies.publications.pendingReady();
    const results: PublicationReadyReconciliationItem[] = [];
    for (const notification of pending) {
      try {
        await this.dependencies.notifier.notify(notification);
        await this.dependencies.publications.markReadyNotified(
          notification.publicationId,
        );
        results.push({
          publicationId: notification.publicationId,
          status: "delivered",
        });
      } catch (error) {
        results.push({
          publicationId: notification.publicationId,
          status: "failed",
          diagnosticCode: safeDiagnosticCode(error),
        });
      }
    }
    return results;
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
