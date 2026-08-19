import {
  PublishedScopeRefV2Schema as PublishedScopeRefSchema,
  type PublishedDocumentScope as LegacyPublishedDocumentScope,
  type PublishedDocumentScopeV2 as PublishedDocumentScope,
  type PublishedScopeRefV2 as PublishedScopeRef,
} from "@contextctl/contracts";

import { sha256Digest } from "../domain/document-capture.js";
import {
  measureText,
  TEXT_MEASURE_PROFILE_VERSION,
} from "../domain/document-indexing-policy.js";
import {
  embeddingVectorMatchesProfile,
  type EmbeddingProfile,
} from "../domain/embedding-profile.js";
import { canonicalJson } from "../domain/revision-identity.js";
import { createVectorRecordId } from "../domain/vector-index.js";
import { EmbeddingProviderFault } from "../ports/embedding.js";
import {
  IndexCatalogFault,
  type IndexPublicationStore as LegacyIndexPublicationStore,
  type IndexPublicationStoreV2 as IndexPublicationStore,
  type PublishedIndexVersion as LegacyPublishedIndexVersion,
  type PublishedIndexVersionV2 as PublishedIndexVersion,
  type PublishedScopeCatalogEntry,
} from "../ports/index-publication-store.js";
import type {
  QueryEmbeddingProviderBinding,
  QueryEmbeddingProviderResolver,
  VectorIndexConnectorResolver,
} from "../ports/managed-document-search.js";
import {
  MAX_VECTOR_SEARCH_LIMIT,
  VectorIndexFault,
  type VectorIndexCompatibilityV2 as VectorIndexCompatibility,
  type VectorIndexPort,
  type VectorIndexScope,
  type VectorIndexSearchHit,
} from "../ports/vector-index.js";

const QUERY_EMBEDDING_KEY = "managed-document-query";
export const MAX_MANAGED_SEARCH_BATCH_TARGETS = 64;
export const DEFAULT_MANAGED_SEARCH_CONCURRENCY = 8;
export const MAX_MANAGED_SEARCH_QUERY_CHARACTERS = 32_768;

/** @deprecated Use ManagedDocumentSearchV2Command after daemon migration. */
export interface ManagedDocumentSearchCommand {
  readonly queryText: string;
  readonly securityDomain: string;
  readonly scope: LegacyPublishedDocumentScope;
  readonly limit: number;
  readonly signal?: AbortSignal;
}

export interface ManagedDocumentSearchV2Command {
  readonly queryText: string;
  readonly securityDomain: string;
  readonly scopeRef: PublishedScopeRef;
  readonly limit: number;
  readonly signal?: AbortSignal;
}

export interface BatchManagedDocumentSearchTarget {
  readonly targetKey: string;
  readonly scopeRef: PublishedScopeRef;
  readonly limit: number;
}

export interface BatchManagedDocumentSearchCommand {
  readonly queryText: string;
  readonly securityDomain: string;
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
  readonly publications: IndexPublicationStore | LegacyIndexPublicationStore;
  readonly maxConcurrency?: number;
}

export type ManagedDocumentSearchErrorCode =
  | "cancelled"
  | "embedding_artifact_unavailable"
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
  readonly securityDomain: string;
  readonly catalog: Map<string, Promise<PublishedScopeCatalogEntry | undefined>>;
  readonly legacyScopes: ReadonlyMap<string, LegacyPublishedDocumentScope>;
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
  ): Promise<readonly DocumentSearchHit[]>;
  async search(
    command: ManagedDocumentSearchV2Command,
  ): Promise<readonly DocumentSearchHit[]>;
  async search(
    command: ManagedDocumentSearchCommand | ManagedDocumentSearchV2Command,
  ): Promise<readonly DocumentSearchHit[]> {
    const scopeRef = "scopeRef" in command
      ? command.scopeRef
      : { scopeId: command.scope.scopeId, scopeVersion: command.scope.scopeVersion };
    const legacyScopes = "scope" in command
      ? new Map([[scopeKey(scopeRef), command.scope]])
      : new Map<string, LegacyPublishedDocumentScope>();
    const items = await this.#searchBatch({
      queryText: command.queryText,
      securityDomain: command.securityDomain,
      targets: [
        {
          targetKey: "single-target",
          scopeRef,
          limit: command.limit,
        },
      ],
      ...(command.signal === undefined ? {} : { signal: command.signal }),
    }, legacyScopes);
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
    return this.#searchBatch(command, new Map());
  }

  async #searchBatch(
    command: BatchManagedDocumentSearchCommand,
    legacyScopes: ReadonlyMap<string, LegacyPublishedDocumentScope>,
  ): Promise<readonly BatchManagedDocumentSearchItem[]> {
    validateBatchCommand(command);
    const context: SearchRequestContext = {
      queryText: command.queryText,
      securityDomain: command.securityDomain,
      signal: command.signal ?? new AbortController().signal,
      catalog: new Map(),
      legacyScopes,
      embeddings: new Map(),
      bindings: new Map(),
    };
    return mapWithConcurrency(
      command.targets,
      this.#maxConcurrency,
      context.signal,
      async (target): Promise<BatchManagedDocumentSearchItem> => {
        try {
          context.signal.throwIfAborted();
          const hits = await this.#searchTarget(target, context);
          return { targetKey: target.targetKey, status: "fulfilled", hits };
        } catch (error) {
          if (context.signal.aborted) {
            return cancelledItem(target.targetKey);
          }
          const failure = toManagedSearchError(error);
          return {
            targetKey: target.targetKey,
            status: "failed",
            failure: { code: failure.code, retriable: failure.retriable },
          };
        }
      },
      (target) => cancelledItem(target.targetKey),
    );
  }

  async #searchTarget(
    target: BatchManagedDocumentSearchTarget,
    context: SearchRequestContext,
  ): Promise<readonly DocumentSearchHit[]> {
    context.signal.throwIfAborted();
    const resolved = await this.#resolveTarget(target, context);
    let hits: readonly VectorIndexSearchHit[];
    try {
      hits = await resolved.vectorIndex.search({
        accessHandle: resolved.publication.binding.accessHandle,
        scope: resolved.vectorScope,
        queryVector: resolved.queryVector,
        limit: resolved.target.limit,
        signal: context.signal,
      });
    } catch (error) {
      throw mapVectorSearchError(error);
    }
    if (
      hits.length > resolved.target.limit ||
      new Set(hits.map((hit) => hit.recordId)).size !== hits.length ||
      hits.some((hit) => !Number.isFinite(hit.score))
    ) {
      throw new ManagedDocumentSearchError("search_result_invalid");
    }
    const ranked = [...hits].sort(
      (left, right) =>
        right.score - left.score ||
        compareText(
          left.metadata.chunkRevisionId,
          right.metadata.chunkRevisionId,
        ),
    );
    return ranked.map((hit, index) =>
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
    const scopeRef = parseTarget(target);
    const entry = await this.#catalogScope(scopeRef, context);
    if (entry === undefined) {
      throw new ManagedDocumentSearchError("scope_not_published");
    }
    const { publication, scope } = entry;
    if (
      publication.binding.securityDomain !== context.securityDomain ||
      publication.manifest.securityDomain !== context.securityDomain
    ) {
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
      securityDomain: context.securityDomain,
      embeddingProfile: publication.manifest.embeddingProfile,
    });
    if (provider === undefined) {
      throw new ManagedDocumentSearchError(
        "embedding_provider_not_allowed",
      );
    }
    const vectorIndex = this.#dependencies.vectorIndexes.resolve(
      publication.binding.connectorId,
    );
    if (vectorIndex === undefined) {
      throw new ManagedDocumentSearchError("index_binding_unavailable");
    }

    const compatibility: VectorIndexCompatibility = {
      stateNamespaceId: publication.binding.stateNamespaceId,
      securityDomain: context.securityDomain,
      embeddingProfile: publication.manifest.embeddingProfile,
      payloadSchemaVersion: 2,
    };
    const [rehydrated, queryVector] = await Promise.all([
      this.#rehydrateBinding(
        vectorIndex,
        publication.binding.connectorId,
        publication.binding.accessHandle,
        compatibility,
        context,
      ),
      this.#queryEmbedding(
        provider,
        context.securityDomain,
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

  async #catalogScope(
    scopeRef: PublishedScopeRef,
    context: SearchRequestContext,
  ): Promise<PublishedScopeCatalogEntry | undefined> {
    const key = `${scopeRef.scopeId}\u0000${scopeRef.scopeVersion}`;
    let pending = context.catalog.get(key);
    if (pending === undefined) {
      pending = isV2PublicationStore(this.#dependencies.publications)
        ? this.#dependencies.publications.findScope(scopeRef)
        : this.#legacyCatalogScope(scopeRef, context);
      context.catalog.set(key, pending);
    }
    try {
      return await pending;
    } catch (error) {
      throw mapCatalogError(error);
    }
  }

  async #legacyCatalogScope(
    scopeRef: PublishedScopeRef,
    context: SearchRequestContext,
  ): Promise<PublishedScopeCatalogEntry | undefined> {
    const scope = context.legacyScopes.get(scopeKey(scopeRef));
    if (scope === undefined) return undefined;
    const publication = await this.#dependencies.publications.findVersion({
      documentIndexId: scope.documentIndex.documentIndexId,
      indexVersion: scope.documentIndex.indexVersion,
    });
    if (publication === undefined || "binding" in publication) return undefined;
    return normalizeLegacyCatalogEntry(publication, scope);
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
          context.signal.throwIfAborted();
          await vectorIndex.rehydrate({
            accessHandle,
            compatibility,
            signal: context.signal,
          });
          context.signal.throwIfAborted();
          return vectorIndex;
        } catch (error) {
          if (context.signal.aborted) {
            throw new ManagedDocumentSearchError("cancelled");
          }
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
      if (error.code === "embedding_artifact_unavailable") {
        throw new ManagedDocumentSearchError(
          "embedding_artifact_unavailable",
        );
      }
      if (error.code === "input_limit_exceeded") {
        throw new ManagedDocumentSearchError("query_input_limit_exceeded");
      }
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
    !embeddingVectorMatchesProfile(profile, output.vector)
  ) {
    throw new ManagedDocumentSearchError("query_embedding_invalid");
  }
  return output.vector;
}

function validateBatchCommand(command: BatchManagedDocumentSearchCommand): void {
  if (
    command.queryText.trim() === "" ||
    command.securityDomain.trim() === "" ||
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
  signal: AbortSignal,
  task: (value: T) => Promise<R>,
  cancelled: (value: T) => R,
): Promise<readonly R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (next < values.length) {
        const index = next;
        next += 1;
        const value = values[index]!;
        results[index] = signal.aborted
          ? cancelled(value)
          : await task(value);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function cancelledItem(targetKey: string): BatchManagedDocumentSearchItem {
  return {
    targetKey,
    status: "failed",
    failure: { code: "cancelled", retriable: false },
  };
}

function parseTarget(
  target: BatchManagedDocumentSearchTarget,
): PublishedScopeRef {
  const parsedScope = PublishedScopeRefSchema.safeParse(target.scopeRef);
  if (
    !parsedScope.success ||
    !Number.isSafeInteger(target.limit) ||
    target.limit <= 0 ||
    target.limit > MAX_VECTOR_SEARCH_LIMIT
  ) {
    throw new ManagedDocumentSearchError("invalid_request");
  }
  return parsedScope.data;
}

function scopeKey(scopeRef: PublishedScopeRef): string {
  return `${scopeRef.scopeId}\u0000${scopeRef.scopeVersion}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isV2PublicationStore(
  store: IndexPublicationStore | LegacyIndexPublicationStore,
): store is IndexPublicationStore {
  return "findScope" in store && typeof store.findScope === "function";
}

function normalizeLegacyCatalogEntry(
  publication: LegacyPublishedIndexVersion,
  requestedScope: LegacyPublishedDocumentScope,
): PublishedScopeCatalogEntry | undefined {
  const documentIndex = {
    documentIndexId: publication.documentIndex.documentIndexId,
    sourceId: publication.documentIndex.sourceId,
    documentId: publication.documentIndex.documentId,
    indexVersion: publication.documentIndex.indexVersion,
  };
  const scopes: PublishedDocumentScope[] = publication.scopes.map((scope) => ({
    scopeId: scope.scopeId,
    scopeVersion: scope.scopeVersion,
    kind: "managed_document",
    documentIndex: {
      documentIndexId: scope.documentIndex.documentIndexId,
      sourceId: scope.documentIndex.sourceId,
      documentId: scope.documentIndex.documentId,
      indexVersion: scope.documentIndex.indexVersion,
    },
    selector: structuredClone(scope.selector),
  }));
  const scope = scopes.find(
    (candidate) =>
      candidate.scopeId === requestedScope.scopeId &&
      candidate.scopeVersion === requestedScope.scopeVersion,
  );
  if (scope === undefined) return undefined;
  return {
    publication: {
      manifest: {
        ...publication.manifest,
        stateNamespaceId: "legacy-v1",
        securityDomain: publication.securityDomain,
      },
      documentIndex,
      scopes,
      binding: {
        stateNamespaceId: "legacy-v1",
        securityDomain: publication.securityDomain,
        documentIndexId: publication.documentIndex.documentIndexId,
        indexVersion: publication.documentIndex.indexVersion,
        connectorId: publication.documentIndex.connectorId,
        accessHandle: publication.documentIndex.accessHandle,
      },
    },
    scope,
  };
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
    if (error.code === "invalid_result") {
      return new ManagedDocumentSearchError("search_result_invalid");
    }
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
    if (error.code === "invalid_result") {
      return new ManagedDocumentSearchError("search_result_invalid");
    }
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
    readonly stateNamespaceId: string;
    readonly securityDomain: string;
    readonly sourceId: string;
    readonly observationId: string;
    readonly documentId: string;
    readonly documentIndexId: string;
    readonly indexVersion: string;
    readonly semanticUnitRevisions: Readonly<Record<string, string>>;
    readonly chunkRevisions: Readonly<Record<string, string>>;
    readonly chunkBindings: Readonly<
      Record<
        string,
        {
          readonly chunkRevisionId: string;
          readonly semanticUnitId: string;
          readonly semanticUnitRevisionId: string;
          readonly contentDigest: string;
        }
      >
    >;
  },
  scope: VectorIndexScope,
): DocumentSearchHit {
  const metadata = hit.metadata;
  const binding = manifest.chunkBindings[metadata.chunkId];
  if (
    metadata.payloadSchemaVersion !== 2 ||
    metadata.stateNamespaceId !== manifest.stateNamespaceId ||
    metadata.securityDomain !== manifest.securityDomain ||
    metadata.sourceId !== manifest.sourceId ||
    metadata.observationId !== manifest.observationId ||
    metadata.documentId !== manifest.documentId ||
    metadata.documentIndexId !== manifest.documentIndexId ||
    metadata.indexVersion !== manifest.indexVersion ||
    hit.recordId !==
      createVectorRecordId(
        metadata.stateNamespaceId,
        metadata.documentIndexId,
        metadata.indexVersion,
        metadata.chunkRevisionId,
      ) ||
    !Number.isFinite(hit.score) ||
    manifest.semanticUnitRevisions[metadata.semanticUnitId] === undefined ||
    manifest.chunkRevisions[metadata.chunkId] !== metadata.chunkRevisionId ||
    binding === undefined ||
    binding.chunkRevisionId !== metadata.chunkRevisionId ||
    binding.semanticUnitId !== metadata.semanticUnitId ||
    binding.semanticUnitRevisionId !==
      manifest.semanticUnitRevisions[metadata.semanticUnitId] ||
    binding.contentDigest !== metadata.contentDigest ||
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
