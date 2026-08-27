import type { EmbeddingExecutionMode } from "./configuration.js";
import type { EmbeddingLayerReport } from "./composition.js";
import type { RequiredEmbeddingBindings } from "./required-bindings.js";

/**
 * What the embedding composition contributes to lane readiness.
 *
 * Its whole job is to make "the artifact directory is empty" stop being a
 * verdict on its own. Before both layers could be configured independently there
 * was one answer — a local model or nothing — so absent assets and an unusable
 * daemon were the same observation. They are now different questions, and the
 * lane rules need the second one to judge the first.
 */
export type EmbeddingObservation =
  | {
      readonly status: "composed";
      readonly documentMode: EmbeddingExecutionMode;
      readonly cardMode: EmbeddingExecutionMode;
      /**
       * Whether anything in the required binding set reads a local artifact.
       *
       * Not the same as "a layer is configured local". An approved Card can
       * still reference a Scope published under a local profile after both
       * layers moved to a remote provider, and that Scope has to stay
       * searchable, so the requirement outlives the configuration.
       */
      readonly requiresLocalAssets: boolean;
      /** Whether the managed active revision selected by install-assets is used. */
      readonly requiresManagedAssets: boolean;
      /** Profiles bound only because something still reaches them. */
      readonly restoredProfiles: readonly string[];
    }
  | {
      readonly status: "unavailable";
      /**
       * Why the bindings could not be assembled, in the operator's language.
       *
       * Built from failure codes and variable names by the caller. Nothing
       * derived from a credential, an endpoint's contents or a provider payload
       * reaches this string.
       */
      readonly detail: string;
    };

export function observeEmbedding(input: {
  readonly document: EmbeddingLayerReport;
  readonly card: EmbeddingLayerReport;
  readonly restoredProfiles: readonly string[];
  readonly required: RequiredEmbeddingBindings;
}): EmbeddingObservation {
  return {
    status: "composed",
    documentMode: input.document.mode,
    cardMode: input.card.mode,
    requiresLocalAssets: input.required.needsLocalAssets,
    requiresManagedAssets:
      input.document.mode === "local" || input.card.mode === "local",
    restoredProfiles: input.restoredProfiles,
  };
}

/**
 * Whether missing local assets are fatal for this deployment.
 *
 * The one question the asset lane could not previously ask. A composition that
 * needs no local artifact is not degraded by the absence of one — it is a
 * deployment that was configured not to have it, and reporting `not_ready`
 * would tell an operator to install a 390MB model their daemon will never open.
 *
 * An unassembled composition is fatal regardless. Not knowing which bindings are
 * required is not the same as knowing none are.
 */
export function managedAssetsAreRequired(
  observation: EmbeddingObservation,
): boolean {
  return observation.status !== "composed" || observation.requiresManagedAssets;
}

/**
 * One line describing how the two layers were bound.
 *
 * Modes and profile identifiers only. The endpoint is available in the
 * composition report for the operator who asks for it explicitly; a status line
 * that printed it by default would put a hostname an operator may consider
 * sensitive into every routine health check.
 */
export function describeEmbeddingModes(
  observation: EmbeddingObservation,
): string {
  if (observation.status === "unavailable") {
    return observation.detail;
  }
  const base = `문서 검색 ${observation.documentMode}, Card 선택 ${observation.cardMode}`;
  if (observation.restoredProfiles.length === 0) {
    return base;
  }
  return `${base}. 승인 Card 가 아직 참조하는 이전 프로필 ${observation.restoredProfiles.length}개를 함께 바인딩했습니다: ${observation.restoredProfiles.join(", ")}`;
}
