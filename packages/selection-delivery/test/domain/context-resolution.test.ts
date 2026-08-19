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

/**
 * Our own retrieval coordinates, exactly as the two managed document Cards in
 * `createAllOutcomesCardSet()` declare them.
 *
 * Both are named here so every exclusion check below can be paired with a
 * positive assertion that the fixture carries the value at all. The `failed`
 * Card's binding is included on purpose: its guide is serialized like any
 * other, and nothing about failing exempts it from the field ban.
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

  it("starts from a card set that really carries the forbidden values", () => {
    // The anti-void half of every exclusion below: without this, they would all
    // pass against a fixture that never held these values at all.
    const bindings = createAllOutcomesCardSet().flatMap((card) =>
      card.scopes.flatMap((scope) =>
        scope.kind === "managed_document"
          ? [scope.documentIndex.connectorId, scope.documentIndex.accessHandle]
          : [],
      ),
    );

    expect(bindings).toEqual([
      FORBIDDEN_VALUES.fulfilledConnectorId,
      FORBIDDEN_VALUES.fulfilledAccessHandle,
      FORBIDDEN_VALUES.failedConnectorId,
      FORBIDDEN_VALUES.failedAccessHandle,
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

  it.each(["connectorId", "accessHandle", "collection", "credential"])(
    "omits the %s field",
    (field) => {
      expect(wire).not.toContain(field);
    },
  );

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
      scoring: "selection-lexical-v1",
      ranking: "selection-ranking-v2",
      planning: "selection-planning-v1",
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
      hybrid: "selection-hybrid-v1",
      lexical_degraded: "selection-lexical-v1",
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
