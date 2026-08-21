import { describe, expect, it } from "vitest";

import type {
  EmbeddingProfile,
  PublishedScopeCatalogEntry,
} from "@contextctl/ingestion-indexing";
import type {
  ApprovedCard,
  ApprovedCardCatalog,
} from "@contextctl/selection-delivery";
import type { PublishedScopeRef } from "@contextctl/contracts";

import {
  computeRequiredEmbeddingBindings,
  NO_PUBLISHED_SCOPES,
  type ScopeProfileLookup,
} from "../../src/embedding/required-bindings.js";
import {
  localCardProfile,
  localDocumentProfile,
  remoteCardProfile,
  remoteDocumentProfile,
} from "./fakes.js";

/**
 * Which bindings a deployment is still on the hook for.
 *
 * The question configuration cannot answer. A published index is immutable and
 * an approved Card may still name a Scope inside one, so moving the publish path
 * to a hosted provider does not retire the profile that index was built under —
 * and searching it with vectors from a different model is exactly what the
 * design forbids. These cases are the difference between a migration that keeps
 * serving and one that starts failing every query touching an older Scope.
 */

function catalogOf(cards: readonly ApprovedCard[]): ApprovedCardCatalog {
  return { listApprovedCards: async () => cards };
}

function cardNaming(
  cardId: string,
  scopes: readonly { scopeId: string; scopeVersion: string }[],
): ApprovedCard {
  return {
    cardId,
    versionId: `${cardId}_v1`,
    meaning: {
      description: "d",
      representativeQuestions: [],
      aliases: [],
      keywords: [],
    },
    policy: { sensitive: false, allowedUsage: ["retrieval"] },
    scopes: scopes.map((reference) => ({
      kind: "managed_document" as const,
      reference,
      documentIndex: {
        documentIndexId: "idx_1",
        indexVersion: "v1",
        sourceId: "src_1",
        documentId: "doc_1",
      },
      selection: { kind: "document" as const },
    })),
  } as unknown as ApprovedCard;
}

/** A catalog answering a fixed profile for named Scopes and nothing else. */
function scopeCatalog(
  entries: Readonly<Record<string, EmbeddingProfile>>,
): ScopeProfileLookup {
  return {
    findScope: async (ref: PublishedScopeRef) => {
      const profile = entries[`${ref.scopeId}@${ref.scopeVersion}`];
      if (profile === undefined) return undefined;
      return {
        publication: { manifest: { embeddingProfile: profile } },
        scope: {},
      } as unknown as PublishedScopeCatalogEntry;
    },
  };
}

describe("required embedding bindings", () => {
  it("requires only the current profiles when nothing was published", async () => {
    const required = await computeRequiredEmbeddingBindings({
      documentProfile: localDocumentProfile(),
      cardProfile: localCardProfile(),
      catalog: catalogOf([]),
      publications: NO_PUBLISHED_SCOPES,
    });

    expect(required.documentProfiles).toHaveLength(1);
    expect(required.needsLocalAssets).toBe(true);
  });

  it("needs no local assets when both current profiles are remote", async () => {
    const required = await computeRequiredEmbeddingBindings({
      documentProfile: remoteDocumentProfile(),
      cardProfile: remoteCardProfile(),
      catalog: catalogOf([]),
      publications: NO_PUBLISHED_SCOPES,
    });

    // The whole point of a no-asset start: nothing in the required set opens a
    // model, so there is no artifact to install.
    expect(required.needsLocalAssets).toBe(false);
  });

  it("keeps needing assets while an approved Card reaches a local Scope", async () => {
    const older = localDocumentProfile("document-older-v1");
    const required = await computeRequiredEmbeddingBindings({
      documentProfile: remoteDocumentProfile(),
      cardProfile: remoteCardProfile(),
      catalog: catalogOf([
        cardNaming("card_1", [{ scopeId: "scope_1", scopeVersion: "1" }]),
      ]),
      publications: scopeCatalog({ "scope_1@1": older }),
    });

    // Both layers are configured remote and the deployment still cannot delete
    // the model, because the index behind `scope_1` can only be searched with
    // vectors from the profile it was published under.
    expect(required.needsLocalAssets).toBe(true);
    expect(required.documentProfiles.map((profile) => profile.id)).toEqual([
      "document-hosted-fake-v1",
      "document-older-v1",
    ]);
    const restored = required.requirements.find(
      (requirement) => requirement.reason === "approved_scope_profile",
    );
    expect(restored?.scopes).toEqual([{ scopeId: "scope_1", scopeVersion: "1" }]);
  });

  it("reports every Scope that kept a profile alive, once each", async () => {
    const older = localDocumentProfile("document-older-v1");
    const required = await computeRequiredEmbeddingBindings({
      documentProfile: remoteDocumentProfile(),
      cardProfile: remoteCardProfile(),
      // Two Cards naming one Scope, plus a second Scope on the same profile.
      catalog: catalogOf([
        cardNaming("card_1", [
          { scopeId: "scope_1", scopeVersion: "1" },
          { scopeId: "scope_2", scopeVersion: "1" },
        ]),
        cardNaming("card_2", [{ scopeId: "scope_1", scopeVersion: "1" }]),
      ]),
      publications: scopeCatalog({
        "scope_1@1": older,
        "scope_2@1": older,
      }),
    });

    const restored = required.requirements.find(
      (requirement) => requirement.reason === "approved_scope_profile",
    );
    expect(restored?.scopes).toEqual([
      { scopeId: "scope_1", scopeVersion: "1" },
      { scopeId: "scope_2", scopeVersion: "1" },
    ]);
  });

  it("does not duplicate the current profile when a Card still uses it", async () => {
    const current = localDocumentProfile();
    const required = await computeRequiredEmbeddingBindings({
      documentProfile: current,
      cardProfile: localCardProfile(),
      catalog: catalogOf([
        cardNaming("card_1", [{ scopeId: "scope_1", scopeVersion: "1" }]),
      ]),
      publications: scopeCatalog({ "scope_1@1": current }),
    });

    expect(required.documentProfiles).toHaveLength(1);
    expect(
      required.requirements.filter(
        (requirement) => requirement.layer === "document",
      ),
    ).toHaveLength(1);
  });

  it("skips a Scope the catalog no longer resolves", async () => {
    // Unreachable, which Registry's own reachability report is the surface for.
    // Refusing to start over a retired Scope would turn a reporting problem into
    // an outage.
    const required = await computeRequiredEmbeddingBindings({
      documentProfile: remoteDocumentProfile(),
      cardProfile: remoteCardProfile(),
      catalog: catalogOf([
        cardNaming("card_1", [{ scopeId: "scope_gone", scopeVersion: "9" }]),
      ]),
      publications: scopeCatalog({}),
    });

    expect(required.needsLocalAssets).toBe(false);
    expect(required.documentProfiles).toHaveLength(1);
  });

  it("counts the Card candidate index profile on its own", async () => {
    // The document layer needs nothing local; the Card layer does. One local
    // layer is enough to keep the artifact requirement.
    const required = await computeRequiredEmbeddingBindings({
      documentProfile: remoteDocumentProfile(),
      cardProfile: localCardProfile(),
      catalog: catalogOf([]),
      publications: NO_PUBLISHED_SCOPES,
    });

    expect(required.needsLocalAssets).toBe(true);
    const card = required.requirements.find(
      (requirement) => requirement.layer === "card",
    );
    expect(card?.needsLocalAssets).toBe(true);
  });
});
