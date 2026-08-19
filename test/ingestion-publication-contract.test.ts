import { readFile } from "node:fs/promises";

import {
  assertIngestionPublicationTransition,
  computePublicationChanges,
  computePublishedKnowledgeUnitDigest,
  ContractValidationError,
  INGESTION_PUBLICATION_SCHEMA_VERSION,
  IngestionPublicationSchema,
  parseIngestionPublication,
  parsePublicationReady,
  PublishedFactSchema,
  type IngestionPublication,
  type PublishedKnowledgeUnit,
} from "@contextctl/contracts";
import { describe, expect, it } from "vitest";

async function loadIngestionProducerFixture(): Promise<unknown> {
  return JSON.parse(
    await readFile(
      new URL("./fixtures/ingestion-publication.v2.json", import.meta.url),
      "utf8",
    ),
  ) as unknown;
}

async function loadLegacyFixture(): Promise<unknown> {
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

  it("exposes schema v2 as the only canonical contract", async () => {
    const legacy = await loadLegacyFixture();
    const current = await loadIngestionProducerFixture();
    expect(INGESTION_PUBLICATION_SCHEMA_VERSION).toBe(2);
    expect(IngestionPublicationSchema.parse(current).schemaVersion).toBe(2);
    expect(() => parseIngestionPublication(legacy)).toThrow(
      ContractValidationError,
    );
  });

  it("rejects physical bindings and free-form content side channels", async () => {
    const fixture = (await loadIngestionProducerFixture()) as {
      knowledgeUnits: Array<{
        facts: Array<Record<string, unknown>>;
        publishedScopes: Array<{
          documentIndex: Record<string, unknown>;
        }>;
      }>;
    };
    const unit = fixture.knowledgeUnits[0];
    expect(unit).toBeDefined();
    if (unit === undefined) return;
    unit.facts.push({
      name: "raw_document_text",
      value: "the original document must never cross this boundary",
    });
    unit.publishedScopes[0]!.documentIndex.connectorId = "vector.private";
    unit.publishedScopes[0]!.documentIndex.accessHandle = "secret/collection";

    expect(() => parseIngestionPublication(fixture)).toThrow(
      ContractValidationError,
    );
  });

  it("recomputes publication unit digests instead of trusting producers", async () => {
    const fixture = (await loadIngestionProducerFixture()) as {
      knowledgeUnits: Array<{ contentDigest: string }>;
    };
    fixture.knowledgeUnits[0]!.contentDigest = `sha256:${"0".repeat(64)}`;

    expect(() => parseIngestionPublication(fixture)).toThrow(
      ContractValidationError,
    );
  });

  it("preserves segment as its own unit kind", async () => {
    const fixture = (await loadIngestionProducerFixture()) as {
      knowledgeUnits: Array<{
        kind: string;
        facts: Array<{ name: string; value: unknown }>;
        contentDigest: string;
      }>;
      changes: Array<{ currentContentDigest?: string }>;
    };
    const unit = fixture.knowledgeUnits[0]!;
    unit.kind = "segment";
    const kindFact = unit.facts.find((fact) => fact.name === "unit.kind")!;
    kindFact.value = "segment";
    unit.contentDigest = computePublishedKnowledgeUnitDigest(
      unit as PublishedKnowledgeUnit,
    );
    fixture.changes[0]!.currentContentDigest = unit.contentDigest;

    expect(parseIngestionPublication(fixture).knowledgeUnits[0]?.kind).toBe(
      "segment",
    );
  });

  it("keeps boolean in the frozen fact scalar schema", () => {
    expect(
      PublishedFactSchema.safeParse({
        name: "keywords.derived",
        value: true,
      }).success,
    ).toBe(true);
  });

  it("rejects an array disguised as document.media_type", async () => {
    const fixture = (await loadIngestionProducerFixture()) as {
      knowledgeUnits: Array<{
        facts: Array<{ name: string; value: unknown }>;
        contentDigest: string;
      }>;
      changes: Array<{ currentContentDigest?: string }>;
    };
    const unit = fixture.knowledgeUnits[0]!;
    const mediaType = unit.facts.find(
      (fact) => fact.name === "document.media_type",
    )!;
    mediaType.value = ["text/markdown"];
    unit.contentDigest = computePublishedKnowledgeUnitDigest(
      unit as PublishedKnowledgeUnit,
    );
    fixture.changes[0]!.currentContentDigest = unit.contentDigest;

    expect(() => parseIngestionPublication(fixture)).toThrow(
      ContractValidationError,
    );
  });

  it("accepts an empty initial snapshot and an exact all-removed successor", async () => {
    const previous = parseIngestionPublication(
      await loadIngestionProducerFixture(),
    );
    const emptyInitial = parseIngestionPublication({
      schemaVersion: 2,
      publicationId: "pub_empty_initial",
      sourceId: "src_empty",
      observationId: "obs_empty",
      producedAt: "2026-08-16T00:00:00.000Z",
      knowledgeUnits: [],
      changes: [],
    });
    expect(emptyInitial.knowledgeUnits).toEqual([]);

    const current = parseIngestionPublication({
      schemaVersion: 2,
      publicationId: "pub_all_removed",
      sourceId: previous.sourceId,
      observationId: "obs_all_removed",
      previousPublicationId: previous.publicationId,
      producedAt: "2026-08-16T00:01:00.000Z",
      knowledgeUnits: [],
      changes: computePublicationChanges(previous, []),
    });
    expect(() =>
      assertIngestionPublicationTransition(previous, current),
    ).not.toThrow();
    expect(current.changes).toEqual([
      {
        kind: "removed",
        knowledgeUnitId: "unit_payment_failures",
        previousContentDigest:
          previous.knowledgeUnits[0]!.contentDigest,
      },
    ]);
  });

  it("canonicalizes reordered root arrays without changing retry content", () => {
    const publication = parseIngestionPublication({
      schemaVersion: 2,
      publicationId: "pub_reordered_retry",
      sourceId: "src_payments",
      observationId: "obs_reordered_retry",
      previousPublicationId: "pub_predecessor",
      producedAt: "2026-08-16T00:01:30.000Z",
      knowledgeUnits: [],
      changes: [
        {
          kind: "removed",
          knowledgeUnitId: "unit_zeta",
          previousContentDigest: `sha256:${"2".repeat(64)}`,
        },
        {
          kind: "removed",
          knowledgeUnitId: "unit_alpha",
          previousContentDigest: `sha256:${"3".repeat(64)}`,
        },
      ],
    });

    expect(publication.changes.map((change) => change.knowledgeUnitId)).toEqual(
      ["unit_alpha", "unit_zeta"],
    );
  });

  it("preserves unchanged units byte-for-byte and rejects a false delta", async () => {
    const previous = parseIngestionPublication(
      await loadIngestionProducerFixture(),
    );
    const unchanged = parseIngestionPublication({
      schemaVersion: 2,
      publicationId: "pub_unchanged",
      sourceId: previous.sourceId,
      observationId: "obs_new",
      previousPublicationId: previous.publicationId,
      producedAt: "2026-08-16T00:02:00.000Z",
      knowledgeUnits: structuredClone(previous.knowledgeUnits),
      changes: [],
    });
    expect(() =>
      assertIngestionPublicationTransition(previous, unchanged),
    ).not.toThrow();

    const falseDelta = {
      ...unchanged,
      changes: [
        {
          kind: "updated",
          knowledgeUnitId: previous.knowledgeUnits[0]!.id,
          previousContentDigest: previous.knowledgeUnits[0]!.contentDigest,
          currentContentDigest: `sha256:${"1".repeat(64)}`,
          changedFields: ["facts"],
        },
      ],
    };
    expect(() =>
      assertIngestionPublicationTransition(
        previous,
        falseDelta as IngestionPublication,
      ),
    ).toThrow(ContractValidationError);
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
        parameters: [],
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
        schema: "public",
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
      parameters: [],
    };
    unit.publishedScopes = [
      {
        scopeId: "scope_payment_failures",
        scopeVersion: "scpv_aaaa",
        kind: "http_source",
        connector: "http.main",
        method: "DELETE",
        path: "/unrelated",
        parameters: [],
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
    fixture.schemaVersion = 1;

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
