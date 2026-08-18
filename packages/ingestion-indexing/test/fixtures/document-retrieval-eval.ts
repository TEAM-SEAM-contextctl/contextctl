import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  serializeLocalEmbeddingAssetManifest,
  TransformersJsLocalEmbeddingAdapter,
  type DocumentRetrievalEmbeddingProfile,
  type EmbeddingPort,
  type LocalEmbeddingAssetManifest,
} from "../../src/index.js";

const CORPUS_FILE = fileURLToPath(
  new URL("./document-retrieval-eval-v1/corpus.json", import.meta.url),
);

export interface EvalChunk {
  readonly id: string;
  readonly language: string;
  readonly kind: string;
  readonly text: string;
}

export interface EvalQuery {
  readonly id: string;
  readonly language: string;
  readonly text: string;
  readonly relevant: readonly string[];
}

export interface EvalCorpus {
  readonly datasetId: string;
  readonly version: string;
  readonly chunks: readonly EvalChunk[];
  readonly queries: readonly EvalQuery[];
  /** Digest of the exact bytes measured, so a result names its input. */
  readonly digest: string;
}

export interface RetrievalQuality {
  readonly recallAt5: number;
  readonly mrrAt10: number;
  readonly queryCount: number;
  readonly missedQueryIds: readonly string[];
}

export async function loadEvalCorpus(): Promise<EvalCorpus> {
  const bytes = await readFile(CORPUS_FILE);
  const parsed = JSON.parse(bytes.toString("utf8")) as Omit<EvalCorpus, "digest">;
  assertUsableCorpus(parsed);
  return {
    ...parsed,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

/**
 * Rejects a relevance set that could pass a gate without measuring anything:
 * a dangling gold reference, a duplicate identifier or too few Korean queries
 * all make the reported score meaningless rather than merely lower.
 */
function assertUsableCorpus(corpus: Omit<EvalCorpus, "digest">): void {
  const chunkIds = new Set(corpus.chunks.map((chunk) => chunk.id));
  const queryIds = new Set(corpus.queries.map((query) => query.id));
  const korean = corpus.queries.filter((query) => query.language === "ko");
  const dangling = corpus.queries.filter(
    (query) =>
      query.relevant.length === 0 ||
      query.relevant.some((id) => !chunkIds.has(id)),
  );
  if (
    chunkIds.size !== corpus.chunks.length ||
    queryIds.size !== corpus.queries.length ||
    corpus.queries.length < 60 ||
    korean.length < 30 ||
    dangling.length > 0
  ) {
    throw new Error("document-retrieval-eval-v1 is not a usable relevance set");
  }
}

/** Cosine over L2-normalized vectors, which the profile guarantees. */
function similarity(left: readonly number[], right: readonly number[]): number {
  let dot = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += (left[index] ?? 0) * (right[index] ?? 0);
  }
  return dot;
}

export async function embedAll(
  provider: EmbeddingPort,
  profile: DocumentRetrievalEmbeddingProfile,
  entries: readonly { readonly id: string; readonly text: string }[],
  batchSize = 16,
): Promise<Map<string, readonly number[]>> {
  const vectors = new Map<string, readonly number[]>();
  for (let offset = 0; offset < entries.length; offset += batchSize) {
    const batch = entries.slice(offset, offset + batchSize);
    const outputs = await provider.embed({
      profile,
      inputs: batch.map((entry) => ({ key: entry.id, text: entry.text })),
      signal: new AbortController().signal,
    });
    for (const output of outputs) vectors.set(output.key, output.vector);
  }
  return vectors;
}

export function scoreRetrieval(
  corpus: EvalCorpus,
  chunkVectors: ReadonlyMap<string, readonly number[]>,
  queryVectors: ReadonlyMap<string, readonly number[]>,
): RetrievalQuality {
  let hitsAt5 = 0;
  let reciprocalSum = 0;
  const missedQueryIds: string[] = [];
  for (const query of corpus.queries) {
    const queryVector = queryVectors.get(query.id);
    if (queryVector === undefined) {
      throw new Error(`missing query vector: ${query.id}`);
    }
    const ranked = corpus.chunks
      .map((chunk) => ({
        id: chunk.id,
        score: similarity(queryVector, chunkVectors.get(chunk.id) ?? []),
      }))
      // Ties break on identifier so a rerun ranks the same way.
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
    const relevant = new Set(query.relevant);
    const rank = ranked.findIndex((candidate) => relevant.has(candidate.id)) + 1;
    if (rank >= 1 && rank <= 5) hitsAt5 += 1;
    else missedQueryIds.push(query.id);
    if (rank >= 1 && rank <= 10) reciprocalSum += 1 / rank;
  }
  return {
    recallAt5: hitsAt5 / corpus.queries.length,
    mrrAt10: reciprocalSum / corpus.queries.length,
    queryCount: corpus.queries.length,
    missedQueryIds,
  };
}

/** Builds the fp32 baseline profile from the assets actually installed. */
export async function readBaselineProfile(
  directory: string,
  base: DocumentRetrievalEmbeddingProfile,
): Promise<DocumentRetrievalEmbeddingProfile> {
  const manifestBytes = await readFile(
    `${directory}/contextctl-embedding-assets.v1.json`,
  );
  const manifest = JSON.parse(
    manifestBytes.toString("utf8"),
  ) as LocalEmbeddingAssetManifest;
  const runtimeArtifact = manifest.files.find(
    (file) => file.path === "onnx/model.onnx",
  );
  if (runtimeArtifact === undefined || base.execution.kind !== "local") {
    throw new Error("fp32 baseline assets are not installed");
  }
  const serialized = serializeLocalEmbeddingAssetManifest(manifest);
  return {
    ...base,
    id: "document-granite-97m-multilingual-r2-fp32-baseline",
    execution: {
      ...base.execution,
      artifactPath: "onnx/model.onnx",
      artifactSha256: runtimeArtifact.sha256,
      assetManifestSha256: createHash("sha256")
        .update(serialized.trimEnd(), "utf8")
        .digest("hex"),
      precision: "fp32",
    },
  };
}

export function createLocalProvider(
  artifactDirectory: string,
  profile: DocumentRetrievalEmbeddingProfile,
): TransformersJsLocalEmbeddingAdapter {
  return new TransformersJsLocalEmbeddingAdapter({ artifactDirectory, profile });
}

export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(fraction * sorted.length) - 1,
  );
  return sorted[Math.max(0, index)] ?? Number.NaN;
}
