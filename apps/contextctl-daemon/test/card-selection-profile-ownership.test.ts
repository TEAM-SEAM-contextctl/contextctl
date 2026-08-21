import {
  DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
  DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST_SHA256,
} from "@contextctl/ingestion-indexing";
import {
  CARD_SELECTION_EMBEDDING_PROFILE,
  isCardSelectionEmbeddingProfile,
} from "@contextctl/selection-delivery";
import { describe, expect, it } from "vitest";

/**
 * The one place that can see both packages, holding the one check that needs
 * to.
 *
 * Selection owns the Card profile and may not import Ingestion, so the asset
 * manifest digest the profile pins is a literal copied from Ingestion's
 * constant. The copy is sound only while the two agree, and neither package
 * can check that from inside itself; the daemon composes both and is where a
 * drift has to fail the build rather than surface as a Card index quietly keyed
 * on a manifest nobody installed.
 */
describe("the Card selection profile and the document profile pin one artifact", () => {
  function productionExecution() {
    if (!isCardSelectionEmbeddingProfile(CARD_SELECTION_EMBEDDING_PROFILE)) {
      throw new Error("the production Card profile must pin an artifact");
    }
    const card = CARD_SELECTION_EMBEDDING_PROFILE.execution;
    const document = DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE.execution;
    if (card.kind !== "local" || document.kind !== "local") {
      throw new Error("both production profiles execute locally today");
    }
    return { card, document };
  }

  it("copies Ingestion's asset manifest digest exactly", () => {
    const { card } = productionExecution();

    expect(card.assetManifestSha256).toBe(
      DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST_SHA256,
    );
  });

  it("names the same artifact the document path loads, field for field", () => {
    const { card, document } = productionExecution();

    // One artifact on disk, one loaded session: `LocalCardEmbeddingAdapter`
    // serves Card vectors from the document provider, which is sound only
    // while the two profiles describe identical weights.
    expect(card.artifactRepository).toBe(document.artifactRepository);
    expect(card.artifactRevision).toBe(document.artifactRevision);
    expect(card.artifactPath).toBe(document.artifactPath);
    expect(card.artifactSha256).toBe(document.artifactSha256);
    expect(card.precision).toBe(document.precision);
    expect(CARD_SELECTION_EMBEDDING_PROFILE.dimensions).toBe(
      DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE.dimensions,
    );
  });

  it("keeps the two families apart by id", () => {
    expect(CARD_SELECTION_EMBEDDING_PROFILE.id).not.toBe(
      DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE.id,
    );
  });
});
