import type {
  IndexPublicationStore,
  VectorIndexCompatibility,
  VectorIndexConnectorResolver,
} from "@contextctl/ingestion-indexing";
import type { ApprovedCardCatalog } from "@contextctl/selection-delivery";

import type { DaemonStateIdentity } from "./state-identity.js";

export type DaemonStateReadinessErrorCode =
  | "index_binding_unavailable"
  | "index_catalog_unavailable"
  | "scope_not_published"
  | "state_identity_mismatch";

/** Safe startup failure: the message contains no path, handle or credential. */
export class DaemonStateReadinessError extends Error {
  constructor(
    readonly code: DaemonStateReadinessErrorCode,
    readonly area: "index_catalog" | "vector_index",
    readonly retriable: boolean,
  ) {
    super(`Daemon state is not ready: ${area}:${code}`);
    this.name = "DaemonStateReadinessError";
  }
}

export interface DaemonStateReadinessDependencies {
  readonly stateIdentity: DaemonStateIdentity;
  readonly catalog: ApprovedCardCatalog;
  readonly publications: IndexPublicationStore;
  readonly vectorIndexes: VectorIndexConnectorResolver;
}

/**
 * Validates every durable binding reachable from an approved Card.
 *
 * This runs before ingress opens. It does not create or relabel storage:
 * `rehydrate` is the read-only Vector Index operation and must refuse a missing
 * collection or an incompatible compatibility digest.
 */
export async function assertDaemonStateReady(
  dependencies: DaemonStateReadinessDependencies,
  signal: AbortSignal = new AbortController().signal,
): Promise<void> {
  signal.throwIfAborted();
  let cards: Awaited<ReturnType<ApprovedCardCatalog["listApprovedCards"]>>;
  try {
    cards = await dependencies.catalog.listApprovedCards();
  } catch {
    throw new DaemonStateReadinessError(
      "index_catalog_unavailable",
      "index_catalog",
      true,
    );
  }

  const checkedBindings = new Set<string>();
  for (const card of cards) {
    for (const scope of card.scopes) {
      if (scope.kind !== "managed_document") continue;
      signal.throwIfAborted();

      let entry: Awaited<ReturnType<IndexPublicationStore["findScope"]>>;
      try {
        entry = await dependencies.publications.findScope(scope.reference);
      } catch {
        throw new DaemonStateReadinessError(
          "index_catalog_unavailable",
          "index_catalog",
          true,
        );
      }
      if (entry === undefined) {
        throw new DaemonStateReadinessError(
          "scope_not_published",
          "index_catalog",
          false,
        );
      }

      const { publication } = entry;
      if (
        publication.manifest.stateNamespaceId !==
          dependencies.stateIdentity.stateNamespaceId ||
        publication.binding.stateNamespaceId !==
          dependencies.stateIdentity.stateNamespaceId ||
        publication.manifest.securityDomain !==
          dependencies.stateIdentity.securityDomain ||
        publication.binding.securityDomain !==
          dependencies.stateIdentity.securityDomain
      ) {
        throw new DaemonStateReadinessError(
          "state_identity_mismatch",
          "index_catalog",
          false,
        );
      }

      const key = [
        publication.binding.connectorId,
        publication.binding.accessHandle,
        publication.manifest.embeddingProfile.id,
        publication.manifest.embeddingProfile.version,
      ].join("\u0000");
      if (checkedBindings.has(key)) continue;

      const vectorIndex = dependencies.vectorIndexes.resolve(
        publication.binding.connectorId,
      );
      if (vectorIndex === undefined) {
        throw new DaemonStateReadinessError(
          "index_binding_unavailable",
          "vector_index",
          false,
        );
      }
      const compatibility: VectorIndexCompatibility = {
        stateNamespaceId: dependencies.stateIdentity.stateNamespaceId,
        securityDomain: dependencies.stateIdentity.securityDomain,
        embeddingProfile: publication.manifest.embeddingProfile,
        payloadSchemaVersion: 2,
      };
      try {
        await vectorIndex.rehydrate({
          accessHandle: publication.binding.accessHandle,
          compatibility,
          signal,
        });
      } catch {
        if (signal.aborted) signal.throwIfAborted();
        throw new DaemonStateReadinessError(
          "index_binding_unavailable",
          "vector_index",
          true,
        );
      }
      checkedBindings.add(key);
    }
  }
}
