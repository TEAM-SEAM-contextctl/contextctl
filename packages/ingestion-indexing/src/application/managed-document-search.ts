import {
  PublishedDocumentScopeSchema,
  type PublishedDocumentScope,
} from "@contextctl/contracts";

import { sha256Digest } from "../domain/document-capture.js";
import {
  measureText,
  TEXT_MEASURE_PROFILE_VERSION,
} from "../domain/document-indexing-policy.js";
import type { EmbeddingProfile } from "../domain/embedding-profile.js";
import { canonicalJson } from "../domain/revision-identity.js";
import { createVectorRecordId } from "../domain/vector-index.js";
import { EmbeddingProviderFault } from "../ports/embedding.js";
import {
  IndexCatalogFault,
  type IndexPublicationStore,
  type PublishedIndexVersion,
} from "../ports/index-publication-store.js";
import type {
  QueryEmbeddingProviderBinding,
  QueryEmbeddingProviderResolver,
  VectorIndexConnectorResolver,
} from "../ports/managed-document-search.js";
import {
  MAX_VECTOR_SEARCH_LIMIT,
  VectorIndexFault,
  type VectorIndexCompatibility,
  type VectorIndexPort,
  type VectorIndexScope,
  type VectorIndexSearchHit,
} from "../ports/vector-index.js";

const QUERY_EMBEDDING_KEY = "managed-document-query";
export const MAX_MANAGED_SEARCH_BATCH_TARGETS = 64;
export const DEFAULT_MANAGED_SEARCH_CONCURRENCY = 8;
export const MAX_MANAGED_SEARCH_QUERY_CHARACTERS = 32_768;

export interface ManagedDocumentSearchCommand {
  readonly queryText: string;
  readonly securityDomain: string;
  readonly scope: PublishedDocumentScope;
  readonly limit: number;
  readonly signal?: AbortSignal;
}

export interface BatchManagedDocumentSearchTarget {
  readonly targetKey: string;
  readonly securityDomain: string;
  readonly scope: PublishedDocumentScope;
  readonly limit: number;
}

export interface BatchManagedDocumentSearchCommand {
  readonly queryText: string;
  readonly targets: readonly BatchManagedDocumentSearchTarget[];
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

export interface ManagedDocumentSearchFailure {
  readonly code: ManagedDocumentSearchErrorCode;
  readonly retriable: boolean;
}

export type BatchManagedDocumentSearchItem =
  | {
      readonly targetKey: string;
      readonly status: "fulfilled";
      readonly hits: readonly DocumentSearchHit[];
    }
  | {
      readonly targetKey: string;
      readonly status: "failed";
      readonly failure: ManagedDocumentSearchFailure;
    };

export interface ManagedDocumentSearchDependencies {
  readonly embeddingProviders: QueryEmbeddingProviderResolver;
  readonly vectorIndexes: VectorIndexConnectorResolver;
  readonly publications: IndexPublicationStore;
  readonly maxConcurrency?: number;
}

export type ManagedDocumentSearchErrorCode =
  | "cancelled"
  | "embedding_provider_not_allowed"
  | "index_binding_invalid"
  | "index_binding_unavailable"
  | "index_catalog_corrupt"
  | "index_catalog_unavailable"
  | "index_schema_unsupported"
  | "invalid_request"
  | "query_embedding_failed"
  | "query_embedding_invalid"
  | "query_input_limit_exceeded"
  | "scope_not_published"
  | "search_result_invalid"
  | "security_domain_mismatch"
  | "unexpected_failure"
  | "vector_search_unavailable";

export class ManagedDocumentSearchError extends Error {
  constructor(
    readonly code: ManagedDocumentSearchErrorCode,
    readonly retriable = false,
  ) {
    super(`Managed document search failed: ${code}`);
    this.name = "ManagedDocumentSearchError";
  }
}

interface SearchRequestContext {
  readonly queryText: string;
  readonly signal: AbortSignal;
  readonly catalog: Map<string, Promise<PublishedIndexVersion | undefined>>;
  readonly embeddings: Map<string, Promise<readonly number[]>>;
  readonly bindings: Map<string, Promise<VectorIndexPort>>;
}

interface ResolvedTarget {
  readonly target: BatchManagedDocumentSearchTarget;
  readonly publication: PublishedIndexVersion;
  readonly scope: PublishedDocumentScope;
  readonly vectorScope: VectorIndexScope;
  readonly vectorIndex: VectorIndexPort;
  readonly queryVector: readonly number[];
}

/** Searches one or more immutable managed-document Scopes with target isolation. */
export class ManagedDocumentSearch {
  readonly #dependencies: ManagedDocumentSearchDependencies;
  readonly #maxConcurrency: number;

  constructor(dependencies: ManagedDocumentSearchDependencies) {
    if (
      dependencies.maxConcurrency !== undefined &&
      (!Number.isSafeInteger(dependencies.maxConcurrency) ||
        dependencies.maxConcurrency <= 0 ||
        dependencies.maxConcurrency > MAX_MANAGED_SEARCH_BATCH_TARGETS)
    ) {
      throw new TypeError("managed document search concurrency is invalid");
    }
    this.#dependencies = dependencies;
    this.#maxConcurrency =
      dependencies.maxConcurrency ?? DEFAULT_MANAGED_SEARCH_CONCURRENCY;
  }

  async search(
    command: ManagedDocumentSearchCommand,
  ): Promise<readonly DocumentSearchHit[]> {
    const items = await this.searchBatch({
      queryText: command.queryText,
      targets: [
        {
          targetKey: "single-target",
          securityDomain: command.securityDomain,
          scope: command.scope,
          limit: command.limit,
        },
      ],
      ...(command.signal === undefined ? {} : { signal: command.signal }),
    });
    const item = items[0];
    if (item === undefined) {
      throw new ManagedDocumentSearchError("unexpected_failure");
    }
    if (item.status === "failed") {
      throw new ManagedDocumentSearchError(
        item.failure.code,
        item.failure.retriable,
      );
    }
    return item.hits;
  }

  async searchBatch(
    command: BatchManagedDocumentSearchCommand,
  ): Promise<readonly BatchManagedDocumentSearchItem[]> {
    validateBatchCommand(command);
    const context: SearchRequestContext = {
      queryText: command.queryText,
      signal: command.signal ?? new AbortController().signal,
      catalog: new Map(),
      embeddings: new Map(),
      bindings: new Map(),
    };
    return mapWithConcurrency(
      command.targets,
      this.#maxConcurrency,
      async (target): Promise<BatchManagedDocumentSearchItem> => {
        try {
          const hits = await this.#searchTarget(target, context);
          return { targetKey: target.targetKey, status: "fulfilled", hits };
        } catch (error) {
          const failure = toManagedSearchError(error);
          return {
            targetKey: target.targetKey,
            status: "failed",
            failure: { code: failure.code, retriable: failure.retriable },
          };
        }
      },
    );
  }

  async #searchTarget(
    target: BatchManagedDocumentSearchTarget,
    context: SearchRequestContext,
  ): Promise<readonly DocumentSearchHit[]> {
    const resolved = await this.#resolveTarget(target, context);
    let hits: readonly VectorIndexSearchHit[];
    try {
      hits = await resolved.vectorIndex.search({
        accessHandle: resolved.publication.documentIndex.accessHandle,
        scope: resolved.vectorScope,
        queryVector: resolved.queryVector,
        limit: resolved.target.limit,
      });
    } catch (error) {
      throw mapVectorSearchError(error);
    }
    if (
      hits.length > resolved.target.limit ||
      new Set(hits.map((hit) => hit.recordId)).size !== hits.length
    ) {
      throw new ManagedDocumentSearchError("search_result_invalid");
    }
    return hits.map((hit, index) =>
      projectHit(
        hit,
        index + 1,
        resolved.publication.manifest,
        resolved.vectorScope,
      ),
    );
  }

  async #resolveTarget(
    target: BatchManagedDocumentSearchTarget,
    context: SearchRequestContext,
  ): Promise<ResolvedTarget> {
    const scope = parseTarget(target);
    const publication = await this.#catalogPublication(scope, context);
    if (publication === undefined) {
      throw new ManagedDocumentSearchError("scope_not_published");
    }
    if (publication.securityDomain !== target.securityDomain) {
      throw new ManagedDocumentSearchError("security_domain_mismatch");
    }
    if (
      publication.manifest.embeddingProfile.textMeasureProfileVersion ===
        TEXT_MEASURE_PROFILE_VERSION &&
      measureText(context.queryText) >
        publication.manifest.embeddingProfile.maxInputTokens
    ) {
      throw new ManagedDocumentSearchError("query_input_limit_exceeded");
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

    const provider = this.#dependencies.embeddingProviders.resolve({
      securityDomain: target.securityDomain,
      embeddingProfile: publication.manifest.embeddingProfile,
    });
    if (provider === undefined) {
      throw new ManagedDocumentSearchError(
        "embedding_provider_not_allowed",
      );
    }
    const vectorIndex = this.#dependencies.vectorIndexes.resolve(
      publication.documentIndex.connectorId,
    );
    if (vectorIndex === undefined) {
      throw new ManagedDocumentSearchError("index_binding_unavailable");
    }

    const compatibility: VectorIndexCompatibility = {
      securityDomain: target.securityDomain,
      embeddingProfile: publication.manifest.embeddingProfile,
      payloadSchemaVersion: 2,
    };
    const [rehydrated, queryVector] = await Promise.all([
      this.#rehydrateBinding(
        vectorIndex,
        publication.documentIndex.connectorId,
        publication.documentIndex.accessHandle,
        compatibility,
        context,
      ),
      this.#queryEmbedding(
        provider,
        target.securityDomain,
        publication.manifest.embeddingProfile,
        context,
      ),
    ]);
    const vectorScope: VectorIndexScope = {
      documentIndexId: scope.documentIndex.documentIndexId,
      indexVersion: scope.documentIndex.indexVersion,
      documentId: scope.documentIndex.documentId,
      ...(scope.selector.kind === "semantic_units"
        ? { semanticUnitIds: scope.selector.semanticUnitIds }
        : {}),
    };
    return {
      target,
      publication,
      scope,
      vectorScope,
      vectorIndex: rehydrated,
      queryVector,
    };
  }

  async #catalogPublication(
    scope: PublishedDocumentScope,
    context: SearchRequestContext,
  ): Promise<PublishedIndexVersion | undefined> {
    const key = `${scope.documentIndex.documentIndexId}\u0000${scope.documentIndex.indexVersion}`;
    let pending = context.catalog.get(key);
    if (pending === undefined) {
      pending = this.#dependencies.publications.findVersion({
        documentIndexId: scope.documentIndex.documentIndexId,
        indexVersion: scope.documentIndex.indexVersion,
      });
      context.catalog.set(key, pending);
    }
    try {
      return await pending;
    } catch (error) {
      throw mapCatalogError(error);
    }
  }

  async #rehydrateBinding(
    vectorIndex: VectorIndexPort,
    connectorId: string,
    accessHandle: string,
    compatibility: VectorIndexCompatibility,
    context: SearchRequestContext,
  ): Promise<VectorIndexPort> {
    const key = `${connectorId}\u0000${accessHandle}\u0000${canonicalJson(compatibility)}`;
    let pending = context.bindings.get(key);
    if (pending === undefined) {
      pending = (async () => {
        try {
          await vectorIndex.rehydrate({ accessHandle, compatibility });
          return vectorIndex;
        } catch (error) {
          throw mapBindingError(error);
        }
      })();
      context.bindings.set(key, pending);
    }
    return pending;
  }

  async #queryEmbedding(
    binding: QueryEmbeddingProviderBinding,
    securityDomain: string,
    profile: EmbeddingProfile,
    context: SearchRequestContext,
  ): Promise<readonly number[]> {
    const key = `${securityDomain}\u0000${binding.providerId}\u0000${canonicalJson(profile)}`;
    let pending = context.embeddings.get(key);
    if (pending === undefined) {
      pending = embedQuery(
        binding,
        context.queryText,
        profile,
        context.signal,
      );
      context.embeddings.set(key, pending);
    }
    return pending;
  }
}

async function embedQuery(
  binding: QueryEmbeddingProviderBinding,
  queryText: string,
  profile: EmbeddingProfile,
  signal: AbortSignal,
): Promise<readonly number[]> {
  let outputs;
  try {
    outputs = await binding.provider.embed({
      profile,
      inputs: [{ key: QUERY_EMBEDDING_KEY, text: queryText }],
      signal,
    });
  } catch (error) {
    if (signal.aborted) {
      throw new ManagedDocumentSearchError("cancelled");
    }
    if (error instanceof EmbeddingProviderFault) {
      throw new ManagedDocumentSearchError(
        "query_embedding_failed",
        error.retriable,
      );
    }
    throw new ManagedDocumentSearchError("query_embedding_failed");
  }
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

function validateBatchCommand(command: BatchManagedDocumentSearchCommand): void {
  if (
    command.queryText.trim() === "" ||
    command.queryText.length > MAX_MANAGED_SEARCH_QUERY_CHARACTERS ||
    command.targets.length === 0 ||
    command.targets.length > MAX_MANAGED_SEARCH_BATCH_TARGETS ||
    command.signal?.aborted === true ||
    new Set(command.targets.map((target) => target.targetKey)).size !==
      command.targets.length ||
    command.targets.some((target) => target.targetKey.trim() === "")
  ) {
    throw new ManagedDocumentSearchError(
      command.signal?.aborted === true ? "cancelled" : "invalid_request",
    );
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  task: (value: T) => Promise<R>,
): Promise<readonly R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (next < values.length) {
        const index = next;
        next += 1;
        results[index] = await task(values[index]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function parseTarget(
  target: BatchManagedDocumentSearchTarget,
): PublishedDocumentScope {
  const parsedScope = PublishedDocumentScopeSchema.safeParse(target.scope);
  if (
    !parsedScope.success ||
    target.securityDomain.trim() === "" ||
    !Number.isSafeInteger(target.limit) ||
    target.limit <= 0 ||
    target.limit > MAX_VECTOR_SEARCH_LIMIT
  ) {
    throw new ManagedDocumentSearchError("invalid_request");
  }
  return parsedScope.data;
}

function mapCatalogError(error: unknown): ManagedDocumentSearchError {
  if (error instanceof IndexCatalogFault) {
    if (error.code === "schema_unsupported") {
      return new ManagedDocumentSearchError("index_schema_unsupported");
    }
    if (error.code === "corrupt_record") {
      return new ManagedDocumentSearchError("index_catalog_corrupt");
    }
    return new ManagedDocumentSearchError(
      "index_catalog_unavailable",
      error.retriable,
    );
  }
  return new ManagedDocumentSearchError("index_catalog_unavailable", true);
}

function mapBindingError(error: unknown): ManagedDocumentSearchError {
  if (error instanceof VectorIndexFault) {
    if (
      error.code === "invalid_request" ||
      error.code === "filter_not_supported"
    ) {
      return new ManagedDocumentSearchError("index_binding_invalid");
    }
    return new ManagedDocumentSearchError(
      "index_binding_unavailable",
      error.retriable,
    );
  }
  return new ManagedDocumentSearchError("index_binding_unavailable", true);
}

function mapVectorSearchError(error: unknown): ManagedDocumentSearchError {
  if (error instanceof VectorIndexFault) {
    if (
      error.code === "invalid_request" ||
      error.code === "filter_not_supported"
    ) {
      return new ManagedDocumentSearchError("index_binding_invalid");
    }
    if (error.code === "index_unavailable") {
      return new ManagedDocumentSearchError("index_binding_unavailable");
    }
    return new ManagedDocumentSearchError(
      "vector_search_unavailable",
      error.retriable,
    );
  }
  return new ManagedDocumentSearchError("vector_search_unavailable", true);
}

function toManagedSearchError(error: unknown): ManagedDocumentSearchError {
  return error instanceof ManagedDocumentSearchError
    ? error
    : new ManagedDocumentSearchError("unexpected_failure");
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
