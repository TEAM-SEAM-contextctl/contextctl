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
 * Locates a published document index, logically and only logically.
 *
 * There is no `connectorId` and no `accessHandle`. They were here once, opaque
 * and passed straight through to a retriever, and every layer below this one
 * then had to remember not to project them — ADR 0006 records the four fields
 * excluded from the public guide, and the exclusion was a rule someone had to
 * keep applying. It is now a property of the type: a value this model never
 * receives cannot be leaked by a later edit, serialized into a response, or
 * embedded into a Card vector.
 *
 * Nothing downstream loses anything by it. A managed read is planned from a
 * Scope reference alone (`selection-plan.ts`), and the executor resolves the
 * physical binding from Indexing's own durable catalog under its own authority
 * — which is where that decision belonged in the first place, since choosing
 * which store is read and under whose isolation is not a judgement this domain
 * is in any position to make.
 *
 * The four that remain are what makes a citation checkable against the
 * registry, the same standard ADR 0001 holds SQL and HTTP coordinates to.
 */
export interface ApprovedDocumentIndexRef {
  readonly documentIndexId: string;
  readonly sourceId: string;
  readonly documentId: string;
  readonly indexVersion: string;
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
  /**
   * Required, not optional, and that is the whole point of it being here.
   *
   * One connector can hold `public.payments` and `analytics.payments`, and
   * without this they are one coordinate that names neither: two Cards would
   * produce the same guide, the same selection text and therefore the same
   * vector. A consumer handed such a guide cannot know which table it was
   * granted, which is the one thing a coordinate has to answer.
   */
  readonly schema: string;
  readonly table: string;
  readonly columns: readonly string[];
}

/**
 * One parameter an HTTP operation accepts.
 *
 * Declared here rather than imported. This package depends on no other — not
 * even on `contracts` — and ADR 0004 keeps the approved read model Selection's
 * own: these types are a semantic mirror of the upstream shape, not a
 * compile-time link to it. Importing the producer's type to save five lines
 * would trade that for a workspace dependency, a project reference and a
 * boundary-test entry, and would make Ingestion's versioning cadence this
 * domain's problem.
 */
export interface ApprovedHttpParameter {
  readonly location: "path" | "query";
  readonly name: string;
  readonly required: boolean;
}

/** A Scope over a consumer's HTTP endpoint. Coordinates only; never called here. */
export interface ApprovedHttpScope {
  readonly kind: "http_source";
  readonly reference: ApprovedScopeReference;
  readonly connector: string;
  readonly method: string;
  readonly path: string;
  /**
   * The operation's own name, when the source declared one.
   *
   * Optional because a source may not name its operations at all, and inventing
   * an identifier for one that has none would put a coordinate in a guide that
   * the consumer cannot look up.
   */
  readonly operationId: string | undefined;
  /**
   * Path and query parameters the operation accepts.
   *
   * Part of the Scope rather than decoration: two operations on one path differ
   * by these alone, so a Scope that omitted them would collapse them exactly as
   * a missing `schema` collapses two tables.
   */
  readonly parameters: readonly ApprovedHttpParameter[];
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
