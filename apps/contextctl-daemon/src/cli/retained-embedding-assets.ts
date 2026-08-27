import {
  isDocumentRetrievalEmbeddingProfile,
  verifyLocalEmbeddingAssetLayout,
  verifyLocalEmbeddingAssets,
} from "@contextctl/ingestion-indexing";

import {
  DOCUMENT_RETAINED_EMBEDDING_BINDINGS_VARIABLE,
  type EmbeddingCompositionConfiguration,
} from "../embedding/configuration.js";
import type { RequiredEmbeddingBindings } from "../embedding/required-bindings.js";
import { retainedDocumentProfiles } from "../embedding/required-bindings.js";
import {
  describeAssetDirectoryProblem,
  type AssetDirectoryProblem,
} from "./asset-directory.js";

/** Verifies every retained local profile that remains reachable from a Card. */
export async function verifyRequiredRetainedLocalBindings(
  configuration: EmbeddingCompositionConfiguration,
  requiredBindings: RequiredEmbeddingBindings,
  options: { readonly verifyContent?: boolean } = {},
): Promise<void> {
  for (const profile of retainedDocumentProfiles(requiredBindings)) {
    if (
      !isDocumentRetrievalEmbeddingProfile(profile) ||
      profile.execution.kind !== "local"
    ) {
      continue;
    }
    const binding = (configuration.retainedDocumentBindings ?? []).find(
      (candidate) =>
        candidate.profileId === profile.id &&
        candidate.profileVersion === profile.version,
    );
    if (binding?.mode !== "local") {
      throw new EmbeddingAssetsUnavailableError({
        kind: "not_installed",
        pointerPath: DOCUMENT_RETAINED_EMBEDDING_BINDINGS_VARIABLE,
        reason: `retained binding missing for ${profile.id} ${profile.version}`,
      });
    }
    try {
      await (options.verifyContent === false
        ? verifyLocalEmbeddingAssetLayout(binding.artifactDirectory, profile)
        : verifyLocalEmbeddingAssets(binding.artifactDirectory, profile));
    } catch (error) {
      throw new EmbeddingAssetsUnavailableError({
        kind: "not_installed",
        pointerPath: DOCUMENT_RETAINED_EMBEDDING_BINDINGS_VARIABLE,
        reason: `retained assets unavailable for ${profile.id} ${profile.version}: ${describeError(error)}`,
      });
    }
  }
}

/** The composition cannot use one of the local artifact families it requires. */
export class EmbeddingAssetsUnavailableError extends Error {
  readonly problem: AssetDirectoryProblem;

  constructor(problem: AssetDirectoryProblem) {
    super(describeAssetDirectoryProblem(problem));
    this.name = "EmbeddingAssetsUnavailableError";
    this.problem = problem;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
