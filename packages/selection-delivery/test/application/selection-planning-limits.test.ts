import { describe, expect, it } from "vitest";

import {
  resolveContextErrorStatus,
  SelectionPlanLimitExceededError,
  toResolveContextErrorCode,
} from "../../src/application/errors.js";
import {
  DEFAULT_CHUNK_LIMIT_PER_SCOPE,
  selectContext,
} from "../../src/application/select-context.js";
import { canonicalJson } from "../../src/domain/canonical-digest.js";
import type { ApprovedCard, ApprovedScope } from "../../src/domain/card-catalog.js";
import {
  planningLimitViolations,
  planSelectedScopes,
  SELECTION_PLANNING_LIMITS,
} from "../../src/domain/selection-plan.js";
import { InMemoryCardCatalog } from "../../src/infrastructure/in-memory-card-catalog.js";
import { createDemoCardSet, createRefundPolicyCard, DEMO_QUERY } from "../fixtures/approved-card.fixture.js";

/**
 * Every Card built here declares the query as a strong contextual phrase, so
 * every one is admitted. The fixture deliberately avoids relying on the
 * lexical policy's treatment of a catalog-wide single-word keyword: these
 * tests are about planning ceilings, not scoring calibration.
 */
const QUERY = "환불 계획 한도";

function managedScope(index: number): ApprovedScope {
  return {
    kind: "managed_document",
    reference: { scopeId: `scope_${index}`, scopeVersion: "scopev_0001" },
    documentIndex: {
      documentIndexId: `docidx_${index}`,
      sourceId: "src_policy_docs",
      documentId: `doc_${index}`,
      indexVersion: "idxv_0001",
    },
    selection: { kind: "document" },
  };
}

function sqlScope(index: number, table = `table_${index}`): ApprovedScope {
  return {
    kind: "sql_source",
    reference: { scopeId: `scope_sql_${index}`, scopeVersion: "scopev_0001" },
    connector: "postgres.main",
    schema: "public",
    table,
    columns: ["id"],
  };
}

function card(index: number, scopes: readonly ApprovedScope[]): ApprovedCard {
  return {
    ...createRefundPolicyCard(),
    cardId: `card_${index}`,
    versionId: `cardv_${index}`,
    meaning: {
      description: QUERY,
      representativeQuestions: [`${QUERY}?`],
      aliases: [],
      keywords: [QUERY],
    },
    scopes,
  };
}

function range(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}

async function planOver(cards: readonly ApprovedCard[], chunkLimitPerScope?: number) {
  return selectContext(
    { catalog: new InMemoryCardCatalog(cards) },
    QUERY,
    chunkLimitPerScope === undefined ? {} : { chunkLimitPerScope },
  );
}

async function violationsOf(cards: readonly ApprovedCard[], chunkLimitPerScope?: number) {
  try {
    await planOver(cards, chunkLimitPerScope);
  } catch (cause) {
    if (cause instanceof SelectionPlanLimitExceededError) {
      return cause.violations.map((violation) => violation.limit);
    }
    throw cause;
  }
  return [];
}

describe("selection-planning-v2 limits", () => {
  it("states the SOT's planning and response ceilings", () => {
    expect(SELECTION_PLANNING_LIMITS).toEqual({
      admittedCards: 32,
      items: 128,
      managedTargets: 64,
      chunksPerTarget: 8,
      selectedByTotal: 256,
      guideBytes: 64 * 1024,
      responseBytes: 2 * 1024 * 1024,
    });
    // One number, not two: the default bound per Scope is the policy ceiling.
    expect(DEFAULT_CHUNK_LIMIT_PER_SCOPE).toBe(SELECTION_PLANNING_LIMITS.chunksPerTarget);
  });

  it("plans the demo catalog well within every ceiling", async () => {
    const plan = await selectContext(
      { catalog: new InMemoryCardCatalog(createDemoCardSet()) },
      DEMO_QUERY,
    );

    expect(planningLimitViolations(3, plan)).toEqual([]);
  });

  it("refuses a 33rd admitted Card and accepts the 32nd", async () => {
    // Each Card on its own SQL Scope, so nothing merges and the count is exact.
    const cards = range(33).map((index) => card(index, [sqlScope(index)]));

    await expect(planOver(cards.slice(0, 32))).resolves.toBeDefined();
    await expect(violationsOf(cards)).resolves.toEqual(["admittedCards"]);
  });

  it("refuses a 129th item and accepts the 128th", async () => {
    // Three Cards (under 32) carrying 43 distinct Scopes each: 129 items.
    const cards = range(3).map((owner) =>
      card(owner, range(43).map((offset) => sqlScope(owner * 43 + offset))),
    );
    const oneFewer = cards.map((entry, owner) =>
      owner === 2 ? { ...entry, scopes: entry.scopes.slice(0, 42) } : entry,
    );

    await expect(planOver(oneFewer)).resolves.toBeDefined();
    await expect(violationsOf(cards)).resolves.toEqual(["items"]);
  });

  it("refuses a 65th managed target and accepts the 64th", async () => {
    const cards = range(2).map((owner) =>
      card(owner, range(33).map((offset) => managedScope(owner * 33 + offset))),
    );
    const oneFewer = cards.map((entry, owner) =>
      owner === 1 ? { ...entry, scopes: entry.scopes.slice(0, 31) } : entry,
    );

    await expect(planOver(oneFewer)).resolves.toBeDefined();
    // 66 managed Scopes: over on targets, and — items being the same Scopes —
    // under on items (66 ≤ 128). Only the target ceiling is named.
    await expect(violationsOf(cards)).resolves.toEqual(["managedTargets"]);
  });

  it("refuses a per-target chunk bound above the ceiling and accepts the ceiling", async () => {
    const cards = [card(0, [managedScope(0)])];

    await expect(planOver(cards, SELECTION_PLANNING_LIMITS.chunksPerTarget)).resolves.toBeDefined();
    await expect(
      violationsOf(cards, SELECTION_PLANNING_LIMITS.chunksPerTarget + 1),
    ).resolves.toEqual(["chunksPerTarget"]);
  });

  it("counts selectedBy over the merged items, and refuses a 257th association", async () => {
    // Nine Cards that all authorise the same 29 Scopes: 29 items after
    // merging (under 128), 9 Cards (under 32), but 9 × 29 = 261 associations.
    const shared = range(29).map((index) => sqlScope(index));
    const cards = range(9).map((owner) => card(owner, shared));
    const eightOwners = cards.slice(0, 8); // 8 × 29 = 232

    await expect(planOver(eightOwners)).resolves.toBeDefined();
    await expect(violationsOf(cards)).resolves.toEqual(["selectedByTotal"]);
  });

  it("measures public guides in canonical UTF-8 bytes and refuses a 64 KiB sum", async () => {
    // One Scope whose table name alone is 65 KiB of Hangul: three bytes per
    // character in UTF-8, so a character count would have passed it.
    const wide = card(0, [sqlScope(0, "표".repeat(22_000))]);
    const plan = planSelectedScopes([wide], DEFAULT_CHUNK_LIMIT_PER_SCOPE);
    const bytes = new TextEncoder().encode(canonicalJson(plan.items[0]?.guide)).length;
    expect(bytes).toBeGreaterThan(SELECTION_PLANNING_LIMITS.guideBytes);
    expect(canonicalJson(plan.items[0]?.guide).length).toBeLessThan(
      SELECTION_PLANNING_LIMITS.guideBytes,
    );

    await expect(violationsOf([wide])).resolves.toEqual(["guideBytes"]);
  });

  it("names every ceiling that was crossed, not just the first", async () => {
    // 33 Cards × 3 distinct managed Scopes each: 33 admitted (> 32) and 99
    // managed targets (> 64), items 99 (≤ 128).
    const cards = range(33).map((owner) =>
      card(owner, range(3).map((offset) => managedScope(owner * 3 + offset))),
    );

    await expect(violationsOf(cards)).resolves.toEqual(["admittedCards", "managedTargets"]);
  });

  it("reports as selection_plan_limit_exceeded, HTTP 422, not retriable", async () => {
    const cards = range(33).map((index) => card(index, [sqlScope(index)]));
    let thrown: unknown;
    try {
      await planOver(cards);
    } catch (cause) {
      thrown = cause;
    }

    expect(thrown).toBeInstanceOf(SelectionPlanLimitExceededError);
    const failure = thrown as SelectionPlanLimitExceededError;
    expect(failure.code).toBe("selection_plan_limit_exceeded");
    expect(failure.retriable).toBe(false);
    expect(toResolveContextErrorCode(thrown)).toBe("selection_plan_limit_exceeded");
    expect(resolveContextErrorStatus("selection_plan_limit_exceeded")).toBe(422);
    expect(failure.violations).toEqual([{ limit: "admittedCards", allowed: 32, actual: 33 }]);
  });

  it("refuses rather than trims: nothing of the plan survives a refusal", async () => {
    const cards = range(33).map((index) => card(index, [sqlScope(index)]));

    // No partial plan is returned under any name; the only outcome is the
    // failure. A consumer never sees 32 of 33 Guides presented as complete.
    await expect(planOver(cards)).rejects.toThrow(SelectionPlanLimitExceededError);
  });
});

describe("planningLimitViolations", () => {
  it("returns an empty list for an empty plan", () => {
    expect(planningLimitViolations(0, { items: [], managedTargets: [] })).toEqual([]);
  });

  it("reports the number reached alongside the ceiling", () => {
    const plan = planSelectedScopes(
      range(2).map((owner) => card(owner, range(33).map((offset) => managedScope(owner * 33 + offset)))),
      DEFAULT_CHUNK_LIMIT_PER_SCOPE,
    );

    expect(planningLimitViolations(2, plan)).toEqual([
      { limit: "managedTargets", allowed: 64, actual: 66 },
    ]);
  });
});
