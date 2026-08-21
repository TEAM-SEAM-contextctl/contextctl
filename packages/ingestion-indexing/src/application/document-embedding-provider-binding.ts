import {
  assertValidEmbeddingProfile,
  embeddingProfilesMatch,
  type DocumentRetrievalEmbeddingProfile,
} from "../domain/embedding-profile.js";
import type { EmbeddingPort } from "../ports/embedding.js";

/**
 * Verifies a production provider binding before publication or search starts.
 *
 * Provider kind alone is insufficient: two remote endpoints, or two local
 * artifacts, can produce incompatible vectors while both report the same
 * kind. The complete profile is therefore part of the adapter binding.
 */
export function assertProductionEmbeddingProvider(
  profile: DocumentRetrievalEmbeddingProfile,
  provider: EmbeddingPort,
): void {
  assertValidEmbeddingProfile(profile);
  if (
    provider.providerKind !== profile.execution.kind ||
    provider.embeddingProfile === undefined ||
    !embeddingProfilesMatch(provider.embeddingProfile, profile)
  ) {
    throw new TypeError(
      `production ${profile.execution.kind} profile requires an exact ${profile.execution.kind} provider binding`,
    );
  }
}
