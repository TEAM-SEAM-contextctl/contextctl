import {
  DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
  loadLocalDocumentEmbeddingInferenceResource,
  resolveActiveLocalEmbeddingAssets,
  transformDocumentEmbeddingInput,
  transformQueryEmbeddingInput,
  TransformersJsLocalEmbeddingAdapter,
} from "@contextctl/ingestion-indexing";
import {
  CARD_SELECTION_EMBEDDING_PROFILE,
  normalizeSelectionText,
  TransformersJsLocalCardEmbeddingAdapter,
} from "@contextctl/selection-delivery";

export interface QueryEmbedder {
  readonly dimensions: number;
  readonly profileId?: string;
  readonly profileVersion?: string;
  embed(query: string): Promise<readonly number[]>;
  readonly embedMany: BatchEmbedder["embedMany"];
}

export interface BatchEmbedder {
  embedMany(
    inputs: readonly { readonly key: string; readonly text: string }[],
  ): Promise<ReadonlyMap<string, readonly number[]>>;
}

export interface EvaluationEmbedders {
  readonly document: QueryEmbedder;
  readonly documentEvidence: BatchEmbedder;
  readonly card: QueryEmbedder;
}

/**
 * Creates the two domain adapters over one verified physical Granite session.
 * The shared session is a composition optimisation; each adapter still checks
 * and records its own domain profile.
 */
export async function createEvaluationEmbedders(
  assetDirectory: string,
): Promise<EvaluationEmbedders> {
  const documentProfile = DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE;
  const cardProfile = CARD_SELECTION_EMBEDDING_PROFILE;
  if (cardProfile.execution.kind !== "local") {
    throw new Error("the cascade evaluation requires the local Card profile");
  }
  const active = await resolveActiveLocalEmbeddingAssets(
    assetDirectory,
    documentProfile,
  );
  if (active === undefined) {
    throw new Error(
      "the configured embedding asset directory has no verified active Granite revision",
    );
  }
  const resource = await loadLocalDocumentEmbeddingInferenceResource({
    artifactDirectory: active.directory,
    profile: documentProfile,
  });
  if (
    JSON.stringify(documentProfile.execution) !==
    JSON.stringify(cardProfile.execution)
  ) {
    throw new Error("document and Card profiles cannot share this inference resource");
  }
  const documentAdapter = new TransformersJsLocalEmbeddingAdapter({
    inferenceResource: resource,
    profile: documentProfile,
  });
  const cardAdapter = new TransformersJsLocalCardEmbeddingAdapter({
    inferenceResource: {
      execution: cardProfile.execution,
      modelMaxTokens: resource.modelMaxTokens,
      tokenCount: async (text) => await resource.tokenCount(text),
      embed: async (texts, options) => await resource.embed(texts, options),
    },
    profile: cardProfile,
  });
  await documentAdapter.ready();
  return {
    document: embedderFor({
      profileId: documentProfile.id,
      profileVersion: documentProfile.version,
      dimensions: documentProfile.dimensions,
      transform: (text) => transformQueryEmbeddingInput(documentProfile, text),
      embed: async (inputs) =>
        await documentAdapter.embed({
          profile: documentProfile,
          inputs,
          signal: AbortSignal.timeout(30_000),
        }),
    }),
    documentEvidence: embedderFor({
      profileId: documentProfile.id,
      profileVersion: documentProfile.version,
      dimensions: documentProfile.dimensions,
      transform: (text) =>
        transformDocumentEmbeddingInput(documentProfile, text),
      embed: async (inputs) =>
        await documentAdapter.embed({
          profile: documentProfile,
          inputs,
          signal: AbortSignal.timeout(30_000),
        }),
    }),
    card: embedderFor({
      profileId: cardProfile.id,
      profileVersion: cardProfile.version,
      dimensions: cardProfile.dimensions,
      transform: normalizeSelectionText,
      embed: async (inputs) =>
        await cardAdapter.embed({
          profile: cardProfile,
          inputs,
          signal: AbortSignal.timeout(30_000),
        }),
    }),
  };
}

interface EmbeddingOutput {
  readonly key: string;
  readonly vector: readonly number[];
}

function embedderFor(input: {
  readonly profileId: string;
  readonly profileVersion: string;
  readonly dimensions: number;
  readonly transform: (text: string) => string;
  readonly embed: (
    inputs: readonly { readonly key: string; readonly text: string }[],
  ) => Promise<readonly EmbeddingOutput[]>;
}): QueryEmbedder {
  const embedMany = async (
    inputs: readonly { readonly key: string; readonly text: string }[],
  ): Promise<ReadonlyMap<string, readonly number[]>> => {
    if (new Set(inputs.map((entry) => entry.key)).size !== inputs.length) {
      throw new Error("embedding inputs repeat a key");
    }
    const transformed = inputs.map((entry) => ({
      key: entry.key,
      text: input.transform(entry.text),
    }));
    if (transformed.some((entry) => entry.text === "")) {
      throw new Error("embedding input is empty after normalization");
    }
    const vectors = new Map<string, readonly number[]>();
    for (let offset = 0; offset < transformed.length; offset += 32) {
      const batch = transformed.slice(offset, offset + 32);
      const outputs = await input.embed(batch);
      if (outputs.length !== batch.length) {
        throw new Error("embedding output count is invalid");
      }
      for (const output of outputs) {
        if (
          !batch.some((entry) => entry.key === output.key) ||
          output.vector.length !== input.dimensions ||
          vectors.has(output.key)
        ) {
          throw new Error("embedding output is invalid");
        }
        vectors.set(output.key, output.vector);
      }
    }
    return vectors;
  };
  return {
    dimensions: input.dimensions,
    profileId: input.profileId,
    profileVersion: input.profileVersion,
    async embed(text) {
      const key = "utility-evaluation-query";
      const vectors = await embedMany([{ key, text }]);
      const vector = vectors.get(key);
      if (vector === undefined) throw new Error("query embedding output is missing");
      return vector;
    },
    embedMany,
  };
}

export async function createQueryEmbedder(
  assetDirectory: string,
): Promise<QueryEmbedder> {
  const profile = DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE;
  const active = await resolveActiveLocalEmbeddingAssets(assetDirectory, profile);
  if (active === undefined) {
    throw new Error(
      "the configured embedding asset directory has no verified active Granite revision",
    );
  }
  const adapter = new TransformersJsLocalEmbeddingAdapter({
    artifactDirectory: active.directory,
    profile,
  });
  await adapter.ready();
  return embedderFor({
    profileId: profile.id,
    profileVersion: profile.version,
    dimensions: profile.dimensions,
    transform: (text) => transformQueryEmbeddingInput(profile, text),
    embed: async (inputs) =>
      await adapter.embed({
        profile,
        inputs,
        signal: AbortSignal.timeout(30_000),
      }),
  });
}
