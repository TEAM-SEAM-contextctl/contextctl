import { afterEach, describe, expect, it } from "vitest";

import { InMemoryVectorIndexAdapter } from "@contextctl/ingestion-indexing";

import {
  createDaemonRuntime,
  type DaemonRuntime,
  type DaemonRuntimeOptions,
} from "../../src/main.js";
import type { EmbeddingCompositionConfiguration } from "../../src/embedding/configuration.js";
import {
  cardLayer,
  documentLayer,
  FakeCardEmbeddingProviderFactory,
  FakeDocumentEmbeddingProviderFactory,
  localCardProfile,
  localDocumentProfile,
  remoteCardProfile,
  remoteDocumentProfile,
} from "./fakes.js";

/**
 * The four combinations, assembled through the real composition root.
 *
 * The unit tests next door prove the binding rules; this one proves the daemon
 * actually reaches them — that the two layers are read from separate settings,
 * bound by separate factories and neither derived from the other on the way
 * through `createDaemonRuntime`. Test providers are injected here so the suite
 * remains network-free; the release product gate separately exercises the
 * concrete remote adapters over their public daemon configuration.
 */

const runtimes: DaemonRuntime[] = [];

afterEach(() => {
  for (const runtime of runtimes.splice(0)) {
    runtime.database.close();
  }
});

function build(input: {
  readonly embedding: EmbeddingCompositionConfiguration;
  readonly documentFactory: FakeDocumentEmbeddingProviderFactory;
  readonly cardFactory: FakeCardEmbeddingProviderFactory;
  readonly artifactDirectory?: string;
}): DaemonRuntime {
  const options: DaemonRuntimeOptions = {
    vectorIndex: new InMemoryVectorIndexAdapter(),
    embedding: input.embedding,
    embeddingProfile:
      input.embedding.document.mode === "local"
        ? localDocumentProfile()
        : remoteDocumentProfile(),
    cardSelectionProfile:
      input.embedding.card.mode === "local"
        ? localCardProfile()
        : remoteCardProfile(),
    documentEmbeddingFactory: input.documentFactory,
    cardEmbeddingFactory: input.cardFactory,
    ...(input.artifactDirectory === undefined
      ? {}
      : { embeddingArtifactDirectory: input.artifactDirectory }),
  };
  const runtime = createDaemonRuntime(options);
  runtimes.push(runtime);
  return runtime;
}

describe("createDaemonRuntime with independent embedding layers", () => {
  it("assembles local documents and local Cards", () => {
    const documentFactory = new FakeDocumentEmbeddingProviderFactory();
    const cardFactory = new FakeCardEmbeddingProviderFactory();

    const runtime = build({
      embedding: { document: documentLayer("local"), card: cardLayer("local") },
      documentFactory,
      cardFactory,
      artifactDirectory: "/assets/rev_a",
    });

    expect(documentFactory.calls).toEqual([
      { mode: "local", artifactDirectory: "/assets/rev_a" },
    ]);
    expect(cardFactory.calls).toEqual([
      { mode: "local", artifactDirectory: "/assets/rev_a" },
    ]);
    // Two independently constructed local providers do not claim to share a
    // native session merely because their modes happen to match.
    expect(runtime.sharesLocalEmbeddingSession).toBe(false);
  });

  it("assembles local documents and hosted Cards", () => {
    const documentFactory = new FakeDocumentEmbeddingProviderFactory();
    const cardFactory = new FakeCardEmbeddingProviderFactory();

    const runtime = build({
      embedding: { document: documentLayer("local"), card: cardLayer("remote") },
      documentFactory,
      cardFactory,
      artifactDirectory: "/assets/rev_a",
    });

    expect(documentFactory.calls[0]?.mode).toBe("local");
    expect(cardFactory.calls[0]).toEqual({
      mode: "remote",
      endpoint: "https://cards.example/v1/embeddings",
    });
    expect(runtime.cardEmbeddingProvider.providerKind).toBe("remote");
    expect(runtime.embeddingProvider.providerKind).toBe("local");
    expect(runtime.sharesLocalEmbeddingSession).toBe(false);
  });

  it("assembles hosted documents and local Cards", () => {
    const documentFactory = new FakeDocumentEmbeddingProviderFactory();
    const cardFactory = new FakeCardEmbeddingProviderFactory();

    const runtime = build({
      embedding: { document: documentLayer("remote"), card: cardLayer("local") },
      documentFactory,
      cardFactory,
      artifactDirectory: "/assets/rev_a",
    });

    expect(documentFactory.calls[0]).toEqual({
      mode: "remote",
      endpoint: "https://documents.example/v1/embeddings",
    });
    expect(cardFactory.calls[0]?.mode).toBe("local");
    expect(runtime.embeddingProvider.providerKind).toBe("remote");
    expect(runtime.cardEmbeddingProvider.providerKind).toBe("local");
    expect(runtime.sharesLocalEmbeddingSession).toBe(false);
  });

  it("assembles hosted documents and hosted Cards", () => {
    const documentFactory = new FakeDocumentEmbeddingProviderFactory();
    const cardFactory = new FakeCardEmbeddingProviderFactory();

    const runtime = build({
      embedding: { document: documentLayer("remote"), card: cardLayer("remote") },
      documentFactory,
      cardFactory,
      artifactDirectory: "/assets/rev_a",
    });

    // Each layer reached its own provider. A composition that had bound the Card
    // layer to whatever the document layer chose would show one endpoint twice.
    expect(documentFactory.calls[0]).toEqual({
      mode: "remote",
      endpoint: "https://documents.example/v1/embeddings",
    });
    expect(cardFactory.calls[0]).toEqual({
      mode: "remote",
      endpoint: "https://cards.example/v1/embeddings",
    });
    expect(runtime.sharesLocalEmbeddingSession).toBe(false);
  });

  describe("starting with no model installed", () => {
    it("assembles remote/remote without an artifact directory", () => {
      const documentFactory = new FakeDocumentEmbeddingProviderFactory();
      const cardFactory = new FakeCardEmbeddingProviderFactory();

      // No `embeddingArtifactDirectory` at all, which is what a machine that
      // never ran `contextctl install-assets` looks like. Nothing in the
      // required set opens a model, so there is nothing to install.
      const runtime = build({
        embedding: {
          document: documentLayer("remote"),
          card: cardLayer("remote"),
        },
        documentFactory,
        cardFactory,
      });

      expect(runtime.embeddingProvider.providerKind).toBe("remote");
      expect(runtime.cardEmbeddingProvider.providerKind).toBe("remote");
      expect(
        [...documentFactory.calls, ...cardFactory.calls].every(
          (call) => call.mode === "remote",
        ),
      ).toBe(true);
    });

    it("still refuses when one layer is local and nothing is installed", () => {
      expect(() =>
        build({
          embedding: {
            document: documentLayer("remote"),
            card: cardLayer("local"),
          },
          documentFactory: new FakeDocumentEmbeddingProviderFactory(),
          cardFactory: new FakeCardEmbeddingProviderFactory(),
        }),
      ).toThrowError(
        expect.objectContaining({ code: "embedding_artifact_unavailable" }),
      );
    });
  });

  describe("registering the providers a query resolves against", () => {
    it("registers one provider per layer, keyed on its own profile", () => {
      const runtime = build({
        embedding: {
          document: documentLayer("remote"),
          card: cardLayer("remote"),
        },
        documentFactory: new FakeDocumentEmbeddingProviderFactory(),
        cardFactory: new FakeCardEmbeddingProviderFactory(),
      });

      // The document profile is what a managed search resolves a provider by,
      // and the Card profile is what the candidate index is built under. They
      // are separate values and must not have collapsed into one.
      expect(runtime.embeddingProfile.id).toBe("document-hosted-fake-v1");
      expect(runtime.cardSelectionProfile.id).toBe("card-hosted-fake-v1");
    });
  });
});
