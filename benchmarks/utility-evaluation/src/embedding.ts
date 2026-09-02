import {
  DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
  resolveActiveLocalEmbeddingAssets,
  transformQueryEmbeddingInput,
  TransformersJsLocalEmbeddingAdapter,
} from "@contextctl/ingestion-indexing";

export interface QueryEmbedder {
  readonly dimensions: number;
  embed(query: string): Promise<readonly number[]>;
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
  return {
    dimensions: profile.dimensions,
    async embed(query) {
      const outputs = await adapter.embed({
        profile,
        inputs: [
          {
            key: "utility-evaluation-query",
            text: transformQueryEmbeddingInput(profile, query),
          },
        ],
        signal: AbortSignal.timeout(30_000),
      });
      const output = outputs[0];
      if (
        outputs.length !== 1 ||
        output?.key !== "utility-evaluation-query" ||
        output.vector.length !== profile.dimensions
      ) {
        throw new Error("local query embedding output is invalid");
      }
      return output.vector;
    },
  };
}
