import {
  type EmbeddingPipeline,
  type ReusableChunkEmbedding,
} from "./embed-managed-chunks.js";
import type { DocumentIndexPublisher } from "./publish-document-index.js";
import type { SemanticPublishedScopeInput } from "./published-document-scope.js";
import {
  inheritableScopeUnitIds,
  planDocumentIncrementalUpdate,
  type DocumentIncrementalUpdatePlan,
  type DocumentIndexingSnapshot,
} from "../domain/document-incremental-update.js";
import type { ManagedChunk } from "../domain/document-model.js";
import { embeddingProfilesMatch } from "../domain/embedding-profile.js";
import { createDocumentIndexId } from "../domain/index-manifest.js";
import type {
  IndexPublicationStoreV2 as IndexPublicationStore,
  PublishedIndexVersionV2 as PublishedIndexVersion,
} from "../ports/index-publication-store.js";
import {
  MAX_VECTOR_VECTOR_READ,
  type VectorIndexPort,
} from "../ports/vector-index.js";

export interface ReindexDocumentCommand {
  readonly stateNamespaceId: string;
  readonly connectorId: string;
  readonly securityDomain: string;
  /** Absent for a first observation, which always plans a full rebuild. */
  readonly previous?: DocumentIndexingSnapshot;
  readonly current: DocumentIndexingSnapshot;
  readonly semanticScopes?: readonly SemanticPublishedScopeInput[];
  readonly signal?: AbortSignal;
}

/** Why previously published vectors could not be copied into this version. */
export type VectorReuseDegradation =
  | "binding_unavailable"
  | "incompatible_profile"
  | "no_previous_version";

export interface ReindexDocumentMetrics {
  readonly strategy: DocumentIncrementalUpdatePlan["strategy"];
  readonly plannedEmbeddingCallCount: number;
  readonly embeddedChunkCount: number;
  readonly reusedVectorCount: number;
  readonly discardedVectorCount: number;
  readonly removedChunkRevisionIds: readonly string[];
  readonly reuseDegradation?: VectorReuseDegradation;
}

export interface ReindexDocumentResult {
  /** `already_published` when the current head already was this exact version. */
  readonly status: "already_published" | "published";
  readonly plan: DocumentIncrementalUpdatePlan;
  readonly publication: PublishedIndexVersion;
  readonly previousIndexVersion?: string;
  /** Units whose predecessor Scope stays valid for this Publication. */
  readonly inheritableUnitIds: readonly string[];
  readonly metrics: ReindexDocumentMetrics;
}

export type ReindexDocumentErrorCode =
  | "empty_index_unsupported"
  | "stale_chunk_revision_published";

export class ReindexDocumentError extends Error {
  constructor(readonly code: ReindexDocumentErrorCode) {
    super(`Incremental document reindex failed: ${code}`);
    this.name = "ReindexDocumentError";
  }
}

export interface IncrementalDocumentReindexerDependencies {
  readonly vectorIndex: VectorIndexPort;
  readonly publications: IndexPublicationStore;
  readonly embeddingPipeline: EmbeddingPipeline;
  readonly indexPublisher: DocumentIndexPublisher;
}

/**
 * Turns one incremental update plan into a new immutable Index version.
 *
 * Nothing observable changes until the publisher commits: the vectors of
 * unchanged Chunk revisions are copied into the new staging version, only the
 * affected revisions reach the embedding provider, and any failure before the
 * commit leaves the previous current version serving traffic.
 */
export class IncrementalDocumentReindexer {
  readonly #dependencies: IncrementalDocumentReindexerDependencies;

  constructor(dependencies: IncrementalDocumentReindexerDependencies) {
    this.#dependencies = dependencies;
  }

  async reindex(command: ReindexDocumentCommand): Promise<ReindexDocumentResult> {
    const plan = planDocumentIncrementalUpdate({
      ...(command.previous === undefined ? {} : { previous: command.previous }),
      current: command.current,
    });
    if (plan.chunks.length === 0) {
      throw new ReindexDocumentError("empty_index_unsupported");
    }
    const documentIndexId = createDocumentIndexId(
      command.current.document.sourceId,
      command.current.document.documentId,
    );
    const head = await this.#dependencies.publications.current(documentIndexId);
    const harvest = await this.#harvest(head, plan.chunks, command);
    const embedded = await this.#dependencies.embeddingPipeline.embed({
      chunks: plan.chunks,
      profile: command.current.embeddingProfile,
      reusable: harvest.reusable,
      ...(command.signal === undefined ? {} : { signal: command.signal }),
    });
    const committed = await this.#dependencies.indexPublisher.publish({
      stateNamespaceId: command.stateNamespaceId,
      document: command.current.document,
      semanticUnits: command.current.semanticUnits,
      chunks: plan.chunks,
      embeddings: embedded.embeddings,
      embeddingProfile: embedded.profile,
      connectorId: command.connectorId,
      securityDomain: command.securityDomain,
      ...(command.semanticScopes === undefined
        ? {}
        : { semanticScopes: command.semanticScopes }),
    });
    // A profile-only rebuild replays every previous revision into the new
    // version, so "deleted" means dropped from the current set, not restaged.
    const republished = new Set(plan.chunks.map((chunk) => chunk.revisionId));
    const removedChunkRevisionIds = plan.operations.delete
      .map((revision) => revision.chunkRevisionId)
      .filter((revisionId) => !republished.has(revisionId))
      .sort();
    assertNoStaleRevisions(committed, removedChunkRevisionIds);
    return {
      status:
        head?.manifest.indexVersion === committed.manifest.indexVersion
          ? "already_published"
          : "published",
      plan,
      publication: committed,
      ...(head === undefined
        ? {}
        : { previousIndexVersion: head.manifest.indexVersion }),
      inheritableUnitIds:
        command.previous === undefined
          ? []
          : inheritableScopeUnitIds({ previous: command.previous, plan }),
      metrics: {
        strategy: plan.strategy,
        plannedEmbeddingCallCount: plan.metrics.embeddingCallCount,
        embeddedChunkCount: embedded.generatedCount,
        reusedVectorCount: embedded.reusedCount,
        discardedVectorCount: harvest.discardedCount,
        removedChunkRevisionIds,
        ...(harvest.degradation === undefined
          ? {}
          : { reuseDegradation: harvest.degradation }),
      },
    };
  }

  /**
   * Reuse is an optimisation, never a correctness input: an unreadable or
   * mismatched vector is dropped and the Chunk is embedded again.
   */
  async #harvest(
    head: PublishedIndexVersion | undefined,
    chunks: readonly ManagedChunk[],
    command: ReindexDocumentCommand,
  ): Promise<{
    readonly reusable: readonly ReusableChunkEmbedding[];
    readonly discardedCount: number;
    readonly degradation?: VectorReuseDegradation;
  }> {
    if (head === undefined) {
      return { reusable: [], discardedCount: 0, degradation: "no_previous_version" };
    }
    const profile = command.current.embeddingProfile;
    if (
      !embeddingProfilesMatch(head.manifest.embeddingProfile, profile) ||
      head.binding.stateNamespaceId !== command.stateNamespaceId ||
      head.binding.securityDomain !== command.securityDomain
    ) {
      return {
        reusable: [],
        discardedCount: 0,
        degradation: "incompatible_profile",
      };
    }
    const published = new Set(Object.values(head.manifest.chunkRevisions));
    const candidates = chunks.filter((chunk) => published.has(chunk.revisionId));
    if (candidates.length === 0) {
      return { reusable: [], discardedCount: 0 };
    }
    const digestByRevision = new Map(
      candidates.map((chunk) => [chunk.revisionId, chunk.contentDigest]),
    );
    let stored;
    try {
      stored = await this.#readVectors(head, [...digestByRevision.keys()], profile);
    } catch {
      return {
        reusable: [],
        discardedCount: 0,
        degradation: "binding_unavailable",
      };
    }
    const reusable: ReusableChunkEmbedding[] = [];
    let discardedCount = 0;
    for (const vector of stored) {
      const contentDigest = digestByRevision.get(vector.chunkRevisionId);
      if (contentDigest === undefined || contentDigest !== vector.contentDigest) {
        discardedCount += 1;
        continue;
      }
      reusable.push({
        chunkRevisionId: vector.chunkRevisionId,
        contentDigest,
        profile,
        vector: vector.embedding,
      });
    }
    return { reusable, discardedCount };
  }

  async #readVectors(
    head: PublishedIndexVersion,
    chunkRevisionIds: readonly string[],
    profile: DocumentIndexingSnapshot["embeddingProfile"],
  ): Promise<
    readonly {
      readonly chunkRevisionId: string;
      readonly contentDigest: string;
      readonly embedding: readonly number[];
    }[]
  > {
    await this.#dependencies.vectorIndex.rehydrate({
      accessHandle: head.binding.accessHandle,
      compatibility: {
        stateNamespaceId: head.binding.stateNamespaceId,
        securityDomain: head.binding.securityDomain,
        embeddingProfile: profile,
        payloadSchemaVersion: 2,
      },
    });
    const vectors = [];
    for (
      let offset = 0;
      offset < chunkRevisionIds.length;
      offset += MAX_VECTOR_VECTOR_READ
    ) {
      vectors.push(
        ...(await this.#dependencies.vectorIndex.readVersionVectors({
          accessHandle: head.binding.accessHandle,
          documentIndexId: head.manifest.documentIndexId,
          indexVersion: head.manifest.indexVersion,
          chunkRevisionIds: chunkRevisionIds.slice(
            offset,
            offset + MAX_VECTOR_VECTOR_READ,
          ),
        })),
      );
    }
    return vectors;
  }
}

function assertNoStaleRevisions(
  publication: PublishedIndexVersion,
  removedChunkRevisionIds: readonly string[],
): void {
  const removed = new Set(removedChunkRevisionIds);
  if (
    Object.values(publication.manifest.chunkRevisions).some((revisionId) =>
      removed.has(revisionId),
    )
  ) {
    throw new ReindexDocumentError("stale_chunk_revision_published");
  }
}
