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
  assertValidVectorVersion,
} from "../domain/vector-index.js";
import {
  MAX_VECTOR_SEARCH_LIMIT,
  VectorIndexFault,
  type PreparedVectorIndex,
  type VectorIndexCompatibilityInput as VectorIndexCompatibility,
  type VectorIndexPort,
  type VectorIndexRetentionLease,
  type VectorIndexScope,
  type VectorIndexSearchHit,
  type VectorIndexStoredRecord,
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

interface QdrantClientApi {
  collectionExists(name: string): Promise<{ exists: boolean }>;
  createCollection(name: string, request: object): Promise<boolean>;
  getCollection(name: string): Promise<unknown>;
  createPayloadIndex(name: string, request: object): Promise<unknown>;
  upsert(name: string, request: object): Promise<unknown>;
  query(name: string, request: object): Promise<unknown>;
  scroll(name: string, request: object): Promise<unknown>;
  count(name: string, request: object): Promise<unknown>;
  delete(name: string, request: object): Promise<unknown>;
}

export interface QdrantVectorIndexAdapterOptions {
  readonly url: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly client?: QdrantClientApi;
}

export class QdrantVectorIndexAdapter implements VectorIndexPort {
  readonly #client: QdrantClientApi;
  readonly #profiles = new Map<string, EmbeddingProfile>();
  readonly #versionOperations = new Map<string, Promise<void>>();

  constructor(options: QdrantVectorIndexAdapterOptions) {
    assertSafeEndpoint(options.url);
    this.#client =
      options.client ??
      (new QdrantClient({
        url: options.url,
        ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        timeout: options.timeoutMs ?? 30_000,
        checkCompatibility: false,
      }) as unknown as QdrantClientApi);
  }

  async prepare(
    compatibility: VectorIndexCompatibility,
  ): Promise<PreparedVectorIndex> {
    assertInput(() => assertCompatibility(compatibility));
    const collection = collectionName(compatibility);
    const handle = `qdrant:v1:${compatibilityDigest(compatibility).slice(0, 32)}`;
    try {
      const existence = await this.#client.collectionExists(collection);
      if (!existence.exists) {
        await this.#client.createCollection(collection, {
          vectors: {
            size: compatibility.embeddingProfile.dimensions,
            distance: qdrantDistance(compatibility.embeddingProfile.distance),
          },
          metadata: {
            contextctlCompatibility: compatibilityDigest(compatibility),
          },
        });
      } else {
        assertCollectionCompatibility(
          await this.#client.getCollection(collection),
          compatibility,
        );
      }
      for (const [fieldName, fieldSchema] of Object.entries(REQUIRED_PAYLOAD_INDEXES)) {
        await ensurePayloadIndex(this.#client, collection, fieldName, fieldSchema);
      }
      const info = await this.#client.getCollection(collection);
      assertRequiredPayloadIndexes(info);
    } catch (error) {
      throw translateQdrantFault(error);
    }
    this.#profiles.set(handle, structuredClone(compatibility.embeddingProfile));
    return { accessHandle: handle, capabilities: { metadataPreFilter: true } };
  }

  async rehydrate(input: {
    readonly accessHandle: string;
    readonly compatibility: VectorIndexCompatibility;
  }): Promise<{ readonly capabilities: { readonly metadataPreFilter: true } }> {
    assertInput(() => assertCompatibility(input.compatibility));
    const expectedHandle = `qdrant:v1:${compatibilityDigest(input.compatibility).slice(0, 32)}`;
    if (input.accessHandle !== expectedHandle) {
      throw new VectorIndexFault("invalid_request", false);
    }
    const collection = parseAccessHandle(input.accessHandle);
    try {
      const existence = await this.#client.collectionExists(collection);
      if (!existence.exists) {
        throw new VectorIndexFault("index_unavailable", false);
      }
      const info = await this.#client.getCollection(collection);
      assertCollectionCompatibility(info, input.compatibility);
      assertRequiredPayloadIndexes(info);
    } catch (error) {
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
  }): Promise<void> {
    const collection = parseAccessHandle(input.accessHandle);
    assertInput(() => {
      assertValidVectorRecordBatch(input.embeddingProfile, input.records);
      assertKnownProfile(this.#profiles, input.accessHandle, input.embeddingProfile);
    });
    try {
      await this.#client.upsert(collection, {
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
      });
    } catch (error) {
      throw translateQdrantFault(error);
    }
  }

  async search(input: {
    readonly accessHandle: string;
    readonly scope: VectorIndexScope;
    readonly queryVector: readonly number[];
    readonly limit: number;
  }): Promise<readonly VectorIndexSearchHit[]> {
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
      const result = await this.#client.query(collection, {
        query: [...input.queryVector],
        filter: scopeFilter(input.scope),
        limit: input.limit,
        with_payload: true,
        with_vector: false,
      });
      return parseSearchHits(result, input.scope);
    } catch (error) {
      throw translateQdrantFault(error);
    }
  }

  async listVersionRecords(input: {
    readonly accessHandle: string;
    readonly documentIndexId: string;
    readonly indexVersion: string;
  }): Promise<readonly VectorIndexStoredRecord[]> {
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
        const result = await this.#client.scroll(collection, {
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
        });
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
      throw translateQdrantFault(error);
    }
  }

  async retainVersion(input: {
    readonly accessHandle: string;
    readonly lease: VectorIndexRetentionLease;
  }): Promise<void> {
    assertInput(() => assertValidRetentionLease(input.lease));
    const collection = parseAccessHandle(input.accessHandle);
    const profile = this.#profiles.get(input.accessHandle);
    if (profile === undefined) {
      throw new VectorIndexFault("index_unavailable", false);
    }
    await this.#serializeVersion(input.accessHandle, input.lease, async () => {
      try {
        await this.#client.upsert(collection, {
          wait: true,
          ordering: "strong",
          points: [
            {
              id: qdrantPointId(`lease:${input.lease.leaseId}`),
              vector: Array.from({ length: profile.dimensions }, () => 0),
              payload: { recordKind: "retention_lease", ...input.lease },
            },
          ],
        });
      } catch (error) {
        throw translateQdrantFault(error);
      }
    });
  }

  async releaseRetentionLease(input: {
    readonly accessHandle: string;
    readonly leaseId: string;
  }): Promise<void> {
    const collection = parseAccessHandle(input.accessHandle);
    assertInput(() => assertValidLeaseId(input.leaseId));
    try {
      await this.#client.delete(collection, {
        wait: true,
        ordering: "strong",
        points: [qdrantPointId(`lease:${input.leaseId}`)],
      });
    } catch (error) {
      throw translateQdrantFault(error);
    }
  }

  async deleteVersion(input: {
    readonly accessHandle: string;
    readonly documentIndexId: string;
    readonly indexVersion: string;
    readonly now: string;
  }): Promise<void> {
    const collection = parseAccessHandle(input.accessHandle);
    assertInput(() => assertValidVectorDeletion(input));
    const identity = versionMust(input.documentIndexId, input.indexVersion);
    await this.#serializeVersion(input.accessHandle, input, async () => {
      try {
        const leases = await this.#client.count(collection, {
          exact: true,
          filter: {
            must: [
              keyword("recordKind", "retention_lease"),
              ...identity,
              { key: "expiresAt", range: { gt: input.now } },
            ],
          },
        });
        if (countValue(leases) > 0) {
          throw new VectorIndexFault("index_version_retained", false);
        }
        await this.#client.delete(collection, {
          wait: true,
          ordering: "strong",
          filter: { must: identity },
        });
      } catch (error) {
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
  client: QdrantClientApi,
  collection: string,
  field_name: string,
  field_schema: "keyword" | "integer" | "datetime",
): Promise<void> {
  const info = await client.getCollection(collection);
  if (payloadIndexTypes(info).get(field_name) === undefined) {
    await client.createPayloadIndex(collection, {
      field_name,
      field_schema,
      wait: true,
      ordering: "strong",
    });
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
  if (!isRecord(vectors)) throw new VectorIndexFault("index_unavailable", false);
  if (
    vectors.size !== compatibility.embeddingProfile.dimensions ||
    vectors.distance !== qdrantDistance(compatibility.embeddingProfile.distance)
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
    throw new VectorIndexFault("storage_unavailable", false);
  }
  return result.points.map((point) => {
    if (
      !isRecord(point) ||
      !isRecord(point.payload) ||
      typeof point.score !== "number" ||
      !Number.isFinite(point.score)
    ) {
      throw new VectorIndexFault("storage_unavailable", false);
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
      throw new VectorIndexFault("storage_unavailable", false);
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
      throw new VectorIndexFault("storage_unavailable", false);
    }
    return {
      recordId,
      score: point.score,
      retrievalText,
      metadata,
    };
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
