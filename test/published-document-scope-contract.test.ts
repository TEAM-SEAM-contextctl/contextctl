import { readFile } from "node:fs/promises";

import {
  PublishedDocumentScopeSchema,
  type PublishedDocumentScope,
} from "@contextctl/contracts";
import { describe, expect, it } from "vitest";

async function loadFixture(): Promise<unknown> {
  return JSON.parse(
    await readFile(
      new URL("./fixtures/published-document-scopes.v1.json", import.meta.url),
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
      /collection|namespace|vendor|filter|credential|api.?key/i,
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
});
