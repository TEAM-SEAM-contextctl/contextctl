import type {
  ConnectorId,
  DocumentId,
  DocumentIndexId,
  IndexVersion,
  PublicationScopeId,
  PublicationScopeVersion,
  PublishedScope,
  SemanticUnitId,
  SourceId,
} from "@contextctl/contracts";

/** Version-pinned reference to the Scope revision a Card Version was built from. */
export interface RetrievalScopeReference {
  readonly scopeId: PublicationScopeId;
  readonly scopeVersion: PublicationScopeVersion;
}

/**
 * Immutable index reference carried in the approved Card read model. The
 * connector and access handle stay opaque: Registry never interprets them, and
 * they reach the physical index only through Selection's internal fulfillment
 * target, which the daemon adapter hands to Indexing's search surface. They are
 * never projected into the public RetrievalGuide or any consumer transport.
 */
export interface DocumentIndexRef {
  readonly documentIndexId: DocumentIndexId;
  readonly sourceId: SourceId;
  readonly documentId: DocumentId;
  readonly indexVersion: IndexVersion;
  readonly connectorId: ConnectorId;
  readonly accessHandle: string;
}

/** Whole document, or the specific semantic units Registry admitted. */
export type ManagedDocumentSelection =
  | { readonly kind: "document" }
  | {
      readonly kind: "semantic_units";
      readonly semanticUnitIds: readonly SemanticUnitId[];
    };

export interface ManagedDocumentScope {
  readonly kind: "managed_document";
  readonly reference: RetrievalScopeReference;
  readonly documentIndex: DocumentIndexRef;
  readonly selection: ManagedDocumentSelection;
}

export interface SqlSourceScope {
  readonly kind: "sql_source";
  readonly reference: RetrievalScopeReference;
  readonly connector: ConnectorId;
  readonly table: string;
  readonly columns: readonly string[];
}

export interface HttpSourceScope {
  readonly kind: "http_source";
  readonly reference: RetrievalScopeReference;
  readonly connector: ConnectorId;
  readonly method: string;
  readonly path: string;
}

/**
 * The search range a Card points at, owned by Registry. It is translated from
 * a PublishedScope rather than passed through, so Ingestion's input shape never
 * leaks into the approved Card read model Selection consumes.
 */
export type RetrievalScope =
  | ManagedDocumentScope
  | SqlSourceScope
  | HttpSourceScope;

/** Translates one Ingestion-published Scope into Registry's read model. */
export function translatePublishedScope(scope: PublishedScope): RetrievalScope {
  const reference: RetrievalScopeReference = {
    scopeId: scope.scopeId,
    scopeVersion: scope.scopeVersion,
  };

  if (scope.kind === "managed_document") {
    return {
      kind: "managed_document",
      reference,
      documentIndex: {
        documentIndexId: scope.documentIndex.documentIndexId,
        sourceId: scope.documentIndex.sourceId,
        documentId: scope.documentIndex.documentId,
        indexVersion: scope.documentIndex.indexVersion,
        connectorId: scope.documentIndex.connectorId,
        accessHandle: scope.documentIndex.accessHandle,
      },
      selection:
        scope.selector.kind === "document"
          ? { kind: "document" }
          : {
              kind: "semantic_units",
              semanticUnitIds: [...scope.selector.semanticUnitIds],
            },
    };
  }

  if (scope.kind === "sql_source") {
    return {
      kind: "sql_source",
      reference,
      connector: scope.connector,
      table: scope.table,
      columns: [...scope.columns],
    };
  }

  return {
    kind: "http_source",
    reference,
    connector: scope.connector,
    method: scope.method,
    path: scope.path,
  };
}
