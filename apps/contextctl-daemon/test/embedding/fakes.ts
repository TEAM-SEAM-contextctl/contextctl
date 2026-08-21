import {
  TEXT_MEASURE_PROFILE_VERSION,
  type EmbeddingPort,
  type EmbeddingProfile,
  type EmbeddingProviderOutput,
  type EmbeddingProviderRequest,
} from "@contextctl/ingestion-indexing";
import {
  DEFAULT_CARD_ADMISSION_LIMITS,
  type CardEmbeddingOutput,
  type CardEmbeddingPort,
  type CardEmbeddingRequest,
  type CardSelectionProfile,
} from "@contextctl/selection-delivery";

import type { EmbeddingLayerConfiguration } from "../../src/embedding/configuration.js";
import {
  EmbeddingCredential,
  type RemoteEmbeddingBinding,
} from "../../src/embedding/remote-binding.js";
import type {
  CardEmbeddingProviderFactory,
  DocumentEmbeddingProviderFactory,
} from "../../src/embedding/provider-factory.js";

export const SECURITY_DOMAIN = "local";

/**
 * Profiles shaped like the real ones and pinned to nothing real.
 *
 * The digests and revisions are obviously fake. The composition never reads
 * them — it branches on `execution.kind` and nothing else — so using the
 * production constants here would only tie these tests to a model artifact that
 * has to be downloaded before they can run.
 */
export function localDocumentProfile(
  id = "document-granite-fake-v1",
): EmbeddingProfile {
  return {
    id,
    version: "1",
    model: "fake/granite-embedding",
    modelRevision: "rev_fake_document",
    dimensions: 8,
    distance: "cosine",
    maxInputTokens: 480,
    textMeasureProfileVersion: TEXT_MEASURE_PROFILE_VERSION,
    pooling: "cls",
    normalization: "l2",
    documentInputTransformVersion: "identity-v1",
    queryInputTransformVersion: "identity-v1",
    modelMaxTokens: 32_768,
    admissionLimit: {
      textMeasureProfileVersion: TEXT_MEASURE_PROFILE_VERSION,
      maxUnits: 480,
    },
    execution: {
      kind: "local",
      adapter: "transformers-js-onnx",
      adapterVersion: "4.2.0",
      artifactRepository: "fake/granite-ONNX",
      artifactRevision: "rev_fake_artifact",
      artifactPath: "onnx/model.onnx",
      artifactSha256: "a".repeat(64),
      assetManifestSha256: "b".repeat(64),
      precision: "fp32",
    },
  } as EmbeddingProfile;
}

export function remoteDocumentProfile(
  id = "document-hosted-fake-v1",
): EmbeddingProfile {
  return {
    ...(localDocumentProfile(id) as unknown as Record<string, unknown>),
    execution: {
      kind: "remote",
      adapter: "openai-compatible",
      adapterVersion: "1",
      // Equal to the profile's own `model` because Ingestion's contract requires
      // it: the profile names the model and the execution block names the
      // immutable revision the provider serves under that name, so two different
      // strings would describe two different models in one profile.
      model: "fake/granite-embedding",
    },
  } as unknown as EmbeddingProfile;
}

export function localCardProfile(id = "card-granite-fake-v1"): CardSelectionProfile {
  return {
    id,
    version: "1",
    model: "fake/granite-embedding",
    modelRevision: "rev_fake_card",
    dimensions: 8,
    distance: "cosine",
    normalization: "l2",
    selectionTextSchemaVersion: 2,
    admissionLimits: DEFAULT_CARD_ADMISSION_LIMITS,
    pooling: "cls",
    cardInputTransformVersion: "card-selection-text-v2",
    queryInputTransformVersion: "card-selection-text-v2",
    execution: {
      kind: "local",
      adapter: "transformers-js-onnx",
      adapterVersion: "4.2.0",
      artifactRepository: "fake/granite-ONNX",
      artifactRevision: "rev_fake_artifact",
      artifactPath: "onnx/model.onnx",
      artifactSha256: "a".repeat(64),
      assetManifestSha256: "b".repeat(64),
      precision: "fp32",
    },
  } as CardSelectionProfile;
}

export function remoteCardProfile(id = "card-hosted-fake-v1"): CardSelectionProfile {
  return {
    ...(localCardProfile(id) as unknown as Record<string, unknown>),
    execution: {
      kind: "remote",
      adapter: "openai-compatible",
      adapterVersion: "1",
      model: "fake/granite-embedding",
    },
  } as unknown as CardSelectionProfile;
}

/**
 * Two endpoints, one per layer.
 *
 * Different hosts on purpose. The combinations only prove independence if the
 * two layers can be told apart in the assertions, and a shared endpoint would
 * make "bound the Card layer to the document layer's provider" pass.
 */
export function remoteBinding(
  layer: "document" | "card",
): RemoteEmbeddingBinding {
  return {
    providerId: `remote.${SECURITY_DOMAIN}.${layer}`,
    endpoint:
      layer === "document"
        ? "https://documents.example/v1/embeddings"
        : "https://cards.example/v1/embeddings",
    credential: new EmbeddingCredential(`key-for-${layer}`),
    securityDomain: SECURITY_DOMAIN,
  };
}

export function documentLayer(
  mode: "local" | "remote",
): EmbeddingLayerConfiguration {
  return mode === "local"
    ? { mode: "local" }
    : { mode: "remote", binding: remoteBinding("document") };
}

export function cardLayer(
  mode: "local" | "remote",
): EmbeddingLayerConfiguration {
  return mode === "local"
    ? { mode: "local" }
    : { mode: "remote", binding: remoteBinding("card") };
}

/** What a factory was asked for, in the order it was asked. */
export type FactoryCall =
  | { readonly mode: "local"; readonly artifactDirectory: string }
  | { readonly mode: "remote"; readonly endpoint: string };

/**
 * A document provider that records how it was asked for and embeds nothing.
 *
 * The vectors are irrelevant here: this suite is about which binding was chosen,
 * not about what a model returns. Recording the calls is what lets a test assert
 * that a layer was reached one way and not the other.
 */
export class FakeDocumentEmbeddingProviderFactory
  implements DocumentEmbeddingProviderFactory
{
  readonly calls: FactoryCall[] = [];
  /** Makes the remote branch fail, to prove nothing falls back to local. */
  failRemote = false;

  createLocal(input: {
    readonly profile: EmbeddingProfile;
    readonly artifactDirectory: string;
  }): EmbeddingPort {
    this.calls.push({
      mode: "local",
      artifactDirectory: input.artifactDirectory,
    });
    return new FakeEmbeddingPort("local");
  }

  createRemote(input: {
    readonly profile: EmbeddingProfile;
    readonly binding: RemoteEmbeddingBinding;
  }): EmbeddingPort {
    this.calls.push({ mode: "remote", endpoint: input.binding.endpoint });
    if (this.failRemote) {
      throw new Error("remote adapter refused");
    }
    return new FakeEmbeddingPort("remote");
  }
}

export class FakeCardEmbeddingProviderFactory
  implements CardEmbeddingProviderFactory
{
  readonly calls: FactoryCall[] = [];
  failRemote = false;

  createLocal(input: {
    readonly profile: CardSelectionProfile;
    readonly artifactDirectory: string;
  }): CardEmbeddingPort {
    this.calls.push({
      mode: "local",
      artifactDirectory: input.artifactDirectory,
    });
    return new FakeCardEmbeddingPort("local");
  }

  createRemote(input: {
    readonly profile: CardSelectionProfile;
    readonly binding: RemoteEmbeddingBinding;
  }): CardEmbeddingPort {
    this.calls.push({ mode: "remote", endpoint: input.binding.endpoint });
    if (this.failRemote) {
      throw new Error("remote adapter refused");
    }
    return new FakeCardEmbeddingPort("remote");
  }
}

class FakeEmbeddingPort implements EmbeddingPort {
  constructor(readonly providerKind: "local" | "remote") {}

  async embed(
    request: EmbeddingProviderRequest,
  ): Promise<readonly EmbeddingProviderOutput[]> {
    return request.inputs.map((input) => ({
      key: input.key,
      vector: new Array<number>(request.profile.dimensions).fill(0),
    }));
  }
}

class FakeCardEmbeddingPort implements CardEmbeddingPort {
  constructor(readonly providerKind: "local" | "remote") {}

  async embed(
    request: CardEmbeddingRequest,
  ): Promise<readonly CardEmbeddingOutput[]> {
    return request.inputs.map((input) => ({
      key: input.key,
      vector: new Array<number>(request.profile.dimensions).fill(0),
    }));
  }
}
