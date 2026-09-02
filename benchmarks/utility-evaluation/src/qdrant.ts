import type { DenseRankingEntry } from "./baseline.js";
import type { ProductChunk } from "./types.js";

interface QdrantClientConfiguration {
  readonly url: string;
  readonly apiKey?: string;
}

export interface PublishedQdrantCorpus {
  readonly chunks: readonly ProductChunk[];
  readonly version: string;
  searchDense(
    queryVector: readonly number[],
    limit: number,
  ): Promise<readonly DenseRankingEntry[]>;
}

export async function readPublishedCorpus(input: {
  readonly qdrant: QdrantClientConfiguration;
  readonly stateNamespaceId: string;
  readonly securityDomain: string;
}): Promise<PublishedQdrantCorpus> {
  const version = await readQdrantVersion(input.qdrant);
  const collections = await listCollections(input.qdrant);
  const chunks: ProductChunk[] = [];
  const populatedCollections: string[] = [];
  for (const collection of collections) {
    const published = await scrollCollection({
      qdrant: input.qdrant,
      collection,
      stateNamespaceId: input.stateNamespaceId,
      securityDomain: input.securityDomain,
    });
    if (published.length > 0) populatedCollections.push(collection);
    chunks.push(...published);
  }
  if (chunks.length === 0) {
    throw new Error("Qdrant contains no chunks for the evaluation identity");
  }
  const byRevision = new Map<string, ProductChunk>();
  for (const chunk of chunks) {
    const existing = byRevision.get(chunk.chunkRevisionId);
    if (existing !== undefined && existing.text !== chunk.text) {
      throw new Error(
        `chunk revision collision in Qdrant: ${chunk.chunkRevisionId}`,
      );
    }
    byRevision.set(chunk.chunkRevisionId, chunk);
  }
  const unique = [...byRevision.values()].sort((left, right) =>
    compareText(left.chunkRevisionId, right.chunkRevisionId),
  );
  const dimensions = new Set(unique.map((chunk) => chunk.vector.length));
  if (dimensions.size !== 1 || unique[0]?.vector.length === 0) {
    throw new Error("Qdrant chunk vectors do not share one non-zero dimension");
  }
  return {
    chunks: unique,
    version,
    async searchDense(queryVector, limit) {
      const rankings = await Promise.all(
        populatedCollections.map(
          async (collection) =>
            await queryCollection({
              qdrant: input.qdrant,
              collection,
              stateNamespaceId: input.stateNamespaceId,
              securityDomain: input.securityDomain,
              queryVector,
              limit,
            }),
        ),
      );
      const best = new Map<string, number>();
      for (const hit of rankings.flat()) {
        best.set(
          hit.chunkRevisionId,
          Math.max(
            best.get(hit.chunkRevisionId) ?? Number.NEGATIVE_INFINITY,
            hit.score,
          ),
        );
      }
      return [...best]
        .map(([chunkRevisionId, score]) => ({ chunkRevisionId, score }))
        .sort(
          (left, right) =>
            right.score - left.score ||
            compareText(left.chunkRevisionId, right.chunkRevisionId),
        )
        .slice(0, limit);
    },
  };
}

async function readQdrantVersion(
  qdrant: QdrantClientConfiguration,
): Promise<string> {
  const payload = await request(qdrant, "/", { method: "GET" });
  if (!isRecord(payload) || typeof payload["version"] !== "string") {
    throw new Error("Qdrant root response has no version");
  }
  return payload["version"];
}

async function queryCollection(input: {
  readonly qdrant: QdrantClientConfiguration;
  readonly collection: string;
  readonly stateNamespaceId: string;
  readonly securityDomain: string;
  readonly queryVector: readonly number[];
  readonly limit: number;
}): Promise<readonly DenseRankingEntry[]> {
  const payload = await request(
    input.qdrant,
    `/collections/${encodeURIComponent(input.collection)}/points/query`,
    {
      method: "POST",
      body: JSON.stringify({
        query: input.queryVector,
        limit: input.limit,
        with_payload: true,
        with_vector: false,
        filter: identityFilter(input.stateNamespaceId, input.securityDomain),
      }),
    },
  );
  const points =
    isRecord(payload) &&
    isRecord(payload["result"]) &&
    Array.isArray(payload["result"]["points"])
      ? payload["result"]["points"]
      : undefined;
  if (points === undefined) {
    throw new Error(`Qdrant query response is invalid: ${input.collection}`);
  }
  return points.map((point, index) => {
    if (
      !isRecord(point) ||
      !isRecord(point["payload"]) ||
      typeof point["score"] !== "number" ||
      !Number.isFinite(point["score"])
    ) {
      throw new Error(
        `Qdrant query point is invalid: ${input.collection}/${String(index)}`,
      );
    }
    return {
      chunkRevisionId: requiredString(
        point["payload"]["chunkRevisionId"],
        "chunkRevisionId",
      ),
      score: point["score"],
    };
  });
}

async function listCollections(
  qdrant: QdrantClientConfiguration,
): Promise<readonly string[]> {
  const payload = await request(qdrant, "/collections", { method: "GET" });
  if (!isRecord(payload) || !isRecord(payload["result"])) {
    throw new Error("Qdrant collections response is invalid");
  }
  const collections = payload["result"]["collections"];
  if (!Array.isArray(collections)) {
    throw new Error("Qdrant collections response has no collection list");
  }
  return collections
    .flatMap((entry) =>
      isRecord(entry) && typeof entry["name"] === "string"
        ? [entry["name"]]
        : [],
    )
    .sort(compareText);
}

async function scrollCollection(input: {
  readonly qdrant: QdrantClientConfiguration;
  readonly collection: string;
  readonly stateNamespaceId: string;
  readonly securityDomain: string;
}): Promise<readonly ProductChunk[]> {
  const chunks: ProductChunk[] = [];
  let offset: unknown;
  const seenOffsets = new Set<string>();
  do {
    const payload = await request(
      input.qdrant,
      `/collections/${encodeURIComponent(input.collection)}/points/scroll`,
      {
        method: "POST",
        body: JSON.stringify({
          limit: 256,
          with_payload: true,
          with_vector: true,
          filter: identityFilter(
            input.stateNamespaceId,
            input.securityDomain,
          ),
          ...(offset === undefined ? {} : { offset }),
        }),
      },
    );
    if (!isRecord(payload) || !isRecord(payload["result"])) {
      throw new Error(`Qdrant scroll response is invalid: ${input.collection}`);
    }
    const points = payload["result"]["points"];
    if (!Array.isArray(points)) {
      throw new Error(`Qdrant scroll points are invalid: ${input.collection}`);
    }
    chunks.push(...points.map(parsePoint));
    offset = payload["result"]["next_page_offset"] ?? undefined;
    if (offset !== undefined) {
      const key = JSON.stringify(offset);
      if (seenOffsets.has(key)) {
        throw new Error(`Qdrant repeated a scroll offset: ${input.collection}`);
      }
      seenOffsets.add(key);
    }
  } while (offset !== undefined);
  return chunks;
}

function identityFilter(
  stateNamespaceId: string,
  securityDomain: string,
): unknown {
  return {
    must: [
      { key: "recordKind", match: { value: "chunk" } },
      { key: "stateNamespaceId", match: { value: stateNamespaceId } },
      { key: "securityDomain", match: { value: securityDomain } },
    ],
  };
}

function parsePoint(value: unknown): ProductChunk {
  if (!isRecord(value) || !isRecord(value["payload"])) {
    throw new Error("Qdrant point has no payload");
  }
  const payload = value["payload"];
  if (payload["recordKind"] !== "chunk") {
    throw new Error("Qdrant point is not a chunk");
  }
  return {
    chunkId: requiredString(payload["chunkId"], "chunkId"),
    chunkRevisionId: requiredString(
      payload["chunkRevisionId"],
      "chunkRevisionId",
    ),
    semanticUnitId: requiredString(
      payload["semanticUnitId"],
      "semanticUnitId",
    ),
    documentId: requiredString(payload["documentId"], "documentId"),
    text: requiredString(payload["retrievalText"], "retrievalText"),
    vector: parseVector(value["vector"]),
  };
}

function parseVector(value: unknown): readonly number[] {
  const candidate =
    Array.isArray(value)
      ? value
      : isRecord(value)
        ? Object.values(value).find(Array.isArray)
        : undefined;
  if (
    !Array.isArray(candidate) ||
    candidate.length === 0 ||
    !candidate.every(
      (component) => typeof component === "number" && Number.isFinite(component),
    )
  ) {
    throw new Error("Qdrant point vector is invalid");
  }
  return candidate as number[];
}

async function request(
  configuration: QdrantClientConfiguration,
  path: string,
  init: RequestInit,
): Promise<unknown> {
  const url = new URL(path, withTrailingSlash(configuration.url));
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(configuration.apiKey === undefined
        ? {}
        : { "api-key": configuration.apiKey }),
      ...init.headers,
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(
      `Qdrant ${init.method ?? "GET"} ${url.pathname} failed with ${String(response.status)}`,
    );
  }
  return await response.json();
}

function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`Qdrant chunk payload field is invalid: ${field}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
