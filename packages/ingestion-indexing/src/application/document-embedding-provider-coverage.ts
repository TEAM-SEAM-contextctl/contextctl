import {
  PublishedScopeRefSchema,
  type PublishedScopeRef,
} from "@contextctl/contracts";

import type { EmbeddingProfile } from "../domain/embedding-profile.js";
import { canonicalJson } from "../domain/revision-identity.js";
import {
  IndexCatalogFault,
  type IndexPublicationStore,
} from "../ports/index-publication-store.js";
import type { QueryEmbeddingProviderResolver } from "../ports/managed-document-search.js";

export interface DocumentEmbeddingProviderCoverageInput {
  readonly securityDomain: string;
  /** Approved logical Scopes that must remain searchable after reconfiguration. */
  readonly reachableScopes: readonly PublishedScopeRef[];
  readonly publications: IndexPublicationStore;
  /** Candidate provider set after the requested configuration change. */
  readonly embeddingProviders: QueryEmbeddingProviderResolver;
}

export interface RequiredDocumentEmbeddingProvider {
  readonly providerId: string;
  readonly embeddingProfile: EmbeddingProfile;
  readonly scopeRefs: readonly PublishedScopeRef[];
}

export type DocumentEmbeddingProviderCoverageErrorCode =
  | "catalog_corrupt"
  | "catalog_schema_unsupported"
  | "catalog_unavailable"
  | "embedding_provider_not_allowed"
  | "invalid_request"
  | "scope_not_published"
  | "security_domain_mismatch";

export class DocumentEmbeddingProviderCoverageError extends Error {
  constructor(
    readonly code: DocumentEmbeddingProviderCoverageErrorCode,
    readonly retriable = false,
  ) {
    super(`Document embedding provider coverage failed: ${code}`);
    this.name = "DocumentEmbeddingProviderCoverageError";
  }
}

/**
 * Refuses removal of a provider while an approved Scope still reaches an Index
 * created under its exact profile.
 *
 * Registry supplies only logical Scope references. Indexing alone resolves
 * those references through its durable Catalog; neither physical bindings nor
 * reverse lifecycle commands cross the boundary.
 */
export async function assertDocumentEmbeddingProviderCoverage(
  input: DocumentEmbeddingProviderCoverageInput,
): Promise<readonly RequiredDocumentEmbeddingProvider[]> {
  if (
    input.securityDomain.trim() === "" ||
    input.reachableScopes.some(
      (scopeRef) => !PublishedScopeRefSchema.safeParse(scopeRef).success,
    )
  ) {
    throw new DocumentEmbeddingProviderCoverageError("invalid_request");
  }

  const requirements = new Map<
    string,
    {
      providerId: string;
      embeddingProfile: EmbeddingProfile;
      scopeRefs: Map<string, PublishedScopeRef>;
    }
  >();
  const uniqueScopes = new Map(
    input.reachableScopes.map((scopeRef) => [scopeKey(scopeRef), scopeRef]),
  );

  for (const scopeRef of uniqueScopes.values()) {
    let entry;
    try {
      entry = await input.publications.findScope(scopeRef);
    } catch (error) {
      throw mapCatalogError(error);
    }
    if (entry === undefined) {
      throw new DocumentEmbeddingProviderCoverageError("scope_not_published");
    }
    if (
      entry.scope.scopeId !== scopeRef.scopeId ||
      entry.scope.scopeVersion !== scopeRef.scopeVersion
    ) {
      throw new DocumentEmbeddingProviderCoverageError("catalog_corrupt");
    }
    if (
      entry.publication.binding.securityDomain !== input.securityDomain ||
      entry.publication.manifest.securityDomain !== input.securityDomain
    ) {
      throw new DocumentEmbeddingProviderCoverageError(
        "security_domain_mismatch",
      );
    }
    const profile = entry.publication.manifest.embeddingProfile;
    const binding = input.embeddingProviders.resolve({
      securityDomain: input.securityDomain,
      embeddingProfile: profile,
    });
    if (binding === undefined) {
      throw new DocumentEmbeddingProviderCoverageError(
        "embedding_provider_not_allowed",
      );
    }
    const key = `${binding.providerId}\u0000${canonicalJson(profile)}`;
    const requirement = requirements.get(key) ?? {
      providerId: binding.providerId,
      embeddingProfile: structuredClone(profile),
      scopeRefs: new Map<string, PublishedScopeRef>(),
    };
    requirement.scopeRefs.set(scopeKey(scopeRef), structuredClone(scopeRef));
    requirements.set(key, requirement);
  }

  return [...requirements.values()]
    .map((requirement) => ({
      providerId: requirement.providerId,
      embeddingProfile: requirement.embeddingProfile,
      scopeRefs: [...requirement.scopeRefs.values()].sort((left, right) =>
        compareText(scopeKey(left), scopeKey(right)),
      ),
    }))
    .sort((left, right) =>
      compareText(
        `${left.providerId}\u0000${canonicalJson(left.embeddingProfile)}`,
        `${right.providerId}\u0000${canonicalJson(right.embeddingProfile)}`,
      ),
    );
}

function scopeKey(scopeRef: PublishedScopeRef): string {
  return `${scopeRef.scopeId}\u0000${scopeRef.scopeVersion}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function mapCatalogError(
  error: unknown,
): DocumentEmbeddingProviderCoverageError {
  if (error instanceof IndexCatalogFault) {
    if (error.code === "corrupt_record") {
      return new DocumentEmbeddingProviderCoverageError("catalog_corrupt");
    }
    if (error.code === "schema_unsupported") {
      return new DocumentEmbeddingProviderCoverageError(
        "catalog_schema_unsupported",
      );
    }
    return new DocumentEmbeddingProviderCoverageError(
      "catalog_unavailable",
      error.retriable,
    );
  }
  return new DocumentEmbeddingProviderCoverageError(
    "catalog_unavailable",
    true,
  );
}
