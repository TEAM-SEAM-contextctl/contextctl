import type { PublishedScopeRef } from "@contextctl/contracts";
import {
  isDocumentRetrievalEmbeddingProfile,
  type EmbeddingProfile,
  type PublishedScopeCatalogEntry,
} from "@contextctl/ingestion-indexing";
import {
  isCardSelectionEmbeddingProfile,
  type ApprovedCardCatalog,
  type CardSelectionProfile,
} from "@contextctl/selection-delivery";

import type { EmbeddingLayer } from "./configuration.js";

/**
 * Why one profile still has to be bound.
 *
 * Reported rather than reduced to a boolean because the three sources answer
 * different operator questions. "Assets are required" is not actionable; "assets
 * are required because two approved Cards still point at a Scope published under
 * the fp32 profile" tells an operator what to migrate before the requirement
 * goes away.
 */
export type EmbeddingBindingReason =
  /** The profile the publish path is currently writing under. */
  | "current_document_profile"
  /** An approved Card still references a Scope published under this profile. */
  | "approved_scope_profile"
  /** The profile the active Card candidate index is built under. */
  | "card_candidate_index_profile";

/** A Scope named logically. No connector, no access handle, ever. */
export interface RequiredScopeReference {
  readonly scopeId: string;
  readonly scopeVersion: string;
}

export interface EmbeddingBindingRequirement {
  readonly layer: EmbeddingLayer;
  readonly reason: EmbeddingBindingReason;
  readonly profileId: string;
  readonly profileVersion: string;
  /** Whether satisfying this requirement means reading a local artifact. */
  readonly needsLocalAssets: boolean;
  /**
   * The Scopes that kept this profile alive, when the reason is a Scope.
   *
   * An operator needs to know which Scopes to retire before the requirement
   * disappears, and that is a catalog question they can act on. The physical
   * binding stays inside Indexing and never appears here.
   */
  readonly scopes: readonly RequiredScopeReference[];
}

/**
 * Every provider binding this deployment has to be able to serve.
 *
 * Not the same as "the configured profile". A published index is immutable and
 * an approved Card may still reference a Scope inside one, so a deployment that
 * moved its publish path to a remote provider yesterday must keep answering
 * queries against everything it published under the old local profile. The
 * design forbids searching such an index with query vectors from a different
 * model, so the alternative to keeping the binding is a closed failure on every
 * query that touches it.
 */
export interface RequiredEmbeddingBindings {
  /**
   * Distinct document profiles needing a registered query provider.
   *
   * `StaticQueryEmbeddingProviderRegistry` keys on the exact profile with no
   * wildcard, so one registration per distinct profile is not an optimization.
   * It is the only way a query against an older index resolves a provider at
   * all.
   */
  readonly documentProfiles: readonly EmbeddingProfile[];
  readonly cardProfile: CardSelectionProfile;
  readonly requirements: readonly EmbeddingBindingRequirement[];
  /**
   * Whether any requirement above is satisfied by a local artifact.
   *
   * This is the value that decides whether the Granite assets have to be present
   * at startup. It is false only when nothing in the required set loads a model,
   * which is what makes a no-asset start legal.
   */
  readonly needsLocalAssets: boolean;
}

/**
 * The one catalog read this computation needs.
 *
 * Narrower than `IndexPublicationStore` on purpose. A deployment that has
 * published nothing has no database to open, and asking for the full store would
 * make a read-only probe create the file it was only supposed to look at — which
 * is a thing `contextctl status` is explicitly tested not to do. The durable
 * store satisfies this structurally, and "nothing was ever published" is an
 * object literal.
 */
export interface ScopeProfileLookup {
  findScope(
    scopeRef: PublishedScopeRef,
  ): Promise<PublishedScopeCatalogEntry | undefined>;
}

/** Answers for a deployment whose index catalog does not exist yet. */
export const NO_PUBLISHED_SCOPES: ScopeProfileLookup = {
  findScope: async () => undefined,
};

export interface RequiredEmbeddingBindingsInput {
  /** The profile the publish path writes under right now. */
  readonly documentProfile: EmbeddingProfile;
  /** The profile the active Card candidate index is built under. */
  readonly cardProfile: CardSelectionProfile;
  readonly catalog: ApprovedCardCatalog;
  readonly publications: ScopeProfileLookup;
}

/**
 * Computes the binding set from live state, not from configuration.
 *
 * Configuration says what the operator wants next. This says what the daemon is
 * still on the hook for, and the two differ for as long as a migration is in
 * flight. Reading approved Cards and resolving each managed Scope against
 * Indexing's own catalog is what makes the difference visible.
 *
 * A Scope that no longer resolves is skipped rather than raising. It is
 * unreachable, Registry's own reachability report is the surface that says so,
 * and refusing to start because a retired Scope is still referenced would turn a
 * reporting problem into an outage.
 */
export async function computeRequiredEmbeddingBindings(
  input: RequiredEmbeddingBindingsInput,
): Promise<RequiredEmbeddingBindings> {
  const requirements: EmbeddingBindingRequirement[] = [];
  const documentProfiles = new Map<string, EmbeddingProfile>();

  const currentKey = profileKey(input.documentProfile);
  documentProfiles.set(currentKey, input.documentProfile);
  requirements.push({
    layer: "document",
    reason: "current_document_profile",
    profileId: input.documentProfile.id,
    profileVersion: input.documentProfile.version,
    needsLocalAssets: documentProfileNeedsLocalAssets(input.documentProfile),
    scopes: [],
  });

  const scopesByProfile = new Map<string, RequiredScopeReference[]>();
  const cards = await input.catalog.listApprovedCards();
  for (const card of cards) {
    for (const scope of card.scopes) {
      if (scope.kind !== "managed_document") continue;
      const entry = await input.publications.findScope(scope.reference);
      if (entry === undefined) continue;
      const profile = entry.publication.manifest.embeddingProfile;
      const key = profileKey(profile);
      if (!documentProfiles.has(key)) {
        documentProfiles.set(key, profile);
      }
      const seen = scopesByProfile.get(key) ?? [];
      // Several Cards may reference one Scope; the requirement is the Scope's.
      const duplicate = seen.some(
        (already) =>
          already.scopeId === scope.reference.scopeId &&
          already.scopeVersion === scope.reference.scopeVersion,
      );
      if (!duplicate) {
        seen.push({
          scopeId: scope.reference.scopeId,
          scopeVersion: scope.reference.scopeVersion,
        });
      }
      scopesByProfile.set(key, seen);
    }
  }

  for (const [key, scopes] of scopesByProfile) {
    if (key === currentKey) {
      // Already required as the current profile. The Scopes are further
      // evidence for a binding that exists either way, not a second binding.
      continue;
    }
    const profile = documentProfiles.get(key);
    if (profile === undefined) continue;
    requirements.push({
      layer: "document",
      reason: "approved_scope_profile",
      profileId: profile.id,
      profileVersion: profile.version,
      needsLocalAssets: documentProfileNeedsLocalAssets(profile),
      scopes: sortScopes(scopes),
    });
  }

  requirements.push({
    layer: "card",
    reason: "card_candidate_index_profile",
    profileId: input.cardProfile.id,
    profileVersion: input.cardProfile.version,
    needsLocalAssets: cardProfileNeedsLocalAssets(input.cardProfile),
    scopes: [],
  });

  return {
    documentProfiles: [...documentProfiles.values()],
    cardProfile: input.cardProfile,
    requirements,
    needsLocalAssets: requirements.some(
      (requirement) => requirement.needsLocalAssets,
    ),
  };
}

/**
 * Whether a document profile is satisfied by reading a local artifact.
 *
 * A profile without production execution semantics, such as the deterministic
 * one test compositions use, pins no artifact and therefore needs none. Saying
 * so here rather than at the call site keeps "no execution block" from being
 * read as "local by default", which would make every test composition demand a
 * 390MB download.
 */
export function documentProfileNeedsLocalAssets(
  profile: EmbeddingProfile,
): boolean {
  return (
    isDocumentRetrievalEmbeddingProfile(profile) &&
    profile.execution.kind === "local"
  );
}

export function cardProfileNeedsLocalAssets(
  profile: CardSelectionProfile,
): boolean {
  return (
    isCardSelectionEmbeddingProfile(profile) && profile.execution.kind === "local"
  );
}

/**
 * Identity for the purpose of "is this the same binding".
 *
 * Id and version together, matching how a profile is versioned: any change to
 * vector semantics is required to bump the version, so two profiles agreeing on
 * both agree on everything a provider would be selected for.
 */
function profileKey(profile: EmbeddingProfile): string {
  return `${profile.id} ${profile.version}`;
}

function sortScopes(
  scopes: readonly RequiredScopeReference[],
): readonly RequiredScopeReference[] {
  return [...scopes].sort(
    (left, right) =>
      left.scopeId.localeCompare(right.scopeId) ||
      left.scopeVersion.localeCompare(right.scopeVersion),
  );
}
