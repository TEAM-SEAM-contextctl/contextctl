/** Shown when a production profile has no installed assets to read. */
export const EMBEDDING_ASSETS_MISSING_GUIDANCE =
  "Embedding assets are not installed. Install the pinned revision, then set the artifact directory.";

/**
 * Lightweight copy of the pinned Granite manifest total.
 *
 * Cheap CLI commands import this module specifically to avoid loading the
 * Ingestion package. The asset installation test compares this value with the
 * owning manifest, so changing that manifest cannot leave these labels stale.
 */
export const DEFAULT_GRANITE_ASSET_TOTAL_BYTES = 415_321_225;

export const DEFAULT_GRANITE_ASSET_SIZE_COMPACT = formatEmbeddingAssetSize(
  DEFAULT_GRANITE_ASSET_TOTAL_BYTES,
  "compact",
);

export const DEFAULT_GRANITE_ASSET_SIZE_INLINE = formatEmbeddingAssetSize(
  DEFAULT_GRANITE_ASSET_TOTAL_BYTES,
  "inline",
);

/** Formats binary size first and the familiar decimal download size second. */
export function formatEmbeddingAssetSize(
  bytes: number,
  style: "compact" | "inline",
): string {
  const binary = `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  const decimal = `${Math.round(bytes / 1_000_000)} MB`;
  return style === "compact"
    ? `${binary}(약 ${decimal})`
    : `${binary}, 약 ${decimal}`;
}
