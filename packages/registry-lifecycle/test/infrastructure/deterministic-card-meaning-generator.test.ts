import type {
  PublishedFact,
  PublishedSourceCoordinate,
} from "@contextctl/contracts";
import { describe, expect, it } from "vitest";

import { claimPublication } from "../../src/application/claim-publication.js";
import { groundCardVersion } from "../../src/domain/fact-grounding.js";
import type { RetrievalScope } from "../../src/domain/retrieval-scope.js";
import { DeterministicCardMeaningGenerator } from "../../src/infrastructure/deterministic-card-meaning-generator.js";
import {
  createHttpPublicationFixture,
  createIngestionPublicationFixture,
  createSqlPublicationFixture,
} from "../fixtures/ingestion-publication.fixture.js";

const generator = new DeterministicCardMeaningGenerator();

const documentCoordinate: PublishedSourceCoordinate = {
  kind: "document",
  sourceId: "src_payments",
  documentId: "doc_payments",
  semanticUnitId: "unit_payment_failures",
};

const sqlCoordinate: PublishedSourceCoordinate = {
  kind: "sql_table",
  sourceId: "src_payments_db",
  schema: "public",
  table: "payments",
  columns: ["created_at", "failed_reason", "status"],
};

const httpCoordinate: PublishedSourceCoordinate = {
  kind: "http_operation",
  sourceId: "src_payments_api",
  method: "GET",
  path: "/payments/{id}",
  operationId: "getPayment",
  parameters: [{ location: "path", name: "id", required: true }],
};

const documentScope: RetrievalScope = {
  kind: "managed_document",
  reference: { scopeId: "scope_payment_failures", scopeVersion: "scpv_aaaa" },
  documentIndex: {
    documentIndexId: "didx_payments",
    sourceId: "src_payments",
    documentId: "doc_payments",
    indexVersion: "idxv_aaaa",
  },
  selection: {
    kind: "semantic_units",
    semanticUnitIds: ["unit_payment_failures"],
  },
};

const sqlScope: RetrievalScope = {
  kind: "sql_source",
  reference: { scopeId: "scope_payments_table", scopeVersion: "scpv_cccc" },
  connector: "postgres.main",
  schema: "public",
  table: "payments",
  columns: ["failed_reason", "status"],
};

const httpScope: RetrievalScope = {
  kind: "http_source",
  reference: { scopeId: "scope_get_payment", scopeVersion: "scpv_dddd" },
  connector: "payments.api",
  method: "GET",
  path: "/payments/{id}",
  operationId: "getPayment",
  parameters: [{ location: "path", name: "id", required: true }],
};

// Fact names are a closed vocabulary in v2, so a test cannot invent one. That
// is the point: grounding checks a generated identifier against a name it knows.
const summary: PublishedFact = {
  name: "section.label",
  value: "Failed payments are retried after five minutes.",
};

describe("DeterministicCardMeaningGenerator", () => {
  it("produces meaning that passes grounding for a document coordinate", async () => {
    const meaning = await generator.generate({
      coordinate: documentCoordinate,
      facts: [summary],
    });

    expect(groundCardVersion(documentCoordinate, [documentScope], meaning)).toEqual(
      { outcome: "validated" },
    );
    expect(meaning.description).toContain("doc_payments");
    expect(meaning.description).toContain(
      "Failed payments are retried after five minutes.",
    );
  });

  it("produces meaning that passes grounding for a table coordinate", async () => {
    const meaning = await generator.generate({
      coordinate: sqlCoordinate,
      facts: [{ name: "sql.approximate_row_count", value: 1200 }],
    });

    expect(groundCardVersion(sqlCoordinate, [sqlScope], meaning)).toEqual({
      outcome: "validated",
    });
    expect(meaning.aliases).toContain("public.payments");
    expect(meaning.keywords).toContain("failed");
    expect(meaning.keywords).toContain("reason");
  });

  it("produces meaning that passes grounding for an operation coordinate", async () => {
    const meaning = await generator.generate({
      coordinate: httpCoordinate,
      facts: [{ name: "http.operation_id", value: "getPayment" }],
    });

    expect(groundCardVersion(httpCoordinate, [httpScope], meaning)).toEqual({
      outcome: "validated",
    });
    expect(meaning.aliases).toContain("GET /payments/{id}");
  });

  it("still passes grounding when evidence carries only one bare fact", async () => {
    const meaning = await generator.generate({
      coordinate: documentCoordinate,
      facts: [{ name: "section.path", value: "" }],
    });

    // Grounding needs a non-blank description and one non-blank question; both
    // come from the coordinate, so thin evidence cannot starve them.
    expect(meaning.description.trim()).not.toBe("");
    expect(meaning.representativeQuestions).toHaveLength(1);
    expect(meaning.representativeQuestions[0]?.trim()).not.toBe("");
    expect(
      groundCardVersion(documentCoordinate, [documentScope], meaning),
    ).toEqual({ outcome: "validated" });
  });

  it("returns the same meaning for the same request", async () => {
    const request = { coordinate: sqlCoordinate, facts: [summary] };

    expect(await generator.generate(request)).toEqual(
      await generator.generate(request),
    );
  });

  it("flattens a list-valued fact instead of printing an object", async () => {
    const meaning = await generator.generate({
      coordinate: sqlCoordinate,
      facts: [{ name: "sql.columns", value: ["failed", "paid"] }],
    });

    expect(meaning.description).toContain("failed, paid");
    expect(meaning.description).not.toContain("[object Object]");
  });

  it("names nothing the request did not contain", async () => {
    const facts = [summary];
    const meaning = await generator.generate({
      coordinate: sqlCoordinate,
      facts,
    });
    const supplied = JSON.stringify({
      coordinate: sqlCoordinate,
      facts,
    }).toLowerCase();

    // Every keyword is a token lifted from the request, so the generator cannot
    // introduce a table, column, or path the source does not have.
    for (const keyword of meaning.keywords) {
      expect(supplied).toContain(keyword);
    }
    // Aliases may join supplied parts — `public.payments` is schema plus table —
    // so they are checked token by token rather than whole.
    for (const alias of meaning.aliases) {
      for (const token of alias.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
        if (token !== "") {
          expect(supplied).toContain(token);
        }
      }
    }
  });
});

describe("consuming a publication with no model behind the generator", () => {
  function createPorts(publication: ReturnType<typeof createSqlPublicationFixture>) {
    const processed = new Set<string>();
    let nextId = 0;
    return {
      publications: {
        findById: async (id: string) =>
          id === publication.publicationId ? publication : undefined,
      },
      checkpoints: {
        hasProcessed: async (id: string) => processed.has(id),
        findCursor: async () => undefined,
        markProcessed: async (cursor: { publicationId: string }) => {
          processed.add(cursor.publicationId);
        },
        listCursors: async () => [],
      },
      meanings: generator,
      clock: { now: () => "2026-08-10T00:00:00.000Z" },
      ids: {
        nextId: () => {
          nextId += 1;
          return `cv_${nextId}`;
        },
      },
    };
  }

  // This is the reason the generator exists: claimPublication requires the port,
  // so before it existed Registry could not consume anything at all.
  it.each([
    ["markdown", createIngestionPublicationFixture()],
    ["postgres", createSqlPublicationFixture()],
    ["openapi", createHttpPublicationFixture()],
  ])("validates a %s publication end to end", async (_source, publication) => {
    const result = await claimPublication(
      createPorts(publication),
      publication.publicationId,
    );

    if (result.status !== "claimed") {
      throw new Error("expected the publication to be claimed");
    }
    expect(result.cardVersions).toHaveLength(1);
    expect(result.cardVersions[0]?.version.validationState).toBe("validated");
    expect(result.cardVersions[0]?.findings).toEqual([]);
  });
});
