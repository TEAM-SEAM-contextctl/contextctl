/**
 * The approved Card read model this domain selects over.
 *
 * These types are a semantic mirror of the upstream registry shape, not a
 * compile-time link to it: the boundary test forbids a domain package from
 * importing another domain package, and no shared contract exists yet. The
 * `Approved` prefix keeps the two vocabularies distinguishable if they ever
 * meet in one file. Translating registry Cards into this model is the job of
 * an adapter the daemon assembles. See ADR 0004.
 */

/** What a Card claims to answer, and the wording a query may match on. */
export interface ApprovedCardMeaning {
  readonly description: string;
  readonly representativeQuestions: readonly string[];
  readonly aliases: readonly string[];
  readonly keywords: readonly string[];
}

/** Usage constraints carried alongside the Card, enforced during delivery. */
export interface ApprovedCardPolicy {
  readonly sensitive: boolean;
  readonly allowedUsage: readonly string[];
}

/** Identifies which version of a Retrieval Scope a selection was made against. */
export interface ApprovedScopeReference {
  readonly scopeId: string;
  readonly scopeVersion: string;
}

/**
 * Locates a published document index.
 *
 * `connectorId` and `accessHandle` are opaque here exactly as they are
 * upstream: this domain passes them to a retriever and never parses, resolves,
 * or interprets them.
 */
export interface ApprovedDocumentIndexRef {
  readonly documentIndexId: string;
  readonly sourceId: string;
  readonly documentId: string;
  readonly indexVersion: string;
  readonly connectorId: string;
  readonly accessHandle: string;
}

/** How much of an indexed document the Scope exposes. */
export type ApprovedDocumentSelection =
  | { readonly kind: "document" }
  | {
      readonly kind: "semantic_units";
      readonly semanticUnitIds: readonly string[];
    };

/** A Scope over a document we published and indexed ourselves. */
export interface ApprovedManagedDocumentScope {
  readonly kind: "managed_document";
  readonly reference: ApprovedScopeReference;
  readonly documentIndex: ApprovedDocumentIndexRef;
  readonly selection: ApprovedDocumentSelection;
}

/** A Scope over columns of a consumer's table. Coordinates only; never executed here. */
export interface ApprovedSqlScope {
  readonly kind: "sql_source";
  readonly reference: ApprovedScopeReference;
  readonly connector: string;
  readonly table: string;
  readonly columns: readonly string[];
}

/** A Scope over a consumer's HTTP endpoint. Coordinates only; never called here. */
export interface ApprovedHttpScope {
  readonly kind: "http_source";
  readonly reference: ApprovedScopeReference;
  readonly connector: string;
  readonly method: string;
  readonly path: string;
}

export type ApprovedScope =
  | ApprovedManagedDocumentScope
  | ApprovedSqlScope
  | ApprovedHttpScope;

/**
 * One Card whose current version is approved and therefore selectable.
 *
 * `versionId` is that current approved version, and it is the tie-break key the
 * ranking in `selection-verdict.ts` falls back to, so it has to be unique
 * across the candidates of a single selection.
 */
export interface ApprovedCard {
  readonly cardId: string;
  readonly versionId: string;
  readonly meaning: ApprovedCardMeaning;
  readonly policy: ApprovedCardPolicy;
  readonly scopes: readonly ApprovedScope[];
}
