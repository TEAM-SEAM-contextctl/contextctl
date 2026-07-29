import { readFile } from "node:fs/promises";

import {
  ContractValidationError,
  parseIngestionPublication,
  parsePublicationReady,
  type IngestionPublication,
} from "@contextctl/contracts";
import { describe, expect, it } from "vitest";

async function loadProducerFixture(): Promise<unknown> {
  return JSON.parse(
    await readFile(
      new URL("./fixtures/ingestion-publication.v1.json", import.meta.url),
      "utf8",
    ),
  ) as unknown;
}

function consumePublication(publication: IngestionPublication) {
  return publication.knowledgeUnits.map((unit) => ({
    unitId: unit.id,
    scopeRefs: unit.retrievalScopes.map((scope) => ({
      scopeId: scope.scopeId,
      scopeVersion: scope.scopeVersion,
    })),
  }));
}

describe("IngestionPublication contract", () => {
  it("round-trips the producer fixture through the public consumer API", async () => {
    const publication = parseIngestionPublication(await loadProducerFixture());
    const roundTripped = parseIngestionPublication(
      JSON.parse(JSON.stringify(publication)),
    );

    expect(consumePublication(roundTripped)).toEqual([
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
    const fixture = (await loadProducerFixture()) as {
      knowledgeUnits: Array<{ retrievalScopes: Array<Record<string, unknown>> }>;
    };
    const scope = fixture.knowledgeUnits[0]?.retrievalScopes[0];
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
          "retrievalScopes",
          0,
          "kind",
        ]);
      }
    }
  });

  it("rejects unsorted semantic selectors instead of broadening the scope", async () => {
    const fixture = (await loadProducerFixture()) as {
      knowledgeUnits: Array<{
        retrievalScopes: Array<{
          selector: { semanticUnitIds: string[] };
        }>;
      }>;
    };
    const selector = fixture.knowledgeUnits[0]?.retrievalScopes[0]?.selector;
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
    const fixture = (await loadProducerFixture()) as {
      knowledgeUnits: Array<{
        retrievalScopes: Array<{
          documentIndex: { sourceId: string };
        }>;
      }>;
    };
    const documentIndex =
      fixture.knowledgeUnits[0]?.retrievalScopes[0]?.documentIndex;
    expect(documentIndex).toBeDefined();
    if (documentIndex === undefined) {
      return;
    }
    documentIndex.sourceId = "src_other";

    expect(() => parseIngestionPublication(fixture)).toThrow(
      ContractValidationError,
    );
  });

  it("rejects unknown contract versions", async () => {
    const fixture = (await loadProducerFixture()) as {
      schemaVersion: number;
    };
    fixture.schemaVersion = 2;

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
