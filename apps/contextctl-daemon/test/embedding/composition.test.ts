import { describe, expect, it, vi } from "vitest";

import { EmbeddingProviderFault } from "@contextctl/ingestion-indexing";

import {
  composeCardEmbedding,
  composeDocumentEmbedding,
  EmbeddingCompositionError,
} from "../../src/embedding/composition.js";
import {
  EmbeddingModeProfileMismatchError,
  IngestionDocumentEmbeddingProviderFactory,
  SelectionCardEmbeddingProviderFactory,
} from "../../src/embedding/provider-factory.js";
import { RemoteEmbeddingBindingError } from "../../src/embedding/remote-binding.js";
import {
  cardLayer,
  documentLayer,
  FakeCardEmbeddingProviderFactory,
  FakeDocumentEmbeddingProviderFactory,
  localCardProfile,
  localDocumentProfile,
  remoteCardProfile,
  remoteBinding,
  remoteDocumentProfile,
  SECURITY_DOMAIN,
} from "./fakes.js";

/**
 * The four ways a deployment can bind its two embedding layers.
 *
 * Written against injected fakes rather than only the shipped adapters. The
 * composition's job — choose a binding per layer, refuse a contradiction, read
 * local assets only when something needs them — is decided before any adapter
 * is constructed. Testing every case only through a real adapter would require
 * both a 390MB download and hosted endpoints; the concrete remote bindings are
 * covered above and by the release product gate.
 *
 * Each combination asserts the two layers separately. A test that only checked
 * "it assembled" would pass on a composition that had quietly bound both layers
 * the same way, which is the one failure this whole surface exists to prevent.
 */
describe("embedding composition", () => {
  it("binds Ingestion's concrete remote adapter to the exact profile", () => {
    const profile = remoteDocumentProfile();
    const provider = new IngestionDocumentEmbeddingProviderFactory().createRemote({
      profile,
      binding: remoteBinding("document"),
    });

    expect(provider.providerKind).toBe("remote");
    expect(provider.embeddingProfile).toEqual(profile);
  });

  it("binds Selection's concrete remote adapter to its own endpoint and credential", async () => {
    const profile = remoteCardProfile();
    const fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          model: profile.model,
          data: [
            {
              index: 0,
              embedding: [1, ...new Array<number>(profile.dimensions - 1).fill(0)],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    try {
      const provider = new SelectionCardEmbeddingProviderFactory().createRemote({
        profile,
        binding: remoteBinding("card"),
      });

      expect(provider.providerKind).toBe("remote");
      expect(provider.profile).toEqual(profile);
      await expect(
        provider.embed({
          profile,
          inputs: [{ key: "card-query", text: "배송 조회" }],
        }),
      ).resolves.toHaveLength(1);
      expect(fetch).toHaveBeenCalledWith(
        "https://cards.example/v1/embeddings",
        expect.objectContaining({
          method: "POST",
          headers: {
            authorization: "Bearer key-for-card",
            "content-type": "application/json",
          },
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("injects a verified physical resource without reopening its asset path", async () => {
    const profile = localDocumentProfile();
    if (profile.execution.kind !== "local") {
      throw new Error("fixture must be a local production profile");
    }
    const factory = new IngestionDocumentEmbeddingProviderFactory([
      {
        execution: profile.execution,
        tokenCount: () => 1,
        embed: async (texts) => ({
          dimensions: [texts.length, profile.dimensions],
          data: texts.flatMap(() => [1, ...new Array(profile.dimensions - 1).fill(0)]),
        }),
      },
    ]);
    const provider = factory.createLocal({
      profile,
      artifactDirectory: "/path/that/does/not/exist",
    });

    await expect(
      provider.embed({
        profile,
        inputs: [{ key: "query", text: "alpha" }],
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual([
      {
        key: "query",
        vector: [1, ...new Array(profile.dimensions - 1).fill(0)],
      },
    ]);
  });

  describe("the four layer combinations", () => {
    it("binds both layers locally", () => {
      const documentFactory = new FakeDocumentEmbeddingProviderFactory();
      const cardFactory = new FakeCardEmbeddingProviderFactory();

      const document = composeDocumentEmbedding({
        configuration: documentLayer("local"),
        currentProfile: localDocumentProfile(),
        reachableProfiles: [],
        securityDomain: SECURITY_DOMAIN,
        artifactDirectory: "/assets/rev_a",
        factory: documentFactory,
      });
      const card = composeCardEmbedding({
        configuration: cardLayer("local"),
        profile: localCardProfile(),
        securityDomain: SECURITY_DOMAIN,
        artifactDirectory: "/assets/rev_a",
        factory: cardFactory,
      });

      expect(documentFactory.calls).toEqual([
        { mode: "local", artifactDirectory: "/assets/rev_a" },
      ]);
      expect(cardFactory.calls).toEqual([
        { mode: "local", artifactDirectory: "/assets/rev_a" },
      ]);
      expect(document.report.mode).toBe("local");
      expect(card.report.mode).toBe("local");
    });

    it("keeps documents local while Card text goes to a provider", () => {
      const documentFactory = new FakeDocumentEmbeddingProviderFactory();
      const cardFactory = new FakeCardEmbeddingProviderFactory();

      composeDocumentEmbedding({
        configuration: documentLayer("local"),
        currentProfile: localDocumentProfile(),
        reachableProfiles: [],
        securityDomain: SECURITY_DOMAIN,
        artifactDirectory: "/assets/rev_a",
        factory: documentFactory,
      });
      const card = composeCardEmbedding({
        configuration: cardLayer("remote"),
        profile: remoteCardProfile(),
        securityDomain: SECURITY_DOMAIN,
        factory: cardFactory,
      });

      expect(documentFactory.calls).toEqual([
        { mode: "local", artifactDirectory: "/assets/rev_a" },
      ]);
      expect(cardFactory.calls).toEqual([
        { mode: "remote", endpoint: "https://cards.example/v1/embeddings" },
      ]);
      expect(card.report.remote?.endpoint).toBe(
        "https://cards.example/v1/embeddings",
      );
    });

    it("sends documents to a provider while Cards stay local", () => {
      const documentFactory = new FakeDocumentEmbeddingProviderFactory();
      const cardFactory = new FakeCardEmbeddingProviderFactory();

      const document = composeDocumentEmbedding({
        configuration: documentLayer("remote"),
        currentProfile: remoteDocumentProfile(),
        reachableProfiles: [],
        securityDomain: SECURITY_DOMAIN,
        factory: documentFactory,
      });
      composeCardEmbedding({
        configuration: cardLayer("local"),
        profile: localCardProfile(),
        securityDomain: SECURITY_DOMAIN,
        artifactDirectory: "/assets/rev_a",
        factory: cardFactory,
      });

      expect(documentFactory.calls).toEqual([
        { mode: "remote", endpoint: "https://documents.example/v1/embeddings" },
      ]);
      expect(cardFactory.calls).toEqual([
        { mode: "local", artifactDirectory: "/assets/rev_a" },
      ]);
      expect(document.report.remote?.providerId).toBe("remote.local.document");
    });

    it("binds both layers to providers, each to its own", () => {
      const documentFactory = new FakeDocumentEmbeddingProviderFactory();
      const cardFactory = new FakeCardEmbeddingProviderFactory();

      composeDocumentEmbedding({
        configuration: documentLayer("remote"),
        currentProfile: remoteDocumentProfile(),
        reachableProfiles: [],
        securityDomain: SECURITY_DOMAIN,
        factory: documentFactory,
      });
      composeCardEmbedding({
        configuration: cardLayer("remote"),
        profile: remoteCardProfile(),
        securityDomain: SECURITY_DOMAIN,
        factory: cardFactory,
      });

      // Two endpoints, not one. The layers are independently configured, so a
      // deployment may reach two different providers, and a composition that
      // shared one instance would also be sharing its credential.
      expect(documentFactory.calls).toEqual([
        { mode: "remote", endpoint: "https://documents.example/v1/embeddings" },
      ]);
      expect(cardFactory.calls).toEqual([
        { mode: "remote", endpoint: "https://cards.example/v1/embeddings" },
      ]);
    });
  });

  describe("local assets", () => {
    it("never reads an artifact directory when both layers are remote", () => {
      const documentFactory = new FakeDocumentEmbeddingProviderFactory();
      const cardFactory = new FakeCardEmbeddingProviderFactory();

      // No `artifactDirectory` at all: a deployment that installed nothing.
      expect(() => {
        composeDocumentEmbedding({
          configuration: documentLayer("remote"),
          currentProfile: remoteDocumentProfile(),
          reachableProfiles: [],
          securityDomain: SECURITY_DOMAIN,
          factory: documentFactory,
        });
        composeCardEmbedding({
          configuration: cardLayer("remote"),
          profile: remoteCardProfile(),
          securityDomain: SECURITY_DOMAIN,
          factory: cardFactory,
        });
      }).not.toThrow();
    });

    it("refuses a local layer with nothing installed", () => {
      expect(() =>
        composeDocumentEmbedding({
          configuration: documentLayer("local"),
          currentProfile: localDocumentProfile(),
          reachableProfiles: [],
          securityDomain: SECURITY_DOMAIN,
          factory: new FakeDocumentEmbeddingProviderFactory(),
        }),
      ).toThrowError(EmbeddingProviderFault);
    });

    it("still needs assets for an older local profile a Card reaches", () => {
      const factory = new FakeDocumentEmbeddingProviderFactory();

      // The layer moved to a provider, but an approved Card still names a Scope
      // published under the old local profile. That index can only be searched
      // with vectors from the profile it was built under, so the artifact
      // requirement outlives the setting that created it.
      expect(() =>
        composeDocumentEmbedding({
          configuration: documentLayer("remote"),
          currentProfile: remoteDocumentProfile(),
          reachableProfiles: [localDocumentProfile()],
          securityDomain: SECURITY_DOMAIN,
          factory,
          retainedBindings: [
            {
              profileId: "document-granite-fake-v1",
              profileVersion: "1",
              mode: "local",
              artifactDirectory: "/assets/rev_a",
            },
          ],
        }),
      ).not.toThrow();
    });
  });

  describe("restoring older profiles", () => {
    it("registers a provider for every profile still reachable", () => {
      const factory = new FakeDocumentEmbeddingProviderFactory();

      const composition = composeDocumentEmbedding({
        configuration: documentLayer("local"),
        currentProfile: localDocumentProfile(),
        reachableProfiles: [localDocumentProfile("document-older-v1")],
        securityDomain: SECURITY_DOMAIN,
        artifactDirectory: "/assets/rev_a",
        factory,
        retainedBindings: [
          {
            profileId: "document-older-v1",
            profileVersion: "1",
            mode: "local",
            artifactDirectory: "/assets/rev_a",
          },
        ],
      });

      expect(
        composition.registrations.map(
          (registration) => registration.embeddingProfile.id,
        ),
      ).toEqual(["document-granite-fake-v1", "document-older-v1"]);
      expect(composition.restoredProfiles).toEqual(["document-older-v1 1"]);
    });

    it("does not register the current profile twice", () => {
      const composition = composeDocumentEmbedding({
        configuration: documentLayer("local"),
        currentProfile: localDocumentProfile(),
        reachableProfiles: [localDocumentProfile()],
        securityDomain: SECURITY_DOMAIN,
        artifactDirectory: "/assets/rev_a",
        factory: new FakeDocumentEmbeddingProviderFactory(),
      });

      expect(composition.registrations).toHaveLength(1);
      expect(composition.restoredProfiles).toEqual([]);
    });

    it("refuses an older remote profile it has no binding for", () => {
      // The layer is local, so there is no endpoint configured, and an index
      // published against a provider cannot be searched with a local model's
      // vectors. Closed failure rather than a substitution.
      expect(() =>
        composeDocumentEmbedding({
          configuration: documentLayer("local"),
          currentProfile: localDocumentProfile(),
          reachableProfiles: [remoteDocumentProfile()],
          securityDomain: SECURITY_DOMAIN,
          artifactDirectory: "/assets/rev_a",
          factory: new FakeDocumentEmbeddingProviderFactory(),
        }),
      ).toThrowError(EmbeddingCompositionError);
    });

    it("uses an exact retained binding for an older remote profile", () => {
      const factory = new FakeDocumentEmbeddingProviderFactory();
      const older = remoteDocumentProfile("document-older-hosted-v1");

      composeDocumentEmbedding({
        configuration: documentLayer("local"),
        currentProfile: localDocumentProfile(),
        reachableProfiles: [older],
        securityDomain: SECURITY_DOMAIN,
        artifactDirectory: "/assets/rev_a",
        factory,
        retainedBindings: [
          {
            profileId: older.id,
            profileVersion: older.version,
            mode: "remote",
            binding: remoteBinding("document"),
          },
        ],
      });

      expect(factory.calls).toEqual([
        { mode: "local", artifactDirectory: "/assets/rev_a" },
        {
          mode: "remote",
          endpoint: "https://documents.example/v1/embeddings",
        },
      ]);
    });
  });

  describe("configuration that contradicts a profile", () => {
    it("refuses remote configuration under a profile that pins an artifact", () => {
      expect(() =>
        composeDocumentEmbedding({
          configuration: documentLayer("remote"),
          currentProfile: localDocumentProfile(),
          reachableProfiles: [],
          securityDomain: SECURITY_DOMAIN,
          factory: new FakeDocumentEmbeddingProviderFactory(),
        }),
      ).toThrowError(EmbeddingModeProfileMismatchError);
    });

    it("refuses local configuration under a profile that names a provider", () => {
      expect(() =>
        composeCardEmbedding({
          configuration: cardLayer("local"),
          profile: remoteCardProfile(),
          securityDomain: SECURITY_DOMAIN,
          artifactDirectory: "/assets/rev_a",
          factory: new FakeCardEmbeddingProviderFactory(),
        }),
      ).toThrowError(EmbeddingModeProfileMismatchError);
    });

    it("refuses a remote binding from another security domain", () => {
      const binding = remoteBinding("document");
      expect(() =>
        composeDocumentEmbedding({
          configuration: {
            mode: "remote",
            binding: { ...binding, securityDomain: "another-domain" },
          },
          currentProfile: remoteDocumentProfile(),
          reachableProfiles: [],
          securityDomain: SECURITY_DOMAIN,
          factory: new FakeDocumentEmbeddingProviderFactory(),
        }),
      ).toThrowError(RemoteEmbeddingBindingError);
    });
  });

  describe("no automatic fallback", () => {
    it("does not fall back to local when a remote layer cannot be built", () => {
      const factory = new FakeDocumentEmbeddingProviderFactory();
      factory.failRemote = true;

      expect(() =>
        composeDocumentEmbedding({
          configuration: documentLayer("remote"),
          currentProfile: remoteDocumentProfile(),
          reachableProfiles: [],
          securityDomain: SECURITY_DOMAIN,
          // Assets are present. A composition that fell back would find them
          // and succeed, which is exactly the behaviour being ruled out.
          artifactDirectory: "/assets/rev_a",
          factory,
        }),
      ).toThrowError("remote adapter refused");
      expect(factory.calls.every((call) => call.mode === "remote")).toBe(true);
    });
  });
});
