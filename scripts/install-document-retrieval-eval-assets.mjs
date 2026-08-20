import { installLocalEmbeddingAssets } from "../packages/ingestion-indexing/dist/index.js";
import {
  GRANITE_FP32_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
  GRANITE_FP32_EMBEDDING_ASSET_MANIFEST,
  GRANITE_Q8_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
  GRANITE_Q8_EMBEDDING_ASSET_MANIFEST,
} from "../packages/ingestion-indexing/dist/infrastructure/transformers-js-local-embedding-adapter.js";
import { HuggingFaceLocalEmbeddingAssetSource } from "../apps/contextctl-daemon/dist/cli/asset-installation.js";

const variants = Object.freeze({
  fp32: Object.freeze({
    manifest: GRANITE_FP32_EMBEDDING_ASSET_MANIFEST,
    profile: GRANITE_FP32_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
  }),
  q8: Object.freeze({
    manifest: GRANITE_Q8_EMBEDDING_ASSET_MANIFEST,
    profile: GRANITE_Q8_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
  }),
});

const variantName = process.argv[2];
const targetDirectory = process.argv[3];
const variant = Object.hasOwn(variants, variantName ?? "")
  ? variants[variantName]
  : undefined;

if (
  variant === undefined ||
  targetDirectory === undefined ||
  targetDirectory.trim() === "" ||
  process.argv.length !== 4
) {
  console.error(
    "usage: node scripts/install-document-retrieval-eval-assets.mjs <fp32|q8> <absolute-target-directory>",
  );
  process.exit(2);
}

const source = new HuggingFaceLocalEmbeddingAssetSource({
  manifest: variant.manifest,
  progress: (message) => console.error(message),
});
const result = await installLocalEmbeddingAssets({
  profile: variant.profile,
  manifest: variant.manifest,
  targetDirectory,
  source,
});

process.stdout.write(result.directory);
