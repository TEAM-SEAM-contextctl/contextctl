import type {
  ConnectorId,
  DocumentId,
  DocumentIndexId,
  HttpParameterRef,
  IndexVersion,
  PublicationScopeId,
  PublicationScopeVersion,
  PublishedScope,
  SemanticUnitId,
  SourceId,
} from "@contextctl/contracts";

/** Version-pinned reference to the Scope revision a Card Version was built from. */
/**
 * One parameter an HTTP Scope accepts. Re-exported rather than kept private:
 * `HttpSourceScope.parameters` is part of the public read model, so a consumer
 * has to be able to name its element type.
 */
export type { HttpParameterRef };

export interface RetrievalScopeReference {
  readonly scopeId: PublicationScopeId;
  readonly scopeVersion: PublicationScopeVersion;
}

/**
 * Immutable, purely logical index reference in the approved Card read model.
 *
 * There is no connector or access handle here. Publication v2 stopped carrying
 * them, and Indexing resolves the physical binding from its own durable
 * catalog by this reference, so no credential-bearing value passes through
 * Registry at all. The invariant is structural rather than a rule anyone has
 * to remember.
 */
export interface DocumentIndexRef {
  readonly documentIndexId: DocumentIndexId;
  readonly sourceId: SourceId;
  readonly documentId: DocumentId;
  readonly indexVersion: IndexVersion;
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
  /**
   * Required, not optional. Two schemas can hold a table of the same name, and
   * without this the two collapse into one Scope that names neither.
   */
  readonly schema: string;
  readonly table: string;
  readonly columns: readonly string[];
}

export interface HttpSourceScope {
  readonly kind: "http_source";
  readonly reference: RetrievalScopeReference;
  readonly connector: ConnectorId;
  /** Read-only for now, and the contract pins it rather than trusting callers. */
  readonly method: "GET";
  readonly path: string;
  readonly operationId: string | undefined;
  /**
   * Path and query parameters the operation accepts. Part of the Scope
   * definition: two operations on one path differ by these alone.
   */
  readonly parameters: readonly HttpParameterRef[];
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
      schema: scope.schema,
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
    operationId: scope.operationId,
    parameters: [...scope.parameters],
  };
}
