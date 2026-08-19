import type {
  ApprovedDocumentSelection,
  ApprovedScope,
  ApprovedScopeReference,
} from "./card-catalog.js";
import { canonicalDigest } from "./canonical-digest.js";
import { SelectionScopeInvariantError } from "./errors.js";

/**
 * What a Scope authorises, in the words a consumer may read.
 *
 * Every field is transcribed from an already approved Scope, so a guide can
 * never widen what was approved, and no field on it is a physical binding: a
 * connector id, an access handle and a security domain are our own
 * infrastructure coordinates, and none of them appears on any member of this
 * union. That is what lets the same value be both the record a consumer
 * receives and the thing Selection hands the executor — there is no second,
 * privileged shape to keep it away from.
 *
 * `limit` sits on the managed document member because it bounds the read
 * itself: the same Scope asked for five chunks and for fifty is two different
 * requests, and the key derived from this guide has to tell them apart.
 */
export type RetrievalGuide =
  | ManagedDocumentGuide
  | SqlRetrievalGuide
  | HttpRetrievalGuide;

/**
 * Where a document's evidence came from, in citable terms, and how much of it
 * was asked for.
 *
 * Structurally identical to `ApprovedDocumentIndexRef` today, and separate on
 * purpose: one is what a Card holds and the other is what a consumer receives,
 * and the two are free to move apart. `connectorId` and `accessHandle` used to
 * be the difference between them — infrastructure coordinates naming which store
 * and which handle inside it — and this guide was defined by their exclusion.
 * The read model no longer carries them at all, so there is nothing left here to
 * exclude.
 *
 * `documentIndexId`, `sourceId` and `indexVersion` do stay: they are what makes
 * a citation checkable against the registry, which is the same standard ADR 0001
 * holds SQL and HTTP coordinates to.
 *
 * `selector` carries the published field name rather than the catalog read
 * model's `selection`, so the one word means one thing from the published Scope
 * through to the answer.
 */
export interface ManagedDocumentGuide {
  readonly kind: "managed_document";
  readonly scopeRef: ApprovedScopeReference;
  readonly documentIndexId: string;
  readonly sourceId: string;
  readonly documentId: string;
  readonly indexVersion: string;
  readonly selector: ApprovedDocumentSelection;
  readonly limit: number;
}

/**
 * A verifiable coordinate into a consumer's table.
 *
 * `connector` names the consumer's own datasource — `postgres.main` — and is not
 * our infrastructure the way `connectorId` on a document index is. A consumer
 * cannot run the query without it, so it stays.
 *
 * `allowedOperations` is the "허용 연산" ADR 0001 requires to be stated rather
 * than assumed. A fixed `["select"]` tuple, not a configurable list.
 */
export interface SqlRetrievalGuide {
  readonly kind: "sql";
  readonly scopeRef: ApprovedScopeReference;
  readonly connector: string;
  readonly table: string;
  readonly columns: readonly string[];
  readonly allowedOperations: readonly ["select"];
}

/** A verifiable coordinate into a consumer's HTTP endpoint. Never called here. */
export interface HttpRetrievalGuide {
  readonly kind: "http";
  readonly scopeRef: ApprovedScopeReference;
  readonly connector: string;
  readonly method: string;
  readonly path: string;
}

/**
 * Transcribes one approved Scope into the guide it authorises.
 *
 * Total over `ApprovedScope`: every kind produces a guide, and there is no
 * branch that returns nothing. A selected Scope that vanished between selection
 * and delivery could not be told apart, downstream, from one that was never
 * selected at all.
 *
 * `limit` is applied to the managed document member only. The other two kinds
 * are handed to the consumer to execute, and how many rows or how large a
 * response that yields is not ours to bound.
 */
export function buildRetrievalGuide(
  scope: ApprovedScope,
  limit: number,
): RetrievalGuide {
  switch (scope.kind) {
    case "managed_document":
      return {
        kind: "managed_document",
        scopeRef: copyScopeRef(scope.reference),
        documentIndexId: scope.documentIndex.documentIndexId,
        sourceId: scope.documentIndex.sourceId,
        documentId: scope.documentIndex.documentId,
        indexVersion: scope.documentIndex.indexVersion,
        selector: copySelection(scope.selection),
        limit,
      };
    case "sql_source":
      return {
        kind: "sql",
        scopeRef: copyScopeRef(scope.reference),
        connector: scope.connector,
        table: scope.table,
        // Copied rather than aliased: the guide is handed to a consumer, and it
        // must not be a live window onto the catalog's own array.
        columns: [...scope.columns],
        allowedOperations: ["select"],
      };
    case "http_source":
      return {
        kind: "http",
        scopeRef: copyScopeRef(scope.reference),
        connector: scope.connector,
        method: scope.method,
        path: scope.path,
      };
    default:
      return refuseUnknownScope(scope);
  }
}

/**
 * The identity of one planned item: the canonical digest of its whole guide.
 *
 * Over the guide rather than over the Scope reference alone, and that is the
 * point of the merge it enables. Two Cards that authorise the same Scope under
 * the same bound authorise one read, and reading it twice would cost a consumer
 * two copies of the same evidence; two Cards that authorise the same Scope
 * under different bounds have not asked for the same thing, and merging them
 * would silently give one of the two an answer it did not request.
 */
export function retrievalGuideKey(guide: RetrievalGuide): string {
  return canonicalDigest(guide);
}

/** Copied for the same reason `columns` is: a guide never aliases catalog state. */
function copyScopeRef(reference: ApprovedScopeReference): ApprovedScopeReference {
  return {
    scopeId: reference.scopeId,
    scopeVersion: reference.scopeVersion,
  };
}

/** Copied for the same reason `columns` is: a guide never aliases catalog state. */
function copySelection(
  selection: ApprovedDocumentSelection,
): ApprovedDocumentSelection {
  if (selection.kind === "semantic_units") {
    return {
      kind: "semantic_units",
      semanticUnitIds: [...selection.semanticUnitIds],
    };
  }
  return { kind: "document" };
}

/**
 * Unreachable for any `ApprovedScope`, which is what the `never` binding
 * asserts: adding a fourth Scope kind breaks the build here instead of silently
 * dropping that kind from every resolution. At runtime it is reachable only
 * through an adapter that produced data outside the declared union, and that is
 * a corrupted read model, not an unsupported feature.
 */
function refuseUnknownScope(scope: never): never {
  const { kind } = scope as { readonly kind: unknown };

  throw new SelectionScopeInvariantError(
    `scope kind ${String(kind)} cannot be resolved into a retrieval guide`,
  );
}
