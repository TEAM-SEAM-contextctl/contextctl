import { describe, expect, it } from "vitest";

import { selectContext } from "../../src/application/select-context.js";
import {
  assertSelectionAuditRecord,
  createSelectionAuditRecord,
  SELECTION_AUDIT_DETAIL_LIMIT,
  SELECTION_AUDIT_RETENTION_POLICY,
  type SelectionAuditRecord,
} from "../../src/domain/selection-audit.js";
import type { ApprovedCard } from "../../src/domain/card-catalog.js";
import { InMemoryCardCatalog } from "../../src/infrastructure/in-memory-card-catalog.js";
import { InMemorySelectionAuditStore } from "../../src/infrastructure/in-memory-selection-audit-store.js";
import {
  createDemoCardSet,
  DEMO_QUERY,
} from "../fixtures/approved-card.fixture.js";

const FIRST_ID = "sa_00000000000000000000000000000001";

async function auditRecord(
  auditId = FIRST_ID,
  recordedAt = "2026-08-27T00:00:00.000Z",
): Promise<SelectionAuditRecord> {
  const plan = await selectContext(
    { catalog: new InMemoryCardCatalog(createDemoCardSet()) },
    DEMO_QUERY,
  );
  return createSelectionAuditRecord({ plan, auditId, recordedAt });
}

describe("Selection audit projection", () => {
  it("keeps decision evidence without retaining query-reversible text", async () => {
    const record = await auditRecord();
    const serialized = JSON.stringify(record);

    expect(record.queryUtf8Bytes).toBe(Buffer.byteLength(DEMO_QUERY, "utf8"));
    expect(record.candidates.length).toBeGreaterThan(0);
    expect(record.decisions.length).toBe(record.candidates.length);
    expect(record.recordDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(serialized).not.toContain(DEMO_QUERY);
    expect(serialized).not.toContain("matchedValue");
    expect(serialized).not.toContain("normalizedText");
    expect(serialized).not.toContain('"message"');
    expect(record.planning.facets.every((facet) => /^facet_[0-9]+$/u.test(facet.facetRef))).toBe(true);
  });

  it("refuses a modified persisted payload", async () => {
    const record = await auditRecord();
    const changed = {
      ...record,
      catalog: { ...record.catalog, evaluatedCount: record.catalog.evaluatedCount + 1 },
    } as SelectionAuditRecord;

    expect(() => assertSelectionAuditRecord(changed)).toThrow();
  });

  it("keeps a 10,000-Card decision inside the fixed record envelope", async () => {
    const cards: ApprovedCard[] = Array.from({ length: 10_000 }, (_, index) => {
      const suffix = String(index).padStart(5, "0");
      return {
        cardId: `card_${suffix}`,
        versionId: `card_${suffix}.v1`,
        meaning: {
          description: `catalog entry ${suffix}`,
          representativeQuestions: [],
          aliases: [],
          keywords: index === 0 ? ["needle"] : [`topic-${suffix}`],
        },
        policy: { sensitive: false, allowedUsage: ["retrieval"] },
        scopes: [
          {
            kind: "sql_source",
            reference: { scopeId: `scope_${suffix}`, scopeVersion: "1" },
            connector: "catalog.db",
            schema: "public",
            table: `table_${suffix}`,
            columns: ["id"],
          },
        ],
      };
    });
    const plan = await selectContext(
      { catalog: new InMemoryCardCatalog(cards) },
      "needle",
    );
    const record = createSelectionAuditRecord({
      plan,
      auditId: FIRST_ID,
      recordedAt: "2026-08-27T00:00:00.000Z",
    });

    expect(record.catalog.evaluatedCount).toBe(10_000);
    expect(record.catalog.detailedCount).toBeLessThanOrEqual(
      SELECTION_AUDIT_DETAIL_LIMIT,
    );
    expect(record.catalog.omittedCount).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(record), "utf8")).toBeLessThanOrEqual(
      SELECTION_AUDIT_RETENTION_POLICY.maximumRecordBytes,
    );
  });
});

describe("InMemorySelectionAuditStore", () => {
  it("orders records newest first and finds one by its opaque id", async () => {
    const store = new InMemorySelectionAuditStore();
    const first = await auditRecord();
    const second = await auditRecord(
      "sa_00000000000000000000000000000002",
      "2026-08-27T00:01:00.000Z",
    );
    await store.append(first);
    await store.append(second);

    await expect(store.list(1)).resolves.toMatchObject([
      { auditId: second.auditId, recordDigest: second.recordDigest },
    ]);
    await expect(store.find(FIRST_ID)).resolves.toEqual(first);
    await expect(store.append(first)).rejects.toThrow(/already exists/u);
  });

  it("rejects an unbounded list request", async () => {
    const store = new InMemorySelectionAuditStore();
    await expect(store.list(101)).rejects.toThrow(/between 1 and 100/u);
  });

  it("expires a lone old record against wall-clock time", async () => {
    const store = new InMemorySelectionAuditStore(() =>
      Date.parse("2026-08-27T00:00:00.000Z"),
    );
    await store.append(await auditRecord(FIRST_ID, "2026-06-01T00:00:00.000Z"));

    await expect(store.list(1)).resolves.toEqual([]);
    await expect(store.find(FIRST_ID)).resolves.toBeUndefined();
  });
});
