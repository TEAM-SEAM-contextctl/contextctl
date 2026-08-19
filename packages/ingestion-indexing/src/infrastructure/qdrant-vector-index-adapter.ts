import { createHash } from "node:crypto";

import { QdrantClient } from "@qdrant/js-client-rest";

import type { EmbeddingProfile } from "../domain/embedding-profile.js";
import { assertValidEmbeddingProfile } from "../domain/embedding-profile.js";
import { canonicalJson } from "../domain/revision-identity.js";
import type {
  VectorIndexRecord,
  VectorIndexRecordMetadata,
} from "../domain/index-manifest.js";
import {
  createVectorRecordId,
  assertValidLeaseId,
  assertValidRetentionLease,
  assertValidVectorDeletion,
  assertValidVectorIndexScope,
  assertValidVectorRecordMetadata,
  assertValidVectorRecordBatch,
  assertValidVectorVectorRead,
  assertValidVectorVersion,
} from "../domain/vector-index.js";
import {
  MAX_VECTOR_SEARCH_LIMIT,
  MAX_VECTOR_VECTOR_READ,
  VectorIndexFault,
  type PreparedVectorIndex,
  type VectorIndexCompatibilityInput as VectorIndexCompatibility,
  type VectorIndexPort,
  type VectorIndexRetentionLease,
  type VectorIndexScope,
  type VectorIndexSearchHit,
  type VectorIndexStoredRecord,
  type VectorIndexStoredVector,
} from "../ports/vector-index.js";

const REQUIRED_PAYLOAD_INDEXES = {
  recordKind: "keyword",
  stateNamespaceId: "keyword",
  securityDomain: "keyword",
  sourceId: "keyword",
  observationId: "keyword",
  documentId: "keyword",
  documentIndexId: "keyword",
  indexVersion: "keyword",
  semanticUnitId: "keyword",
  chunkId: "keyword",
  chunkRevisionId: "keyword",
  contentDigest: "keyword",
  leaseId: "keyword",
  expiresAt: "datetime",
  payloadSchemaVersion: "integer",
} as const;
const LEGACY_OPERATION_SIGNAL = new AbortController().signal;

interface QdrantClientApi {
  collectionExists(name: string, signal?: AbortSignal): Promise<{ exists: boolean }>;
  createCollection(name: string, request: object, signal?: AbortSignal): Promise<boolean>;
  getCollection(name: string, signal?: AbortSignal): Promise<unknown>;
  createPayloadIndex(name: string, request: object, signal?: AbortSignal): Promise<unknown>;
  upsert(name: string, request: object, signal?: AbortSignal): Promise<unknown>;
  query(name: string, request: object, signal?: AbortSignal): Promise<unknown>;
  scroll(name: string, request: object, signal?: AbortSignal): Promise<unknown>;
  count(name: string, request: object, signal?: AbortSignal): Promise<unknown>;
  delete(name: string, request: object, signal?: AbortSignal): Promise<unknown>;
}

export interface QdrantVectorIndexAdapterOptions {
  readonly url: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly client?: QdrantClientApi;
}

export class QdrantVectorIndexAdapter implements VectorIndexPort {
  readonly #collectionExists: (
    name: string,
    signal: AbortSignal,
  ) => Promise<{ exists: boolean }>;
  readonly #getCollection: (
    name: string,
    signal: AbortSignal,
  ) => Promise<unknown>;
  readonly #query: (
    name: string,
    request: object,
    signal: AbortSignal,
  ) => Promise<unknown>;
  readonly #createCollection: QdrantOperation;
  readonly #createPayloadIndex: QdrantOperation;
  readonly #upsert: QdrantOperation;
  readonly #scroll: QdrantOperation;
  readonly #count: QdrantOperation;
  readonly #delete: QdrantOperation;
  readonly #profiles = new Map<string, EmbeddingProfile>();
  readonly #versionOperations = new Map<string, Promise<void>>();

  constructor(options: QdrantVectorIndexAdapterOptions) {
    assertSafeEndpoint(options.url);
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("Qdrant timeout must be a positive integer");
    }
    if (options.client !== undefined) {
      this.#collectionExists = (name, signal) => {
        signal.throwIfAborted();
        return options.client!.collectionExists(name, signal);
      };
      this.#getCollection = (name, signal) => {
        signal.throwIfAborted();
        return options.client!.getCollection(name, signal);
      };
      this.#query = (name, request, signal) =>
        options.client!.query(name, request, signal);
      this.#createCollection = (name, request, signal) =>
        options.client!.createCollection(name, request, signal);
      this.#createPayloadIndex = (name, request, signal) =>
        options.client!.createPayloadIndex(name, request, signal);
      this.#upsert = (name, request, signal) =>
        options.client!.upsert(name, request, signal);
      this.#scroll = (name, request, signal) =>
        options.client!.scroll(name, request, signal);
      this.#count = (name, request, signal) =>
        options.client!.count(name, request, signal);
      this.#delete = (name, request, signal) =>
        options.client!.delete(name, request, signal);
    } else {
      const client = new QdrantClient({
        url: options.url,
        ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        // The SDK timeout middleware replaces, rather than composes, a caller
        // signal. Disable it and compose the deadline here so cancellation
        // reaches the underlying fetch request.
        timeout: Number.POSITIVE_INFINITY,
        checkCompatibility: false,
      });
      this.#collectionExists = (name, signal) =>
        rawQdrantResult(client.api().collectionExists as unknown as RawQdrantCall, {
          collection_name: name,
        }, requestSignal(signal, timeoutMs)) as Promise<{ exists: boolean }>;
      this.#getCollection = (name, signal) =>
        rawQdrantResult(client.api().getCollection as unknown as RawQdrantCall, {
          collection_name: name,
        }, requestSignal(signal, timeoutMs));
      this.#query = (name, request, signal) =>
        rawQdrantResult(client.api().queryPoints as unknown as RawQdrantCall, {
          collection_name: name,
          ...request,
        }, requestSignal(signal, timeoutMs));
      this.#createCollection = rawOperation(
        client.api().createCollection as unknown as RawQdrantCall,
        "collection_name",
        timeoutMs,
      );
      this.#createPayloadIndex = rawOperation(
        client.api().createFieldIndex as unknown as RawQdrantCall,
        "collection_name",
        timeoutMs,
      );
      this.#upsert = rawOperation(
        client.api().upsertPoints as unknown as RawQdrantCall,
        "collection_name",
        timeoutMs,
      );
      this.#scroll = rawOperation(
        client.api().scrollPoints as unknown as RawQdrantCall,
        "collection_name",
        timeoutMs,
      );
      this.#count = rawOperation(
        client.api().countPoints as unknown as RawQdrantCall,
        "collection_name",
        timeoutMs,
      );
      this.#delete = rawOperation(
        client.api().deletePoints as unknown as RawQdrantCall,
        "collection_name",
        timeoutMs,
      );
    }
  }

  async prepare(input: VectorIndexCompatibility | {
    readonly compatibility: VectorIndexCompatibility;
    readonly signal: AbortSignal;
  }): Promise<PreparedVectorIndex> {
    const compatibility = "compatibility" in input ? input.compatibility : input;
    const signal = "compatibility" in input ? input.signal : LEGACY_OPERATION_SIGNAL;
    signal.throwIfAborted();
    assertInput(() => assertCompatibility(compatibility));
    const collection = collectionName(compatibility);
    const handle = `qdrant:v1:${compatibilityDigest(compatibility).slice(0, 32)}`;
    try {
      const existence = await this.#collectionExists(collection, signal);
      signal.throwIfAborted();
      if (!existence.exists) {
        await this.#createCollection(collection, {
          vectors: {
            size: compatibility.embeddingProfile.dimensions,
            distance: qdrantDistance(compatibility.embeddingProfile.distance),
          },
          metadata: {
            contextctlCompatibility: compatibilityDigest(compatibility),
          },
        }, signal);
      } else {
        assertCollectionCompatibility(
          await this.#getCollection(collection, signal),
          compatibility,
        );
      }
      for (const [fieldName, fieldSchema] of Object.entries(REQUIRED_PAYLOAD_INDEXES)) {
        signal.throwIfAborted();
        await ensurePayloadIndex(
          this.#getCollection,
          this.#createPayloadIndex,
          collection,
          fieldName,
          fieldSchema,
          signal,
        );
      }
      signal.throwIfAborted();
      const info = await this.#getCollection(collection, signal);
      assertRequiredPayloadIndexes(info);
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      throw translateQdrantFault(error);
    }
    this.#profiles.set(handle, structuredClone(compatibility.embeddingProfile));
    return { accessHandle: handle, capabilities: { metadataPreFilter: true } };
  }

  async rehydrate(input: {
    readonly accessHandle: string;
    readonly compatibility: VectorIndexCompatibility;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly capabilities: { readonly metadataPreFilter: true } }> {
    const signal = operationSignal(input.signal);
    assertInput(() => assertCompatibility(input.compatibility));
    const expectedHandle = `qdrant:v1:${compatibilityDigest(input.compatibility).slice(0, 32)}`;
    if (input.accessHandle !== expectedHandle) {
      throw new VectorIndexFault("invalid_request", false);
    }
    const collection = parseAccessHandle(input.accessHandle);
    try {
      signal.throwIfAborted();
      const existence = await this.#collectionExists(collection, signal);
      if (!existence.exists) {
        throw new VectorIndexFault("index_unavailable", false);
      }
      const info = await this.#getCollection(collection, signal);
      signal.throwIfAborted();
      assertCollectionCompatibility(info, input.compatibility);
      assertRequiredPayloadIndexes(info);
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      throw translateQdrantFault(error);
    }
    this.#profiles.set(
      input.accessHandle,
      structuredClone(input.compatibility.embeddingProfile),
    );
    return { capabilities: { metadataPreFilter: true } };
  }

  async upsertRecords(input: {
    readonly accessHandle: string;
    readonly embeddingProfile: EmbeddingProfile;
    readonly records: readonly VectorIndexRecord[];
    readonly signal?: AbortSignal;
  }): Promise<void> {
    const signal = operationSignal(input.signal);
    signal.throwIfAborted();
    const collection = parseAccessHandle(input.accessHandle);
    assertInput(() => {
      assertValidVectorRecordBatch(input.embeddingProfile, input.records);
      assertKnownProfile(this.#profiles, input.accessHandle, input.embeddingProfile);
    });
    try {
      await this.#upsert(collection, {
        wait: true,
        ordering: "strong",
        points: input.records.map((record) => ({
          id: qdrantPointId(record.recordId),
          vector: [...record.embedding],
          payload: {
            recordKind: "chunk",
            recordId: record.recordId,
            retrievalText: record.retrievalText,
            ...record.metadata,
          },
        })),
      }, signal);
      signal.throwIfAborted();
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      throw translateQdrantFault(error);
    }
  }

  async search(input: {
    readonly accessHandle: string;
    readonly scope: VectorIndexScope;
    readonly queryVector: readonly number[];
    readonly limit: number;
    readonly signal?: AbortSignal;
  }): Promise<readonly VectorIndexSearchHit[]> {
    const signal = operationSignal(input.signal);
    signal.throwIfAborted();
    const collection = parseAccessHandle(input.accessHandle);
    const profile = this.#profiles.get(input.accessHandle);
    assertInput(() => assertValidVectorIndexScope(input.scope));
    if (profile === undefined) {
      throw new VectorIndexFault("index_unavailable", false);
    }
    if (
      input.queryVector.length !== profile.dimensions ||
      input.queryVector.some((component) => !Number.isFinite(component)) ||
      !Number.isSafeInteger(input.limit) ||
      input.limit <= 0 ||
      input.limit > MAX_VECTOR_SEARCH_LIMIT ||
      input.scope.semanticUnitIds?.length === 0
    ) {
      throw new VectorIndexFault("invalid_request", false);
    }
    try {
      const result = await this.#query(collection, {
        query: [...input.queryVector],
        filter: scopeFilter(input.scope),
        limit: input.limit,
        with_payload: true,
        with_vector: false,
      }, signal);
      signal.throwIfAborted();
      return parseSearchHits(result, input.scope);
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      throw translateQdrantFault(error);
    }
  }

  async listVersionRecords(input: {
    readonly accessHandle: string;
    readonly documentIndexId: string;
    readonly indexVersion: string;
    readonly signal?: AbortSignal;
  }): Promise<readonly VectorIndexStoredRecord[]> {
    const signal = operationSignal(input.signal);
    signal.throwIfAborted();
    const collection = parseAccessHandle(input.accessHandle);
    assertInput(() => assertValidVectorVersion(input));
    if (!this.#profiles.has(input.accessHandle)) {
      throw new VectorIndexFault("index_unavailable", false);
    }
    const records: VectorIndexStoredRecord[] = [];
    let offset: unknown;
    const seenOffsets = new Set<string>();
    try {
      do {
        signal.throwIfAborted();
        const result = await this.#scroll(collection, {
          filter: {
            must: [
              keyword("recordKind", "chunk"),
              ...versionMust(input.documentIndexId, input.indexVersion),
            ],
          },
          limit: 256,
          ...(offset === undefined ? {} : { offset }),
          with_payload: true,
          with_vector: false,
        }, signal);
        const page = parseScrollPage(result, input);
        records.push(...page.records);
        offset = page.nextOffset;
        if (offset !== undefined) {
          const key = JSON.stringify(offset);
          if (seenOffsets.has(key)) {
            throw new VectorIndexFault("storage_unavailable", false);
          }
          seenOffsets.add(key);
        }
      } while (offset !== undefined);
      return records.sort((left, right) =>
        left.recordId.localeCompare(right.recordId),
      );
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      throw translateQdrantFault(error);
    }
  }

  async readVersionVectors(input: {
    readonly accessHandle: string;
    readonly documentIndexId: string;
    readonly indexVersion: string;
    readonly chunkRevisionIds: readonly string[];
    readonly signal?: AbortSignal;
  }): Promise<readonly VectorIndexStoredVector[]> {
    const signal = operationSignal(input.signal);
    signal.throwIfAborted();
    const collection = parseAccessHandle(input.accessHandle);
    assertInput(() =>
      assertValidVectorVectorRead(input, MAX_VECTOR_VECTOR_READ),
    );
    const profile = this.#profiles.get(input.accessHandle);
    if (profile === undefined) {
      throw new VectorIndexFault("index_unavailable", false);
    }
    try {
      const result = await this.#query(collection, {
        filter: {
          must: [
            keyword("recordKind", "chunk"),
            ...versionMust(input.documentIndexId, input.indexVersion),
            {
              key: "chunkRevisionId",
              match: { any: [...input.chunkRevisionIds] },
            },
          ],
        },
        limit: input.chunkRevisionIds.length,
        with_payload: true,
        with_vector: true,
      }, signal);
      signal.throwIfAborted();
      return parseStoredVectors(result, input, profile.dimensions);
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      throw translateQdrantFault(error);
    }
  }

  async retainVersion(input: {
    readonly accessHandle: string;
    readonly lease: VectorIndexRetentionLease;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    const signal = operationSignal(input.signal);
    signal.throwIfAborted();
    assertInput(() => assertValidRetentionLease(input.lease));
    const collection = parseAccessHandle(input.accessHandle);
    const profile = this.#profiles.get(input.accessHandle);
    if (profile === undefined) {
      throw new VectorIndexFault("index_unavailable", false);
    }
    await this.#serializeVersion(input.accessHandle, input.lease, async () => {
      try {
        signal.throwIfAborted();
        await this.#upsert(collection, {
          wait: true,
          ordering: "strong",
          points: [
            {
              id: qdrantPointId(`lease:${input.lease.leaseId}`),
              vector: Array.from({ length: profile.dimensions }, () => 0),
              payload: { recordKind: "retention_lease", ...input.lease },
            },
          ],
        }, signal);
      } catch (error) {
        if (signal.aborted) signal.throwIfAborted();
        throw translateQdrantFault(error);
      }
    });
  }

  async releaseRetentionLease(input: {
    readonly accessHandle: string;
    readonly leaseId: string;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    const signal = operationSignal(input.signal);
    signal.throwIfAborted();
    const collection = parseAccessHandle(input.accessHandle);
    assertInput(() => assertValidLeaseId(input.leaseId));
    try {
      await this.#delete(collection, {
        wait: true,
        ordering: "strong",
        points: [qdrantPointId(`lease:${input.leaseId}`)],
      }, signal);
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      throw translateQdrantFault(error);
    }
  }

  async deleteVersion(input: {
    readonly accessHandle: string;
    readonly documentIndexId: string;
    readonly indexVersion: string;
    readonly now: string;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    const signal = operationSignal(input.signal);
    signal.throwIfAborted();
    const collection = parseAccessHandle(input.accessHandle);
    assertInput(() => assertValidVectorDeletion(input));
    const identity = versionMust(input.documentIndexId, input.indexVersion);
    await this.#serializeVersion(input.accessHandle, input, async () => {
      try {
        signal.throwIfAborted();
        const leases = await this.#count(collection, {
          exact: true,
          filter: {
            must: [
              keyword("recordKind", "retention_lease"),
              ...identity,
              { key: "expiresAt", range: { gt: input.now } },
            ],
          },
        }, signal);
        if (countValue(leases) > 0) {
          throw new VectorIndexFault("index_version_retained", false);
        }
        signal.throwIfAborted();
        await this.#delete(collection, {
          wait: true,
          ordering: "strong",
          filter: { must: identity },
        }, signal);
      } catch (error) {
        if (signal.aborted) signal.throwIfAborted();
        if (error instanceof VectorIndexFault) throw error;
        throw translateQdrantFault(error);
      }
    });
  }

  async #serializeVersion<T>(
    accessHandle: string,
    version: { readonly documentIndexId: string; readonly indexVersion: string },
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = `${accessHandle}\u0000${version.documentIndexId}\u0000${version.indexVersion}`;
    const previous = this.#versionOperations.get(key) ?? Promise.resolve();
    let unlock = (): void => undefined;
    const current = new Promise<void>((resolve) => { unlock = resolve; });
    const tail = previous.then(() => current);
    this.#versionOperations.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      unlock();
      if (this.#versionOperations.get(key) === tail) this.#versionOperations.delete(key);
    }
  }
}

type RawQdrantCall = (
  input: Record<string, unknown>,
  init?: RequestInit,
) => Promise<unknown>;

type QdrantOperation = (
  name: string,
  request: object,
  signal: AbortSignal,
) => Promise<unknown>;

function rawOperation(
  call: RawQdrantCall,
  nameKey: string,
  timeoutMs: number,
): QdrantOperation {
  return (name, request, signal) =>
    rawQdrantResult(
      call,
      { [nameKey]: name, ...request },
      requestSignal(signal, timeoutMs),
    );
}

function requestSignal(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

async function rawQdrantResult(
  call: RawQdrantCall,
  input: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  const response = await call(input, { signal });
  if (!isRecord(response) || !isRecord(response.data) || !("result" in response.data)) {
    throw new VectorIndexFault("storage_unavailable", false);
  }
  return response.data.result;
}

function operationSignal(signal: AbortSignal | undefined): AbortSignal {
  return signal ?? LEGACY_OPERATION_SIGNAL;
}

function collectionName(compatibility: VectorIndexCompatibility): string {
  return `contextctl_${compatibilityDigest(compatibility).slice(0, 32)}`;
}

function compatibilityDigest(compatibility: VectorIndexCompatibility): string {
  return createHash("sha256")
    .update(canonicalJson({
      stateNamespaceId: compatibility.stateNamespaceId,
      securityDomain: compatibility.securityDomain,
      embeddingProfile: compatibility.embeddingProfile,
      payloadSchemaVersion: compatibility.payloadSchemaVersion,
    }))
    .digest("hex");
}

function parseAccessHandle(accessHandle: string): string {
  const match = /^qdrant:v1:([a-f0-9]{32})$/.exec(accessHandle);
  if (match?.[1] === undefined) {
    throw new VectorIndexFault("invalid_request", false);
  }
  return `contextctl_${match[1]}`;
}

function assertSafeEndpoint(value: string): void {
  const endpoint = new URL(value);
  const local = endpoint.hostname === "127.0.0.1" || endpoint.hostname === "localhost";
  if (
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    (endpoint.protocol !== "https:" && !(local && endpoint.protocol === "http:"))
  ) {
    throw new TypeError("Qdrant endpoint must use HTTPS or local loopback HTTP without userinfo");
  }
}

function qdrantDistance(distance: EmbeddingProfile["distance"]): string {
  return distance === "cosine" ? "Cosine" : distance === "dot" ? "Dot" : "Euclid";
}

async function ensurePayloadIndex(
  getCollection: (name: string, signal: AbortSignal) => Promise<unknown>,
  createPayloadIndex: QdrantOperation,
  collection: string,
  field_name: string,
  field_schema: "keyword" | "integer" | "datetime",
  signal: AbortSignal,
): Promise<void> {
  const info = await getCollection(collection, signal);
  if (payloadIndexTypes(info).get(field_name) === undefined) {
    await createPayloadIndex(collection, {
      field_name,
      field_schema,
      wait: true,
      ordering: "strong",
    }, signal);
  }
}

function payloadIndexTypes(info: unknown): ReadonlyMap<string, string> {
  if (!isRecord(info) || !isRecord(info.payload_schema)) return new Map();
  return new Map(Object.entries(info.payload_schema).flatMap(([field, schema]) =>
    isRecord(schema) && typeof schema.data_type === "string"
      ? [[field, schema.data_type] as const]
      : [],
  ));
}

function assertRequiredPayloadIndexes(info: unknown): void {
  const types = payloadIndexTypes(info);
  if (!Object.entries(REQUIRED_PAYLOAD_INDEXES).every(
    ([field, type]) => types.get(field) === type,
  )) {
    throw new VectorIndexFault("filter_not_supported", false);
  }
}

function assertCollectionCompatibility(
  info: unknown,
  compatibility: VectorIndexCompatibility,
): void {
  if (!isRecord(info)) throw new VectorIndexFault("index_unavailable", false);
  const config = info.config;
  const params = isRecord(config) ? config.params : undefined;
  const vectors = isRecord(params) ? params.vectors : undefined;
  const metadata = isRecord(config) ? config.metadata : undefined;
  if (!isRecord(vectors)) throw new VectorIndexFault("index_unavailable", false);
  if (
    vectors.size !== compatibility.embeddingProfile.dimensions ||
    vectors.distance !== qdrantDistance(compatibility.embeddingProfile.distance) ||
    !isRecord(metadata) ||
    metadata.contextctlCompatibility !== compatibilityDigest(compatibility)
  ) {
    throw new VectorIndexFault("invalid_request", false);
  }
}

function assertKnownProfile(
  profiles: ReadonlyMap<string, EmbeddingProfile>,
  accessHandle: string,
  profile: EmbeddingProfile,
): void {
  const known = profiles.get(accessHandle);
  if (known === undefined) {
    throw new VectorIndexFault("index_unavailable", false);
  }
  if (canonicalJson(known) !== canonicalJson(profile)) {
    throw new VectorIndexFault("invalid_request", false);
  }
}

function scopeFilter(scope: VectorIndexScope): object {
  return {
    must: [
      keyword("recordKind", "chunk"),
      ...versionMust(scope.documentIndexId, scope.indexVersion),
      keyword("documentId", scope.documentId),
      ...(scope.semanticUnitIds === undefined
        ? []
        : [{ key: "semanticUnitId", match: { any: [...scope.semanticUnitIds] } }]),
    ],
  };
}

function versionMust(documentIndexId: string, indexVersion: string): object[] {
  return [
    keyword("documentIndexId", documentIndexId),
    keyword("indexVersion", indexVersion),
  ];
}

function keyword(key: string, value: string): object {
  return { key, match: { value } };
}

function parseSearchHits(result: unknown, scope: VectorIndexScope): VectorIndexSearchHit[] {
  if (!isRecord(result) || !Array.isArray(result.points)) {
    throw new VectorIndexFault("invalid_result", false);
  }
  return result.points.map((point) => {
    try {
      if (
        !isRecord(point) ||
        !isRecord(point.payload) ||
        typeof point.score !== "number" ||
        !Number.isFinite(point.score)
      ) {
        throw new VectorIndexFault("invalid_result", false);
      }
      const payload = point.payload;
      const metadata = parseMetadata(payload);
      const retrievalText = requiredString(payload.retrievalText);
      if (
        payload.recordKind !== "chunk" ||
        metadata.documentIndexId !== scope.documentIndexId ||
        metadata.indexVersion !== scope.indexVersion ||
        metadata.documentId !== scope.documentId ||
        (scope.semanticUnitIds !== undefined && !scope.semanticUnitIds.includes(metadata.semanticUnitId))
      ) {
        throw new VectorIndexFault("invalid_result", false);
      }
      const recordId = requiredString(payload.recordId);
      if (
        recordId !== createVectorRecordId(
          metadata.stateNamespaceId,
          metadata.documentIndexId,
          metadata.indexVersion,
          metadata.chunkRevisionId,
        )
      ) {
        throw new VectorIndexFault("invalid_result", false);
      }
      return {
        recordId,
        score: point.score,
        retrievalText,
        metadata,
      };
    } catch {
      throw new VectorIndexFault("invalid_result", false);
    }
  });
}

function parseScrollPage(
  result: unknown,
  version: { readonly documentIndexId: string; readonly indexVersion: string },
): {
  readonly records: readonly VectorIndexStoredRecord[];
  readonly nextOffset: unknown;
} {
  if (!isRecord(result) || !Array.isArray(result.points)) {
    throw new VectorIndexFault("storage_unavailable", false);
  }
  const records = result.points.map((point) => {
    if (!isRecord(point) || !isRecord(point.payload)) {
      throw new VectorIndexFault("storage_unavailable", false);
    }
    const payload = point.payload;
    const metadata = parseMetadata(payload);
    const recordId = requiredString(payload.recordId);
    const retrievalText = requiredString(payload.retrievalText);
    if (
      payload.recordKind !== "chunk" ||
      metadata.documentIndexId !== version.documentIndexId ||
      metadata.indexVersion !== version.indexVersion ||
      recordId !==
        createVectorRecordId(
          metadata.stateNamespaceId,
          metadata.documentIndexId,
          metadata.indexVersion,
          metadata.chunkRevisionId,
        )
    ) {
      throw new VectorIndexFault("storage_unavailable", false);
    }
    return { recordId, retrievalText, metadata };
  });
  const nextOffset = result.next_page_offset;
  return {
    records,
    nextOffset: nextOffset === null ? undefined : nextOffset,
  };
}

function parseStoredVectors(
  result: unknown,
  version: {
    readonly documentIndexId: string;
    readonly indexVersion: string;
    readonly chunkRevisionIds: readonly string[];
  },
  dimensions: number,
): readonly VectorIndexStoredVector[] {
  if (!isRecord(result) || !Array.isArray(result.points)) {
    throw new VectorIndexFault("storage_unavailable", false);
  }
  const requested = new Set(version.chunkRevisionIds);
  const seen = new Set<string>();
  const vectors = result.points.map((point) => {
    if (!isRecord(point) || !isRecord(point.payload)) {
      throw new VectorIndexFault("storage_unavailable", false);
    }
    const metadata = parseMetadata(point.payload);
    const recordId = requiredString(point.payload.recordId);
    const embedding = point.vector;
    if (
      point.payload.recordKind !== "chunk" ||
      metadata.documentIndexId !== version.documentIndexId ||
      metadata.indexVersion !== version.indexVersion ||
      !requested.has(metadata.chunkRevisionId) ||
      seen.has(metadata.chunkRevisionId) ||
      recordId !==
        createVectorRecordId(
          metadata.stateNamespaceId,
          metadata.documentIndexId,
          metadata.indexVersion,
          metadata.chunkRevisionId,
        ) ||
      !Array.isArray(embedding) ||
      embedding.length !== dimensions ||
      embedding.some((component) => typeof component !== "number" || !Number.isFinite(component))
    ) {
      throw new VectorIndexFault("storage_unavailable", false);
    }
    seen.add(metadata.chunkRevisionId);
    return {
      recordId,
      chunkRevisionId: metadata.chunkRevisionId,
      contentDigest: metadata.contentDigest,
      embedding: embedding as readonly number[],
    };
  });
  return vectors.sort((left, right) =>
    left.recordId.localeCompare(right.recordId),
  );
}

function parseMetadata(payload: Record<string, unknown>): VectorIndexRecordMetadata {
  if (payload.payloadSchemaVersion !== 2) {
    throw new VectorIndexFault("storage_unavailable", false);
  }
  const metadata: VectorIndexRecordMetadata = {
    payloadSchemaVersion: 2,
    stateNamespaceId: requiredString(payload.stateNamespaceId),
    securityDomain: requiredString(payload.securityDomain),
    sourceId: requiredString(payload.sourceId),
    observationId: requiredString(payload.observationId),
    documentId: requiredString(payload.documentId),
    documentIndexId: requiredString(payload.documentIndexId),
    indexVersion: requiredString(payload.indexVersion),
    semanticUnitId: requiredString(payload.semanticUnitId),
    chunkId: requiredString(payload.chunkId),
    chunkRevisionId: requiredString(payload.chunkRevisionId),
    contentDigest: requiredString(payload.contentDigest),
  };
  try {
    assertValidVectorRecordMetadata(metadata);
  } catch {
    throw new VectorIndexFault("storage_unavailable", false);
  }
  return metadata;
}

function countValue(result: unknown): number {
  if (!isRecord(result) || !Number.isSafeInteger(result.count) || (result.count as number) < 0) {
    throw new VectorIndexFault("storage_unavailable", false);
  }
  return result.count as number;
}

function qdrantPointId(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function translateQdrantFault(error: unknown): VectorIndexFault {
  if (error instanceof VectorIndexFault) return error;
  const status = isRecord(error) && typeof error.status === "number" ? error.status : undefined;
  if (status === 401 || status === 403) return new VectorIndexFault("access_denied", false);
  if (status === 404) return new VectorIndexFault("index_unavailable", false);
  if (status === 400 || status === 409 || status === 422) {
    return new VectorIndexFault("invalid_request", false);
  }
  return new VectorIndexFault("storage_unavailable", true);
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value === "") {
    throw new VectorIndexFault("storage_unavailable", false);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertInput(assertion: () => void): void {
  try {
    assertion();
  } catch (error) {
    if (error instanceof VectorIndexFault) throw error;
    throw new VectorIndexFault("invalid_request", false);
  }
}

function assertCompatibility(compatibility: VectorIndexCompatibility): void {
  assertValidEmbeddingProfile(compatibility.embeddingProfile);
  if (
    compatibility.stateNamespaceId === undefined ||
    compatibility.stateNamespaceId.trim() === "" ||
    compatibility.securityDomain.trim() === "" ||
    compatibility.payloadSchemaVersion !== 2
  ) {
    throw new TypeError("invalid vector index compatibility");
  }
}
