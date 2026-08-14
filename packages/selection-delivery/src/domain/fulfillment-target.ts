import type {
  ApprovedDocumentIndexRef,
  ApprovedDocumentSelection,
  ApprovedManagedDocumentScope,
  ApprovedScopeReference,
} from "./card-catalog.js";

/**
 * Everything needed to actually read a managed document Scope, including the
 * infrastructure coordinates a consumer must never receive.
 *
 * This type is not reachable from `ContextResolution` by any path. That is a
 * stronger guarantee than leaving `connectorId` and `accessHandle` off
 * `ManagedDocumentGuide`: omitting a field means a future edit can put it back,
 * while an unreachable type means no `JSON.stringify` of a resolution can ever
 * touch these values, whatever anyone adds to the guide later. Keeping it in its
 * own file rather than beside the wire types makes the separation visible before
 * anyone reads the fields. See ADR 0006.
 *
 * `documentIndex` is carried whole rather than spread, so this stays a straight
 * hand-off to the retriever port: `connectorId` and `accessHandle` are opaque
 * here exactly as they are upstream, and this domain never parses, resolves, or
 * interprets them.
 */
export interface ManagedDocumentFulfillmentTarget {
  readonly scopeRef: ApprovedScopeReference;
  readonly documentIndex: ApprovedDocumentIndexRef;
  readonly selection: ApprovedDocumentSelection;
}

/**
 * Transcribes a managed document Scope into the target that reads it.
 *
 * Separate from `buildRetrievalGuide` on purpose, and narrower in its parameter:
 * a builder that returned both a guide and a target would put the physical
 * binding one property access away from whatever holds the guide, and the
 * unreachability above would stop being structural.
 */
export function buildFulfillmentTarget(
  scope: ApprovedManagedDocumentScope,
): ManagedDocumentFulfillmentTarget {
  return {
    scopeRef: scope.reference,
    documentIndex: scope.documentIndex,
    selection: scope.selection,
  };
}
