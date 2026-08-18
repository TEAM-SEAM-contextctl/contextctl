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
 * The two read models happen to line up field for field today, so returning
 * Registry's entries unchanged would compile. It is written out by hand anyway
 * because the match is a coincidence, not a contract: the models are owned by
 * different domains and are free to move apart. Naming every field here means a
 * field Registry drops or renames, and any Scope kind it gains, fails this
 * translation at compile time instead of silently reshaping what Selection
 * sees at runtime.
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
        documentIndex: {
          documentIndexId: scope.documentIndex.documentIndexId,
          sourceId: scope.documentIndex.sourceId,
          documentId: scope.documentIndex.documentId,
          indexVersion: scope.documentIndex.indexVersion,
          connectorId: scope.documentIndex.connectorId,
          accessHandle: scope.documentIndex.accessHandle,
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
