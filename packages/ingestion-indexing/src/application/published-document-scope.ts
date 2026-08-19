import {
  PublishedDocumentIndexRefSchema,
  PublishedDocumentScopeSchema,
  type PublishedDocumentIndexRef,
  type PublishedDocumentScope,
} from "@contextctl/contracts";

import type { IndexManifest } from "../domain/index-manifest.js";
import {
  revisionIdentity,
  stableIdentity,
} from "../domain/revision-identity.js";

export interface SemanticPublishedScopeInput {
  readonly semanticUnitIds: readonly string[];
}

export interface CreatePublishedDocumentScopesInput {
  readonly manifest: IndexManifest;
  readonly semanticScopes?: readonly SemanticPublishedScopeInput[];
}

export type PublishedDocumentScopeErrorCode =
  | "duplicate_scope"
  | "invalid_index_reference"
  | "invalid_semantic_scope";

export class PublishedDocumentScopeError extends Error {
  constructor(readonly code: PublishedDocumentScopeErrorCode) {
    super(`Published document scope construction failed: ${code}`);
    this.name = "PublishedDocumentScopeError";
  }
}

/**
 * Produces the contract boundary values for one verified Manifest. The
 * physical store remains hidden in the Indexing-owned catalog binding.
 */
export function createPublishedDocumentScopes(
  input: CreatePublishedDocumentScopesInput,
): readonly PublishedDocumentScope[] {
  const documentIndex = parseIndexReference({
    documentIndexId: input.manifest.documentIndexId,
    sourceId: input.manifest.sourceId,
    documentId: input.manifest.documentId,
    indexVersion: input.manifest.indexVersion,
  });
  const selectors: Array<
    | { readonly kind: "document" }
    | {
        readonly kind: "semantic_units";
        readonly semanticUnitIds: readonly string[];
      }
  > = [{ kind: "document" }];

  for (const candidate of input.semanticScopes ?? []) {
    const semanticUnitIds = [...new Set(candidate.semanticUnitIds)].sort();
    if (
      semanticUnitIds.length === 0 ||
      semanticUnitIds.length !== candidate.semanticUnitIds.length ||
      semanticUnitIds.some(
        (unitId) => input.manifest.semanticUnitRevisions[unitId] === undefined,
      )
    ) {
      throw new PublishedDocumentScopeError("invalid_semantic_scope");
    }
    selectors.push({ kind: "semantic_units", semanticUnitIds });
  }
  selectors.sort((left, right) => {
    if (left.kind === "document") return -1;
    if (right.kind === "document") return 1;
    const leftKey = left.semanticUnitIds.join("\u0000");
    const rightKey = right.semanticUnitIds.join("\u0000");
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });

  const seen = new Set<string>();
  return selectors.map((selector) => {
    const scopeId = stableIdentity("scope", {
      documentIndexId: input.manifest.documentIndexId,
      selector,
    });
    const scopeVersion = revisionIdentity("scpv", {
      kind: "managed_document",
      indexVersion: input.manifest.indexVersion,
      selector,
    });
    const identity = `${scopeId}:${scopeVersion}`;
    if (seen.has(identity)) {
      throw new PublishedDocumentScopeError("duplicate_scope");
    }
    seen.add(identity);
    const parsed = PublishedDocumentScopeSchema.safeParse({
      scopeId,
      scopeVersion,
      kind: "managed_document",
      documentIndex,
      selector,
    });
    if (!parsed.success) {
      throw new PublishedDocumentScopeError("invalid_semantic_scope");
    }
    return parsed.data;
  });
}

function parseIndexReference(
  value: PublishedDocumentIndexRef,
): PublishedDocumentIndexRef {
  const parsed = PublishedDocumentIndexRefSchema.safeParse(value);
  if (!parsed.success) {
    throw new PublishedDocumentScopeError("invalid_index_reference");
  }
  return parsed.data;
}
