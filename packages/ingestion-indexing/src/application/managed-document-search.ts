import {
  PublishedDocumentScopeSchema,
  type PublishedDocumentScope,
} from "@contextctl/contracts";

import { sha256Digest } from "../domain/document-capture.js";
import type { EmbeddingProfile } from "../domain/embedding-profile.js";
import { canonicalJson } from "../domain/revision-identity.js";
import { createVectorRecordId } from "../domain/vector-index.js";
import type { EmbeddingPort } from "../ports/embedding.js";
import type { IndexPublicationStore } from "../ports/index-publication-store.js";
import {
  MAX_VECTOR_SEARCH_LIMIT,
  type VectorIndexPort,
  type VectorIndexScope,
  type VectorIndexSearchHit,
} from "../ports/vector-index.js";

const QUERY_EMBEDDING_KEY = "managed-document-query";

export interface ManagedDocumentSearchCommand {
  readonly queryText: string;
  readonly securityDomain: string;
  readonly scope: PublishedDocumentScope;
  readonly limit: number;
  readonly signal?: AbortSignal;
}

/**
 * Indexing-owned projection returned through the daemon's internal search
 * connection. Physical index details, vectors, and provider scores are omitted.
 */
export interface DocumentSearchHit {
  readonly rank: number;
  readonly chunkId: string;
  readonly chunkRevisionId: string;
  readonly semanticUnitId: string;
  readonly documentId: string;
  readonly text: string;
  readonly contentDigest: string;
}

export interface ManagedDocumentSearchDependencies {
  readonly embeddings: EmbeddingPort;
  readonly vectorIndex: VectorIndexPort;
  readonly publications: IndexPublicationStore;
}

export type ManagedDocumentSearchErrorCode =
  | "index_schema_unsupported"
  | "invalid_request"
  | "query_embedding_invalid"
  | "scope_not_published"
  | "search_result_invalid"
  | "security_domain_mismatch";

export class ManagedDocumentSearchError extends Error {
  constructor(readonly code: ManagedDocumentSearchErrorCode) {
    super(`Managed document search failed: ${code}`);
    this.name = "ManagedDocumentSearchError";
  }
}

/** Searches exactly one immutable managed-document Scope. */
export class ManagedDocumentSearch {
  readonly #embeddings: EmbeddingPort;
  readonly #vectorIndex: VectorIndexPort;
  readonly #publications: IndexPublicationStore;

  constructor(dependencies: ManagedDocumentSearchDependencies) {
    this.#embeddings = dependencies.embeddings;
    this.#vectorIndex = dependencies.vectorIndex;
    this.#publications = dependencies.publications;
  }

  async search(
    command: ManagedDocumentSearchCommand,
  ): Promise<readonly DocumentSearchHit[]> {
    const scope = parseCommand(command);
    const publication = await this.#publications.findVersion({
      documentIndexId: scope.documentIndex.documentIndexId,
      indexVersion: scope.documentIndex.indexVersion,
    });
    if (publication === undefined) {
      throw new ManagedDocumentSearchError("scope_not_published");
    }
    if (publication.securityDomain !== command.securityDomain) {
      throw new ManagedDocumentSearchError("security_domain_mismatch");
    }
    if (
      publication.manifest.payloadSchemaVersion !== 2 ||
      publication.documentIndex.documentIndexId !==
        publication.manifest.documentIndexId ||
      publication.documentIndex.indexVersion !==
        publication.manifest.indexVersion
    ) {
      throw new ManagedDocumentSearchError("index_schema_unsupported");
    }
    if (
      canonicalJson(publication.documentIndex) !==
        canonicalJson(scope.documentIndex) ||
      !publication.scopes.some(
        (publishedScope) =>
          canonicalJson(publishedScope) === canonicalJson(scope),
      )
    ) {
      throw new ManagedDocumentSearchError("scope_not_published");
    }

    const queryVector = await this.#embedQuery(
      command.queryText,
      publication.manifest.embeddingProfile,
      command.signal ?? new AbortController().signal,
    );
    const vectorScope: VectorIndexScope = {
      documentIndexId: scope.documentIndex.documentIndexId,
      indexVersion: scope.documentIndex.indexVersion,
      documentId: scope.documentIndex.documentId,
      ...(scope.selector.kind === "semantic_units"
        ? { semanticUnitIds: scope.selector.semanticUnitIds }
        : {}),
    };
    const hits = await this.#vectorIndex.search({
      accessHandle: publication.documentIndex.accessHandle,
      scope: vectorScope,
      queryVector,
      limit: command.limit,
    });
    if (
      hits.length > command.limit ||
      new Set(hits.map((hit) => hit.recordId)).size !== hits.length
    ) {
      throw new ManagedDocumentSearchError("search_result_invalid");
    }
    return hits.map((hit, index) =>
      projectHit(hit, index + 1, publication.manifest, vectorScope),
    );
  }

  async #embedQuery(
    queryText: string,
    profile: EmbeddingProfile,
    signal: AbortSignal,
  ): Promise<readonly number[]> {
    const outputs = await this.#embeddings.embed({
      profile,
      inputs: [{ key: QUERY_EMBEDDING_KEY, text: queryText }],
      signal,
    });
    const output = outputs[0];
    if (
      outputs.length !== 1 ||
      output?.key !== QUERY_EMBEDDING_KEY ||
      output.vector.length !== profile.dimensions ||
      output.vector.some((component) => !Number.isFinite(component))
    ) {
      throw new ManagedDocumentSearchError("query_embedding_invalid");
    }
    return output.vector;
  }
}

function parseCommand(
  command: ManagedDocumentSearchCommand,
): PublishedDocumentScope {
  const parsedScope = PublishedDocumentScopeSchema.safeParse(command.scope);
  if (
    !parsedScope.success ||
    command.queryText.trim() === "" ||
    command.securityDomain.trim() === "" ||
    !Number.isSafeInteger(command.limit) ||
    command.limit <= 0 ||
    command.limit > MAX_VECTOR_SEARCH_LIMIT
  ) {
    throw new ManagedDocumentSearchError("invalid_request");
  }
  return parsedScope.data;
}

function projectHit(
  hit: VectorIndexSearchHit,
  rank: number,
  manifest: {
    readonly payloadSchemaVersion: 2;
    readonly sourceId: string;
    readonly observationId: string;
    readonly documentId: string;
    readonly documentIndexId: string;
    readonly indexVersion: string;
    readonly semanticUnitRevisions: Readonly<Record<string, string>>;
    readonly chunkRevisions: Readonly<Record<string, string>>;
  },
  scope: VectorIndexScope,
): DocumentSearchHit {
  const metadata = hit.metadata;
  if (
    metadata.payloadSchemaVersion !== 2 ||
    metadata.sourceId !== manifest.sourceId ||
    metadata.observationId !== manifest.observationId ||
    metadata.documentId !== manifest.documentId ||
    metadata.documentIndexId !== manifest.documentIndexId ||
    metadata.indexVersion !== manifest.indexVersion ||
    hit.recordId !==
      createVectorRecordId(
        metadata.documentIndexId,
        metadata.indexVersion,
        metadata.chunkRevisionId,
      ) ||
    !Number.isFinite(hit.score) ||
    manifest.semanticUnitRevisions[metadata.semanticUnitId] === undefined ||
    manifest.chunkRevisions[metadata.chunkId] !== metadata.chunkRevisionId ||
    metadata.contentDigest !== sha256Digest(hit.retrievalText) ||
    (scope.semanticUnitIds !== undefined &&
      !scope.semanticUnitIds.includes(metadata.semanticUnitId))
  ) {
    throw new ManagedDocumentSearchError("search_result_invalid");
  }
  return {
    rank,
    chunkId: metadata.chunkId,
    chunkRevisionId: metadata.chunkRevisionId,
    semanticUnitId: metadata.semanticUnitId,
    documentId: metadata.documentId,
    text: hit.retrievalText,
    contentDigest: metadata.contentDigest,
  };
}
