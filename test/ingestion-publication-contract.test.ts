import { readFile } from "node:fs/promises";

import {
  ContractValidationError,
  parseIngestionPublication,
  parsePublicationReady,
  type IngestionPublication,
} from "@contextctl/contracts";
import { describe, expect, it } from "vitest";

async function loadIngestionProducerFixture(): Promise<unknown> {
  return JSON.parse(
    await readFile(
      new URL("./fixtures/ingestion-publication.v1.json", import.meta.url),
      "utf8",
    ),
  ) as unknown;
}

function consumeAsRegistry(publication: IngestionPublication) {
  return publication.knowledgeUnits.map((unit) => ({
    unitId: unit.id,
    scopeRefs: unit.publishedScopes.map((scope) => ({
      scopeId: scope.scopeId,
      scopeVersion: scope.scopeVersion,
    })),
  }));
}

describe("IngestionPublication contract", () => {
  it("round-trips the Ingestion fixture through the Registry consumer API", async () => {
    const publication = parseIngestionPublication(
      await loadIngestionProducerFixture(),
    );
    const roundTripped = parseIngestionPublication(
      JSON.parse(JSON.stringify(publication)),
    );

    expect(consumeAsRegistry(roundTripped)).toEqual([
      {
        unitId: "unit_payment_failures",
        scopeRefs: [
          {
            scopeId: "scope_payment_failures",
            scopeVersion: "scpv_aaaa",
          },
        ],
      },
    ]);
  });

  it("rejects unknown scope discriminators and reports a stable path", async () => {
    const fixture = (await loadIngestionProducerFixture()) as {
      knowledgeUnits: Array<{ publishedScopes: Array<Record<string, unknown>> }>;
    };
    const scope = fixture.knowledgeUnits[0]?.publishedScopes[0];
    expect(scope).toBeDefined();
    if (scope === undefined) {
      return;
    }
    scope.kind = "vendor_collection";
    scope.collection = "private-physical-name";

    expect(() => parseIngestionPublication(fixture)).toThrow(
      ContractValidationError,
    );
    try {
      parseIngestionPublication(fixture);
    } catch (error) {
      expect(error).toBeInstanceOf(ContractValidationError);
      if (error instanceof ContractValidationError) {
        expect(error.issues[0]?.path).toEqual([
          "knowledgeUnits",
          0,
          "publishedScopes",
          0,
          "kind",
        ]);
      }
    }
  });

  it("rejects unsorted semantic selectors instead of broadening the scope", async () => {
    const fixture = (await loadIngestionProducerFixture()) as {
      knowledgeUnits: Array<{
        publishedScopes: Array<{
          selector: { semanticUnitIds: string[] };
        }>;
      }>;
    };
    const selector = fixture.knowledgeUnits[0]?.publishedScopes[0]?.selector;
    expect(selector).toBeDefined();
    if (selector === undefined) {
      return;
    }
    selector.semanticUnitIds = ["unit_zeta", "unit_alpha"];

    expect(() => parseIngestionPublication(fixture)).toThrow(
      ContractValidationError,
    );
  });

  it("rejects a managed index from another source", async () => {
    const fixture = (await loadIngestionProducerFixture()) as {
      knowledgeUnits: Array<{
        publishedScopes: Array<{
          documentIndex: { sourceId: string };
        }>;
      }>;
    };
    const documentIndex =
      fixture.knowledgeUnits[0]?.publishedScopes[0]?.documentIndex;
    expect(documentIndex).toBeDefined();
    if (documentIndex === undefined) {
      return;
    }
    documentIndex.sourceId = "src_other";

    expect(() => parseIngestionPublication(fixture)).toThrow(
      ContractValidationError,
    );
  });

  it("rejects a managed index and semantic selector from another document", async () => {
    const fixture = (await loadIngestionProducerFixture()) as {
      knowledgeUnits: Array<{
        publishedScopes: Array<{
          documentIndex: { documentId: string };
          selector: { semanticUnitIds: string[] };
        }>;
      }>;
    };
    const scope = fixture.knowledgeUnits[0]?.publishedScopes[0];
    expect(scope).toBeDefined();
    if (scope === undefined) {
      return;
    }
    scope.documentIndex.documentId = "doc_other";
    scope.selector.semanticUnitIds = ["unit_other"];

    expect(() => parseIngestionPublication(fixture)).toThrow(
      ContractValidationError,
    );
  });

  it("rejects duplicate semantic unit coordinates", async () => {
    const fixture = (await loadIngestionProducerFixture()) as {
      knowledgeUnits: Array<Record<string, unknown>>;
      changes: Array<Record<string, unknown>>;
    };
    const originalUnit = fixture.knowledgeUnits[0];
    const originalChange = fixture.changes[0];
    expect(originalUnit).toBeDefined();
    expect(originalChange).toBeDefined();
    if (originalUnit === undefined || originalChange === undefined) {
      return;
    }

    fixture.knowledgeUnits.push({
      ...structuredClone(originalUnit),
      id: "unit_payment_failures_duplicate",
    });
    fixture.changes.push({
      ...structuredClone(originalChange),
      knowledgeUnitId: "unit_payment_failures_duplicate",
    });

    expect(() => parseIngestionPublication(fixture)).toThrow(
      ContractValidationError,
    );
  });

  it("rejects a scope kind that does not match the source coordinate", async () => {
    const fixture = (await loadIngestionProducerFixture()) as {
      knowledgeUnits: Array<{
        publishedScopes: unknown[];
      }>;
    };
    const unit = fixture.knowledgeUnits[0];
    expect(unit).toBeDefined();
    if (unit === undefined) {
      return;
    }
    unit.publishedScopes = [
      {
        scopeId: "scope_payment_failures",
        scopeVersion: "scpv_aaaa",
        kind: "http_source",
        connector: "http.main",
        method: "GET",
        path: "/payments",
      },
    ];

    expect(() => parseIngestionPublication(fixture)).toThrow(
      ContractValidationError,
    );
  });

  it("rejects SQL scopes outside the published table coordinate", async () => {
    const fixture = (await loadIngestionProducerFixture()) as {
      knowledgeUnits: Array<Record<string, unknown>>;
    };
    const unit = fixture.knowledgeUnits[0];
    expect(unit).toBeDefined();
    if (unit === undefined) {
      return;
    }
    unit.kind = "table";
    unit.sourceCoordinate = {
      kind: "sql_table",
      sourceId: "src_payments",
      schema: "public",
      table: "payments",
      columns: ["id"],
    };
    unit.publishedScopes = [
      {
        scopeId: "scope_payment_failures",
        scopeVersion: "scpv_aaaa",
        kind: "sql_source",
        connector: "postgres.main",
        table: "unrelated",
        columns: ["secret"],
      },
    ];

    expect(() => parseIngestionPublication(fixture)).toThrow(
      ContractValidationError,
    );
  });

  it("rejects HTTP scopes outside the published operation coordinate", async () => {
    const fixture = (await loadIngestionProducerFixture()) as {
      knowledgeUnits: Array<Record<string, unknown>>;
    };
    const unit = fixture.knowledgeUnits[0];
    expect(unit).toBeDefined();
    if (unit === undefined) {
      return;
    }
    unit.kind = "operation";
    unit.sourceCoordinate = {
      kind: "http_operation",
      sourceId: "src_payments",
      method: "GET",
      path: "/payments",
    };
    unit.publishedScopes = [
      {
        scopeId: "scope_payment_failures",
        scopeVersion: "scpv_aaaa",
        kind: "http_source",
        connector: "http.main",
        method: "DELETE",
        path: "/unrelated",
      },
    ];

    expect(() => parseIngestionPublication(fixture)).toThrow(
      ContractValidationError,
    );
  });

  it("rejects unknown contract versions", async () => {
    const fixture = (await loadIngestionProducerFixture()) as {
      schemaVersion: number;
    };
    fixture.schemaVersion = 2;

    expect(() => parseIngestionPublication(fixture)).toThrow(
      ContractValidationError,
    );
  });

  it("rejects the obsolete Selection-shaped scope field", async () => {
    const fixture = (await loadIngestionProducerFixture()) as {
      knowledgeUnits: Array<{
        publishedScopes?: unknown;
        retrievalScopes?: unknown;
      }>;
    };
    const unit = fixture.knowledgeUnits[0];
    expect(unit).toBeDefined();
    if (unit === undefined) {
      return;
    }
    unit.retrievalScopes = unit.publishedScopes;
    delete unit.publishedScopes;

    expect(() => parseIngestionPublication(fixture)).toThrow(
      ContractValidationError,
    );
  });

  it("keeps PublicationReady as an ID-only notification envelope", () => {
    expect(
      parsePublicationReady({
        schemaVersion: 1,
        publicationId: "pub_initial",
      }),
    ).toEqual({
      schemaVersion: 1,
      publicationId: "pub_initial",
    });
    expect(() =>
      parsePublicationReady({
        schemaVersion: 1,
        publicationId: "pub_initial",
        sourceId: "src_payments",
      }),
    ).toThrow(ContractValidationError);
  });
});
