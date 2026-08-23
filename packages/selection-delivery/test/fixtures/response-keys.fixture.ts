/**
 * Key-walking helpers for tests about the shape of a serialized response, and
 * the one list of keys a response is allowed to carry.
 *
 * Shared because three surface suites and the domain suite each need to ask
 * "which key names appear anywhere in this payload?", and four private copies
 * of the same walk would be four places for one of them to stop descending
 * into arrays.
 */

export type JsonObject = Readonly<Record<string, unknown>>;

/** Every key name reachable from `value`, through objects and arrays alike. */
export function collectKeys(
  value: unknown,
  into: Set<string> = new Set(),
): Set<string> {
  if (Array.isArray(value)) {
    for (const element of value) {
      collectKeys(element, into);
    }
    return into;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, nested] of Object.entries(value)) {
      into.add(key);
      collectKeys(nested, into);
    }
  }
  return into;
}

/**
 * Every key that may appear, at any depth, in a schema v3 `ContextResolution`.
 *
 * A whitelist rather than a blacklist. The leak tests used to scan a response
 * for four names — `connectorId`, `accessHandle`, `collection`, `credential` —
 * and passed for a physical coordinate under any fifth name. Stated this way
 * round, a key the public types do not declare fails wherever it appears, and
 * a field added to the read model reaches a consumer only if someone adds it
 * here too, with a reason.
 *
 * Each entry says why it is public. The test of a good reason is ADR 0001 and
 * ADR 0006: a consumer needs it to act on the answer or to check a citation,
 * and it names nothing about *our* storage — no connector handle, no
 * collection, no path on a disk, no security domain. The consumer's own
 * coordinates (`connector`, `schema`, `table`, `path`, ...) are theirs, not
 * ours, and travel for the opposite reason: the consumer executes those reads
 * itself and cannot without them.
 */
export const PUBLIC_RESPONSE_KEYS: ReadonlySet<string> = new Set([
  // ── Root ────────────────────────────────────────────────────────────────
  "query", // echoed back so a caller can pair result with request
  "policy", // the comparability block, see below
  "selection", // what the selection decided, reduced to what may be acted on
  "items", // one per selected Scope

  // ── policy: whether two responses are comparable at all ─────────────────
  "payloadSchemaVersion",
  "scoring",
  "ranking",
  "planning",
  "fusion",
  "assembly",
  "budget",
  "maxTotalCharacters", // the ceiling the whole response was assembled under
  "maxChunks",

  // ── selection: admitted Cards and the verdict tallies ───────────────────
  "mode", // which scoring family ranked the answer
  "selected", // admitted Cards only; deferred and rejected Cards are not named
  "counts",
  "admitted",
  "deferred",
  "rejected", // an aggregate; no rejected Card's identity travels with it
  "cardId", // a Card is a public, approved entity; naming it is the attribution
  "versionId", // ...and the version says which approval the answer rests on

  // ── item ────────────────────────────────────────────────────────────────
  "selectedBy", // the Cards that authorised this read, in rank order
  "guide", // the coordinate that was granted, see below
  "fulfillment", // what became of it, see below

  // ── guide, every kind ───────────────────────────────────────────────────
  "kind",
  "scopeRef", // the approved Scope a consumer correlates on; never `itemKey`
  "scopeId",
  "scopeVersion",

  // ── guide: managed document — logical index coordinates only ────────────
  // These are the citation. `documentIndexId`/`indexVersion` say which
  // immutable published index answered, `sourceId`/`documentId` say which
  // document; a consumer can check any chunk back against them. None of the
  // four locates a store: the physical binding (`connectorId`,
  // `accessHandle`) was removed from the read model itself (ADR 0006).
  "documentIndexId",
  "sourceId",
  "documentId",
  "indexVersion",
  "selector", // how much of the document the Scope exposes
  "semanticUnitIds", // ...when it exposes named units rather than the whole
  "limit", // the most chunks the read was allowed to return

  // ── guide: SQL — the consumer's own datasource, which it executes itself ─
  "connector", // `postgres.main`: the consumer's connector, not ours
  "schema",
  "table",
  "columns",
  "allowedOperations", // the "허용 연산" ADR 0001 requires to be stated

  // ── guide: HTTP — the consumer's own endpoint, which it calls itself ─────
  "method",
  "path", // the endpoint path the consumer was granted, never a filesystem path
  "operationId", // disambiguates two operations on one path
  "parameters",
  "location",
  "name",
  "required",

  // ── fulfillment ─────────────────────────────────────────────────────────
  "status",
  "executor", // `contextctl` read it, or the `consumer` still has to
  "context", // the retrieved text, see below
  "failure", // why a managed read produced nothing, as a consumer receives it
  "stage",
  "code", // an opaque token; the exception behind it never travels
  "retriable",

  // ── context: retrieved document text ────────────────────────────────────
  "contentTrust", // the constant `untrusted`: data, never instruction
  "chunks",
  "omitted", // this Scope's losses, so a clipped answer is distinguishable
  "truncated",
  "contextRank", // 1-based order across the response; never a raw score
  "chunkId", // which published chunk — checkable against the index above
  "chunkRevisionId", // ...and which revision of it
  "semanticUnitId", // the unit the chunk belongs to, for citation
  "text",
  "contentDigest", // lets a consumer verify the text it received is the published one
  "reason", // why a chunk was omitted: a duplicate, or the budget
]);

/**
 * The keys in `payload` that the public types do not declare, sorted.
 *
 * Empty for a well-formed response. A test asserts `toEqual([])` so a failure
 * names the offending key rather than reporting a boolean.
 */
export function unexpectedResponseKeys(payload: unknown): readonly string[] {
  return [...collectKeys(payload)]
    .filter((key) => !PUBLIC_RESPONSE_KEYS.has(key))
    .sort();
}
