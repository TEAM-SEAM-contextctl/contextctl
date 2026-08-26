import { beforeAll, describe, expect, it } from "vitest";

import type { ResolveContextApplication } from "../../src/application/context-application.js";
import type {
  ContextResolution,
  ContextResolutionItem,
} from "../../src/domain/context-resolution.js";
import { DEFAULT_CONTEXT_BUDGET } from "../../src/domain/context-assembly.js";
import { DEFAULT_SELECTION_THRESHOLDS } from "../../src/domain/selection-verdict.js";
import {
  ALL_OUTCOMES_QUERY,
  createAllOutcomesCardSet,
} from "../fixtures/approved-card.fixture.js";
import { createFixtureContextApplication } from "../fixtures/context-application.fixture.js";
import { createRefundPolicyChunkMap } from "../fixtures/document-chunk.fixture.js";
import { unexpectedResponseKeys } from "../fixtures/response-keys.fixture.js";

/**
 * Physical retrieval coordinates in the shape our own infrastructure would use
 * for the two managed documents in `createAllOutcomesCardSet()`.
 *
 * They are literals, not values read off the fixture: the contract dropped the
 * physical binding, so a Card has nowhere to declare a connector id or an
 * access handle and there is no longer a fixture value to pair an exclusion
 * with. The exclusions below therefore assert something broader than they used
 * to — that no coordinate of this shape appears in a resolution from any
 * source, including one an adapter or a projection reintroduced downstream of
 * the catalog. The `failed` document's pair is kept for the same reason it was
 * added: its guide is serialized like any other, and nothing about failing
 * exempts it from the ban.
 */
const FORBIDDEN_VALUES = {
  fulfilledConnectorId: "vector.local",
  fulfilledAccessHandle: "documents/policies/indexes/refund",
  failedConnectorId: "vector.retired",
  failedAccessHandle: "documents/policies/indexes/retired",
} as const;

/**
 * Resolves the four-outcome catalog through the real three steps and the real
 * in-package assembly, under the thresholds the package actually ships.
 *
 * These tests used to compose the resolution by hand, on the argument that a
 * test pinning a serialized shape must not agree with whatever the pipeline
 * emits. The argument does not survive contact with what the shape is for:
 * hand composition pinned a payload nothing ever produced, so a pipeline that
 * mapped a Card onto a different item — or that leaked `connectorId` on its way
 * out — passed every exclusion check below untouched. The payload a consumer
 * actually receives is the only one worth checking for a leak.
 *
 * No threshold band is stated. The fixture Cards declare keywords that appear
 * in `ALL_OUTCOMES_QUERY` literally, and a direct match is at or above
 * `DIRECT_MATCH_FLOOR` by construction, which is above the default admit
 * threshold. The dependency is on a declared policy constant, not on a number a
 * heuristic produced.
 *
 * Compile-time pinning of the shape itself has not moved: it lives in
 * `context-resolution.types.test.ts`, where hand composition is the point.
 */
function allOutcomesApplication(): ResolveContextApplication {
  return createFixtureContextApplication({
    cards: createAllOutcomesCardSet(),
    chunks: createRefundPolicyChunkMap(),
  });
}

function resolveAllOutcomes(query: string): Promise<ContextResolution> {
  return allOutcomesApplication().resolveContext({ query });
}

function itemFor(
  resolution: ContextResolution,
  scopeId: string,
): ContextResolutionItem {
  const found = resolution.items.find(
    (item) => item.guide.scopeRef.scopeId === scopeId,
  );

  if (found === undefined) {
    throw new Error(`no item for ${scopeId}`);
  }
  return found;
}

describe("ContextResolution serialization", () => {
  let resolution: ContextResolution;
  let wire: string;

  beforeAll(async () => {
    resolution = await resolveAllOutcomes(ALL_OUTCOMES_QUERY);
    wire = JSON.stringify(resolution);
  });

  it("starts from a card set that carries no physical binding to leak", () => {
    // This was the anti-void half of every exclusion below, reading the two
    // bindings off the fixture to prove there was something worth excluding.
    // The fixture cannot carry them any more, so the guard inverts and covers
    // more: every managed document entry in the catalog is exactly the four
    // logical fields, checked as a whole set rather than field by field, so a
    // physical field reintroduced on the read model fails here — at the source
    // — instead of travelling to the serializer and depending on a projection
    // to drop it. The exclusions further down then hold whatever the layers in
    // between do, which is the property those checks were always after.
    const documentIndexKeys = createAllOutcomesCardSet().flatMap((card) =>
      card.scopes.flatMap((scope) =>
        scope.kind === "managed_document"
          ? [Object.keys(scope.documentIndex).sort()]
          : [],
      ),
    );

    expect(documentIndexKeys).toEqual([
      ["documentId", "documentIndexId", "indexVersion", "sourceId"],
      ["documentId", "documentIndexId", "indexVersion", "sourceId"],
    ]);
  });

  it("really resolved the scopes those values belong to", () => {
    // The second half of the same guard: an exclusion over a payload that
    // dropped the document items entirely would also pass.
    expect(
      itemFor(resolution, "scope_indexed_document").fulfillment.status,
    ).toBe("fulfilled");
    expect(
      itemFor(resolution, "scope_unindexed_document").fulfillment.status,
    ).toBe("failed");
  });

  it("carries no key the public types do not declare", () => {
    // A whitelist walk over the parsed wire rather than a scan for four
    // forbidden names. The four — `connectorId`, `accessHandle`, `collection`,
    // `credential` — are still refused, but so is any fifth name a physical
    // binding might travel under: a key reaches a consumer only if it is in
    // `PUBLIC_RESPONSE_KEYS`, with a reason written beside it.
    expect(unexpectedResponseKeys(JSON.parse(wire))).toEqual([]);
  });

  it("omits the binding values, not just the field names", () => {
    // A leak that renamed the field would pass a name-only check while still
    // handing the consumer the handle.
    for (const value of Object.values(FORBIDDEN_VALUES)) {
      expect(wire).not.toContain(value);
    }
  });

  it("never publishes the security domain a read was made under", () => {
    // Not a field this package ever holds: the executor adds it from its own
    // configuration and Selection never sees it, so the absence is structural.
    expect(wire).not.toContain("securityDomain");
  });

  it("keeps the sql coordinate a consumer needs to run the query", () => {
    expect(itemFor(resolution, "scope_ledger_table").guide).toMatchObject({
      kind: "sql",
      connector: "postgres.ledger",
      table: "inventory_ledger",
      allowedOperations: ["select"],
    });
  });

  it("keeps the http coordinate a consumer needs to call the endpoint", () => {
    expect(itemFor(resolution, "scope_lookup_api").guide).toMatchObject({
      kind: "http",
      connector: "billing.api",
      method: "GET",
      path: "/settlements/{settlementId}",
    });
  });

  it("keeps the document coordinates that make a citation checkable", () => {
    expect(itemFor(resolution, "scope_indexed_document").guide).toMatchObject({
      kind: "managed_document",
      documentIndexId: "docidx_refund_policy",
      sourceId: "src_policy_docs",
      documentId: "doc_refund_policy",
      indexVersion: "idxv_0001",
    });
  });

  it("keeps them on a failed item too, so the gap is attributable", () => {
    expect(itemFor(resolution, "scope_unindexed_document").guide).toMatchObject({
      kind: "managed_document",
      documentIndexId: "docidx_not_registered",
      indexVersion: "idxv_0002",
    });
  });

  it("states every comparability fact in one block", () => {
    expect(Object.keys(resolution.policy).sort()).toEqual([
      "assembly",
      "budget",
      "fusion",
      "payloadSchemaVersion",
      "planning",
      "ranking",
      "scoring",
    ]);
    expect(resolution.policy.payloadSchemaVersion).toBe(3);
    expect(resolution.policy.budget).toEqual(DEFAULT_CONTEXT_BUDGET);
  });

  it("names the policy behind each of the five steps", () => {
    expect(resolution.policy).toMatchObject({
      scoring: "selection-lexical-v4",
      ranking: "selection-ranking-v2",
      planning: "selection-planning-v2",
      fusion: "rrf-v1",
      assembly: "context-assembly-v2",
    });
  });

  it("pairs the declared mode with the scoring family that produced it", () => {
    // The invariant stated on `SelectionSummary.mode`, checked on the payload
    // rather than on the two constants: a response that claimed `hybrid` while
    // scoring lexically would tell a consumer its ranking used Card embeddings
    // that do not exist.
    const pairs = {
      hybrid: "selection-hybrid-v4",
      lexical_degraded: "selection-lexical-v4",
    } as const;

    expect(resolution.policy.scoring).toBe(pairs[resolution.selection.mode]);
  });

  it("carries no per-item budget or policy version to disagree with that block", () => {
    for (const item of resolution.items) {
      expect(item).not.toHaveProperty("budget");
      expect(item).not.toHaveProperty("policyVersion");
      if (item.fulfillment.status === "fulfilled") {
        expect(item.fulfillment.context).not.toHaveProperty("budget");
        expect(item.fulfillment.context).not.toHaveProperty("policyVersion");
      }
    }
  });

  it("summarizes the selection without publishing what it looked at", () => {
    // Four Cards were scored and all four were admitted under the shipped band,
    // so the counts account for every candidate — which is what makes the
    // absence of `candidates` a removal rather than a gap.
    expect(resolution.selection.counts).toEqual({
      admitted: 4,
      deferred: 0,
      rejected: 0,
    });
    expect(
      resolution.selection.selected.map((card) => card.cardId).sort(),
    ).toEqual([
      "card_indexed_document",
      "card_ledger_table",
      "card_lookup_api",
      "card_unindexed_document",
    ]);
  });

  it("no longer carries the raw candidate scores or the verdict trail", () => {
    // Absence, not `undefined`: a payload that still carried these keys with an
    // undefined value would be the v2 contract, and an equality check against
    // `undefined` could not tell the two apart.
    expect(Object.hasOwn(resolution, "candidates")).toBe(false);
    expect(Object.keys(resolution.selection).sort()).toEqual([
      "counts",
      "mode",
      "selected",
    ]);
  });

  it.each(["score", "signals", "findings", "provenance", "thresholds"])(
    "keeps %s out of the serialized payload",
    (field) => {
      expect(wire).not.toContain(field);
    },
  );

  it("was judged under the thresholds the package ships, not a test's own", () => {
    // Read off the plan rather than off the response, because the response no
    // longer states it: the band is a policy the deployment sets, and a caller
    // that learned it could work out which questions the catalog declines.
    expect(DEFAULT_SELECTION_THRESHOLDS.admit).toBeGreaterThan(
      DEFAULT_SELECTION_THRESHOLDS.reject,
    );
    expect(resolution.selection.counts.admitted).toBe(4);
  });

  it("echoes the query back exactly as received", () => {
    expect(resolution.query).toBe(ALL_OUTCOMES_QUERY);
  });
});

describe("ContextResolutionItem fulfillment", () => {
  let resolution: ContextResolution;

  beforeAll(async () => {
    resolution = await resolveAllOutcomes(ALL_OUTCOMES_QUERY);
  });

  it("produces one item per selected scope, none dropped", () => {
    expect(resolution.items.map((item) => item.guide.scopeRef.scopeId)).toEqual([
      "scope_indexed_document",
      "scope_ledger_table",
      "scope_lookup_api",
      "scope_unindexed_document",
    ]);
  });

  it("names every Card that selected an item, and only those", () => {
    expect(
      resolution.items.map((item) => item.selectedBy.map((card) => card.cardId)),
    ).toEqual([
      ["card_indexed_document"],
      ["card_ledger_table"],
      ["card_lookup_api"],
      ["card_unindexed_document"],
    ]);
  });

  it("reports every fulfillment state one resolution can produce", () => {
    expect(
      [
        ...new Set(resolution.items.map((item) => item.fulfillment.status)),
      ].sort(),
    ).toEqual(["delegated", "failed", "fulfilled"]);
  });

  it("credits each item to the party that actually did the work", () => {
    for (const item of resolution.items) {
      expect(item.fulfillment.executor).toBe(
        item.guide.kind === "managed_document" ? "contextctl" : "consumer",
      );
    }
  });

  it("reports a scope whose read failed with the executor's own code", () => {
    const item = itemFor(resolution, "scope_unindexed_document");

    if (item.fulfillment.status !== "failed") {
      throw new Error("expected the unindexed Scope to fail");
    }
    // The code is the executor's own: `FixtureManagedExecutor` answers an
    // unregistered Scope with `scope_not_published`. The failure comes from the
    // executor's behaviour, not from a stub written to produce this string.
    expect(item.fulfillment.failure).toEqual({
      stage: "managed_search",
      code: "scope_not_published",
      retriable: false,
    });
  });

  it("does not let one failed scope take the others down with it", () => {
    expect(
      resolution.items.filter((item) => item.fulfillment.status !== "failed"),
    ).toHaveLength(3);
  });

  it("never reports a delegated scope as failed", () => {
    for (const scopeId of ["scope_ledger_table", "scope_lookup_api"]) {
      const item = itemFor(resolution, scopeId);

      expect(item.fulfillment.status).toBe("delegated");
      expect(item.fulfillment).not.toHaveProperty("failure");
    }
  });

  it("attaches retrieved context to every fulfilled item", () => {
    const item = itemFor(resolution, "scope_indexed_document");

    if (item.fulfillment.status !== "fulfilled") {
      throw new Error("expected the indexed Scope to be fulfilled");
    }
    expect(item.fulfillment.context.chunks.length).toBeGreaterThan(0);
    expect(item.fulfillment.context.omitted).toEqual([]);
    expect(item.fulfillment.context.truncated).toBe(false);
    expect(item.fulfillment.context.contentTrust).toBe("untrusted");
  });

  it("cites every chunk back to the document it came from", () => {
    const item = itemFor(resolution, "scope_indexed_document");

    if (item.fulfillment.status !== "fulfilled") {
      throw new Error("expected the indexed Scope to be fulfilled");
    }
    for (const chunk of item.fulfillment.context.chunks) {
      expect(chunk.documentId).toBe("doc_refund_policy");
      // `itemKey` and `scopeRef` were on the chunk in v2 and are not now. The
      // item already states both, once, and a chunk that repeated them let one
      // copy disagree with the other.
      expect(chunk).not.toHaveProperty("itemKey");
      expect(chunk).not.toHaveProperty("scopeRef");
    }
  });

  it("ranks context 1..n across the whole response, not per item", () => {
    const ranks = resolution.items.flatMap((item) =>
      item.fulfillment.status === "fulfilled"
        ? item.fulfillment.context.chunks.map((chunk) => chunk.contextRank)
        : [],
    );

    // Unique, gap-free and starting at one. Per-item numbering would produce a
    // second `1` the moment two items both retrieved something, and this
    // fixture's one fulfilled item is why the assertion is written over the
    // whole response rather than over that item.
    expect(ranks.length).toBeGreaterThan(0);
    expect([...ranks].sort((left, right) => left - right)).toEqual(
      Array.from({ length: ranks.length }, (_, index) => index + 1),
    );
  });

  it("keeps the plan's own item key off every item", () => {
    for (const item of resolution.items) {
      expect(item).not.toHaveProperty("itemKey");
    }
    // A consumer correlates on the Scope reference instead, and it is unique
    // per item because two Cards on one Scope merge into one item.
    expect(
      new Set(resolution.items.map((item) => item.guide.scopeRef.scopeId)).size,
    ).toBe(4);
  });
});
