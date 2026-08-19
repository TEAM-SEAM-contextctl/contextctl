import type {
  CardCatalogEntry,
  CardStore,
  RetrievalScope,
} from "@contextctl/registry-lifecycle";
import type {
  ApprovedCard,
  ApprovedCardCatalog,
  ApprovedScope,
} from "@contextctl/selection-delivery";

/**
 * Serves Selection's `ApprovedCardCatalog` from Registry's `CardStore`.
 *
 * The two read models used to line up field for field, and they no longer do:
 * Registry's managed document Scope still carries the physical binding, while
 * Selection's stops at the logical index reference. That divergence is exactly
 * why this translation is written out by hand rather than passing entries
 * through — the models are owned by different domains and are free to keep
 * moving apart. Naming every field here means a field Registry drops or
 * renames, and any Scope kind it gains, fails at compile time instead of
 * silently reshaping what Selection sees at runtime.
 *
 * Assembly lives in the daemon because it is the only Composition Root allowed
 * to depend on both domains.
 */
export class RegistryApprovedCardCatalog implements ApprovedCardCatalog {
  readonly #cards: CardStore;

  constructor(cards: CardStore) {
    this.#cards = cards;
  }

  async listApprovedCards(): Promise<readonly ApprovedCard[]> {
    // Registry hands over a versioned snapshot; Selection's port asks for the
    // cards alone. The version is dropped here rather than invented later:
    // ADR 0004 keeps this read model on Selection's side, so widening it to
    // carry a catalog version is that domain's decision, not the adapter's.
    const snapshot = await this.#cards.listApprovedCards();
    return snapshot.cards.map(toApprovedCard);
  }
}

function toApprovedCard(entry: CardCatalogEntry): ApprovedCard {
  return {
    cardId: entry.cardId,
    versionId: entry.versionId,
    meaning: {
      description: entry.meaning.description,
      representativeQuestions: [...entry.meaning.representativeQuestions],
      aliases: [...entry.meaning.aliases],
      keywords: [...entry.meaning.keywords],
    },
    policy: {
      sensitive: entry.policy.sensitive,
      allowedUsage: [...entry.policy.allowedUsage],
    },
    scopes: entry.scopes.map(toApprovedScope),
  };
}

function toApprovedScope(scope: RetrievalScope): ApprovedScope {
  switch (scope.kind) {
    case "managed_document":
      return {
        kind: "managed_document",
        reference: {
          scopeId: scope.reference.scopeId,
          scopeVersion: scope.reference.scopeVersion,
        },
        // Registry's v1 Scope still carries `connectorId` and `accessHandle`,
        // and they stop here. Selection's `ApprovedDocumentIndexRef` names four
        // logical fields only, so the physical pair is read off the entry and
        // deliberately not written out: Indexing resolves the binding from its
        // own durable catalog, under its own authority. Dropping it in the
        // adapter rather than in Selection means the narrowing happens once, at
        // the boundary, instead of every layer downstream having to remember
        // not to project two fields it was handed.
        documentIndex: {
          documentIndexId: scope.documentIndex.documentIndexId,
          sourceId: scope.documentIndex.sourceId,
          documentId: scope.documentIndex.documentId,
          indexVersion: scope.documentIndex.indexVersion,
        },
        selection:
          scope.selection.kind === "document"
            ? { kind: "document" }
            : {
                kind: "semantic_units",
                semanticUnitIds: [...scope.selection.semanticUnitIds],
              },
      };
    case "sql_source":
      return {
        kind: "sql_source",
        reference: {
          scopeId: scope.reference.scopeId,
          scopeVersion: scope.reference.scopeVersion,
        },
        connector: scope.connector,
        table: scope.table,
        columns: [...scope.columns],
      };
    case "http_source":
      return {
        kind: "http_source",
        reference: {
          scopeId: scope.reference.scopeId,
          scopeVersion: scope.reference.scopeVersion,
        },
        connector: scope.connector,
        method: scope.method,
        path: scope.path,
      };
    default: {
      const unreachable: never = scope;
      throw new Error(
        `unknown retrieval scope kind: ${JSON.stringify(unreachable)}`,
      );
    }
  }
}
