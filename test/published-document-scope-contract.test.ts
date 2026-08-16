import { readFile } from "node:fs/promises";

import {
  groupPublishedSqlColumns,
  PublishedDocumentScopeV2Schema as PublishedDocumentScopeSchema,
  PublishedHttpScopeV2Schema,
  PublishedSqlScopeV2Schema,
  type PublishedDocumentScopeV2 as PublishedDocumentScope,
} from "@contextctl/contracts";
import { describe, expect, it } from "vitest";

async function loadFixture(): Promise<unknown> {
  return JSON.parse(
    await readFile(
      new URL("./fixtures/published-document-scopes.v2.json", import.meta.url),
      "utf8",
    ),
  ) as unknown;
}

function consumeAsManagedDocumentFilter(scope: PublishedDocumentScope) {
  return {
    documentIndexId: scope.documentIndex.documentIndexId,
    indexVersion: scope.documentIndex.indexVersion,
    documentId: scope.documentIndex.documentId,
    ...(scope.selector.kind === "semantic_units"
      ? { semanticUnitIds: scope.selector.semanticUnitIds }
      : {}),
  };
}

describe("Published document Scope contract fixture", () => {
  it("maps document and semantic selectors to vendor-neutral logical filters", async () => {
    const fixture = await loadFixture();
    expect(Array.isArray(fixture)).toBe(true);
    if (!Array.isArray(fixture)) return;
    const scopes = fixture.map((value) =>
      PublishedDocumentScopeSchema.parse(value),
    );

    expect(scopes.map(consumeAsManagedDocumentFilter)).toEqual([
      {
        documentIndexId: "didx_payments",
        indexVersion: "idxv_aaaa",
        documentId: "doc_payments",
      },
      {
        documentIndexId: "didx_payments",
        indexVersion: "idxv_aaaa",
        documentId: "doc_payments",
        semanticUnitIds: [
          "unit_payment_failures",
          "unit_payment_retries",
        ],
      },
    ]);
    expect(JSON.stringify(scopes)).not.toMatch(
      /collection|namespace|vendor|filter|credential|api.?key|connectorId|accessHandle/i,
    );
  });

  it("rejects physical vendor filter fields instead of broadening the Scope", async () => {
    const fixture = await loadFixture();
    expect(Array.isArray(fixture)).toBe(true);
    if (!Array.isArray(fixture) || fixture[0] === undefined) return;
    const candidate = {
      ...(fixture[0] as Record<string, unknown>),
      collection: "physical-private-collection",
      filter: { tenant: "other" },
    };

    expect(() => PublishedDocumentScopeSchema.parse(candidate)).toThrow();
  });

  it("requires SQL schema and rejects oversized column sets without truncation", () => {
    const base = {
      scopeId: "scope_sql_orders",
      scopeVersion: "scpv_aaaa",
      kind: "sql_source" as const,
      connector: "postgres.main",
      schema: "billing",
      table: "orders",
      columns: ["id"],
    };
    expect(PublishedSqlScopeV2Schema.parse(base).schema).toBe("billing");
    expect(() =>
      PublishedSqlScopeV2Schema.parse({ ...base, schema: undefined }),
    ).toThrow();
    expect(() =>
      PublishedSqlScopeV2Schema.parse({
        ...base,
        columns: Array.from(
          { length: 257 },
          (_, index) => `column_${String(index).padStart(3, "0")}`,
        ),
      }),
    ).toThrow();

    const wideColumns = Array.from(
      { length: 300 },
      (_, index) => `column_${String(299 - index).padStart(3, "0")}`,
    );
    const groups = groupPublishedSqlColumns(wideColumns);
    expect(groups.map((group) => group.length)).toEqual([256, 44]);
    expect(groups.flat()).toEqual([...wideColumns].sort());
  });

  it("allows only GET HTTP scopes with exact path parameters", () => {
    const base = {
      scopeId: "scope_http_order",
      scopeVersion: "scpv_bbbb",
      kind: "http_source" as const,
      connector: "http.main",
      method: "GET" as const,
      path: "/orders/{orderId}",
      operationId: "getOrder",
      parameters: [
        { location: "path" as const, name: "orderId", required: true },
      ],
    };
    expect(PublishedHttpScopeV2Schema.parse(base).method).toBe("GET");
    expect(() =>
      PublishedHttpScopeV2Schema.parse({ ...base, method: "POST" }),
    ).toThrow();
    expect(() =>
      PublishedHttpScopeV2Schema.parse({ ...base, parameters: [] }),
    ).toThrow();
    expect(() =>
      PublishedHttpScopeV2Schema.parse({
        ...base,
        requiredHeaders: ["authorization"],
      }),
    ).toThrow();
  });
});
