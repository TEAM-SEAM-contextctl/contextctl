import { describe, expect, it } from "vitest";

import {
  assertValidCardSelectionProfile,
  CARD_EMBEDDING_L2_NORM_TOLERANCE,
  cardSelectionProfilesMatch,
  cardSelectionVectorMatchesProfile,
  createRemoteCardSelectionProfile,
  DEFAULT_CARD_ADMISSION_LIMITS,
  isCardSelectionEmbeddingProfile,
  type CardSelectionEmbeddingProfile,
} from "../../src/domain/card-selection-profile.js";
import { CardSelectionProfileInvariantError } from "../../src/domain/errors.js";
import {
  TEST_CARD_PROFILE,
  TEST_PRODUCTION_CARD_PROFILE,
} from "../fixtures/card-embedding.fixture.js";

describe("isCardSelectionEmbeddingProfile", () => {
  it("separates a profile that pins an artifact from one that does not", () => {
    expect(isCardSelectionEmbeddingProfile(TEST_PRODUCTION_CARD_PROFILE)).toBe(
      true,
    );
    // A network-free composition has no artifact to describe, and a profile
    // that named one anyway would state a provenance that is false.
    expect(isCardSelectionEmbeddingProfile(TEST_CARD_PROFILE)).toBe(false);
  });
});

describe("cardSelectionProfilesMatch", () => {
  it("compares the whole record rather than the id", () => {
    // Two profiles that share a name while differing in width describe two
    // spaces, and an index built in one is not searchable from the other.
    expect(
      cardSelectionProfilesMatch(TEST_CARD_PROFILE, { ...TEST_CARD_PROFILE }),
    ).toBe(true);
    expect(
      cardSelectionProfilesMatch(TEST_CARD_PROFILE, {
        ...TEST_CARD_PROFILE,
        dimensions: 8,
      }),
    ).toBe(false);
  });

  it("ignores the order the fields were assigned in", () => {
    const reordered = {
      admissionLimits: TEST_CARD_PROFILE.admissionLimits,
      version: TEST_CARD_PROFILE.version,
      selectionTextSchemaVersion: TEST_CARD_PROFILE.selectionTextSchemaVersion,
      normalization: TEST_CARD_PROFILE.normalization,
      model: TEST_CARD_PROFILE.model,
      id: TEST_CARD_PROFILE.id,
      distance: TEST_CARD_PROFILE.distance,
      dimensions: TEST_CARD_PROFILE.dimensions,
    } as const;

    expect(cardSelectionProfilesMatch(TEST_CARD_PROFILE, reordered)).toBe(true);
  });

  it("distinguishes a production profile from the family it extends", () => {
    expect(
      cardSelectionProfilesMatch(
        TEST_PRODUCTION_CARD_PROFILE,
        TEST_CARD_PROFILE,
      ),
    ).toBe(false);
  });

  it("distinguishes two artifacts of different precision", () => {
    expect(
      cardSelectionProfilesMatch(TEST_PRODUCTION_CARD_PROFILE, {
        ...TEST_PRODUCTION_CARD_PROFILE,
        execution: {
          ...TEST_PRODUCTION_CARD_PROFILE.execution,
          precision: "q8",
        },
      } as typeof TEST_PRODUCTION_CARD_PROFILE),
    ).toBe(false);
  });
});

describe("assertValidCardSelectionProfile", () => {
  it("accepts both shapes of a well-formed profile", () => {
    expect(() =>
      assertValidCardSelectionProfile(TEST_CARD_PROFILE),
    ).not.toThrow();
    expect(() =>
      assertValidCardSelectionProfile(TEST_PRODUCTION_CARD_PROFILE),
    ).not.toThrow();
  });

  it("refuses an unnamed profile", () => {
    expect(() =>
      assertValidCardSelectionProfile({ ...TEST_CARD_PROFILE, id: "  " }),
    ).toThrow(CardSelectionProfileInvariantError);
  });

  it("refuses a width that is not a positive integer", () => {
    for (const dimensions of [0, -4, 1.5, Number.NaN]) {
      expect(() =>
        assertValidCardSelectionProfile({ ...TEST_CARD_PROFILE, dimensions }),
      ).toThrow(CardSelectionProfileInvariantError);
    }
  });

  it("refuses a non-positive admission limit", () => {
    expect(() =>
      assertValidCardSelectionProfile({
        ...TEST_CARD_PROFILE,
        admissionLimits: {
          ...DEFAULT_CARD_ADMISSION_LIMITS,
          maxQueryUnits: 0 as unknown as 480,
        },
      }),
    ).toThrow(CardSelectionProfileInvariantError);
  });

  it("refuses limits stated under a measure this package cannot apply", () => {
    expect(() =>
      assertValidCardSelectionProfile({
        ...TEST_CARD_PROFILE,
        admissionLimits: {
          ...DEFAULT_CARD_ADMISSION_LIMITS,
          textMeasureProfileVersion:
            "bpe-tokens-v1" as unknown as "unicode-estimate-v1",
        },
      }),
    ).toThrow(CardSelectionProfileInvariantError);
  });

  it("refuses provider-defined pooling on a local artifact", () => {
    // A local ONNX session has no pooling of its own to defer to: the adapter
    // has to be told which row of the last hidden state is the sentence.
    const providerDefined: CardSelectionEmbeddingProfile = {
      ...TEST_PRODUCTION_CARD_PROFILE,
      pooling: "provider_defined",
    };

    expect(() => assertValidCardSelectionProfile(providerDefined)).toThrow(
      CardSelectionProfileInvariantError,
    );
  });
});

describe("remote Card selection profiles", () => {
  const remote = () =>
    createRemoteCardSelectionProfile({
      id: "card-remote-v1",
      version: "1",
      model: "pinned-model-2026-08-21",
      modelRevision: "rev_0001",
      dimensions: 384,
      adapterVersion: "1.0.0",
    });

  it("fixes everything a deployment does not decide", () => {
    const profile = remote();

    expect(profile.execution).toEqual({
      kind: "remote",
      adapter: "openai-compatible",
      adapterVersion: "1.0.0",
      model: "pinned-model-2026-08-21",
    });
    expect(profile.pooling).toBe("provider_defined");
    expect(profile.normalization).toBe("l2");
    expect(profile.distance).toBe("cosine");
    expect(profile.selectionTextSchemaVersion).toBe(3);
    expect(profile.cardInputTransformVersion).toBe("card-selection-text-v3");
    expect(profile.queryInputTransformVersion).toBe("card-selection-text-v3");
    expect(profile.admissionLimits).toEqual(DEFAULT_CARD_ADMISSION_LIMITS);
    expect(Object.isFrozen(profile)).toBe(true);
    expect(() => assertValidCardSelectionProfile(profile)).not.toThrow();
  });

  it("refuses a remote profile that claims a pooling the provider performs", () => {
    const tampered: CardSelectionEmbeddingProfile = { ...remote(), pooling: "cls" };
    expect(() => assertValidCardSelectionProfile(tampered)).toThrow(/provider_defined/);
  });

  it("refuses a remote profile whose execution names another model than the profile", () => {
    const profile = remote();
    const tampered: CardSelectionEmbeddingProfile = {
      ...profile,
      execution: { ...profile.execution, model: "other-model" } as typeof profile.execution,
    };
    expect(() => assertValidCardSelectionProfile(tampered)).toThrow(/same model/);
  });

  it("refuses a production profile without a model revision or adapter version", () => {
    expect(() =>
      createRemoteCardSelectionProfile({
        id: "card-remote-v1",
        version: "1",
        model: "m",
        modelRevision: " ",
        dimensions: 3,
        adapterVersion: "1.0.0",
      }),
    ).toThrow(/model revision/);
    expect(() =>
      createRemoteCardSelectionProfile({
        id: "card-remote-v1",
        version: "1",
        model: "m",
        modelRevision: "r",
        dimensions: 3,
        adapterVersion: "",
      }),
    ).toThrow(/adapter version/);
  });

  it("still refuses provider_defined pooling on a local profile", () => {
    const tampered: CardSelectionEmbeddingProfile = {
      ...TEST_PRODUCTION_CARD_PROFILE,
      pooling: "provider_defined",
    };
    expect(() => assertValidCardSelectionProfile(tampered)).toThrow(/cls or mean/);
  });
});

describe("cardSelectionVectorMatchesProfile", () => {
  const profile = { ...TEST_CARD_PROFILE, dimensions: 3 };

  it("accepts a finite unit vector of the declared width", () => {
    expect(cardSelectionVectorMatchesProfile(profile, [1, 0, 0])).toBe(true);
    expect(cardSelectionVectorMatchesProfile(profile, [0.6, 0.8, 0])).toBe(true);
  });

  it("refuses the wrong width, a non-finite component, a zero vector and an unnormalized one", () => {
    expect(cardSelectionVectorMatchesProfile(profile, [1, 0])).toBe(false);
    expect(cardSelectionVectorMatchesProfile(profile, [1, Number.NaN, 0])).toBe(false);
    expect(cardSelectionVectorMatchesProfile(profile, [0, 0, 0])).toBe(false);
    expect(cardSelectionVectorMatchesProfile(profile, [1, 1, 1])).toBe(false);
  });

  it("tolerates rounding within the stated band", () => {
    expect(cardSelectionVectorMatchesProfile(profile, [1 + CARD_EMBEDDING_L2_NORM_TOLERANCE / 2, 0, 0])).toBe(true);
    expect(cardSelectionVectorMatchesProfile(profile, [1 + CARD_EMBEDDING_L2_NORM_TOLERANCE * 2, 0, 0])).toBe(false);
  });
});
