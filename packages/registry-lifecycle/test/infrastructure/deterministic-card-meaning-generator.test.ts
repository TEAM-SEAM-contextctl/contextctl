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
  semanticUnitId: "unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd",
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
    semanticUnitIds: ["unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd"],
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
    const { meaning } = await generator.generate({
      coordinate: documentCoordinate,
      facts: [summary],
    });

    expect(
      groundCardVersion({
        coordinate: documentCoordinate,
        facts: [summary],
        scopes: [documentScope],
        meaning,
        origin: { generator: "deterministic" },
      }).verdict,
    ).toBe("validated");
    expect(meaning.description).not.toContain("doc_payments");
    expect(meaning.description).toContain(
      "Failed payments are retried after five minutes.",
    );
    expect(meaning.representativeQuestions).toEqual([
      "Failed payments are retried after five minutes?",
    ]);
  });

  it("produces meaning that passes grounding for a table coordinate", async () => {
    const { meaning } = await generator.generate({
      coordinate: sqlCoordinate,
      facts: [{ name: "sql.approximate_row_count", value: 1200 }],
    });

    expect(
      groundCardVersion({
        coordinate: sqlCoordinate,
        facts: [{ name: "sql.approximate_row_count", value: 1200 }],
        scopes: [sqlScope],
        meaning,
        origin: { generator: "deterministic" },
      }).verdict,
    ).toBe("validated");
    expect(meaning.aliases).toContain("public.payments");
    expect(meaning.keywords).toContain("failed");
    expect(meaning.keywords).toContain("reason");
  });

  it("produces meaning that passes grounding for an operation coordinate", async () => {
    const { meaning } = await generator.generate({
      coordinate: httpCoordinate,
      facts: [{ name: "http.operation_id", value: "getPayment" }],
    });

    expect(
      groundCardVersion({
        coordinate: httpCoordinate,
        facts: [{ name: "http.operation_id", value: "getPayment" }],
        scopes: [httpScope],
        meaning,
        origin: { generator: "deterministic" },
      }).verdict,
    ).toBe("validated");
    expect(meaning.aliases).toContain("GET /payments/{id}");
  });

  it("still passes grounding when evidence carries only one bare fact", async () => {
    const { meaning } = await generator.generate({
      coordinate: documentCoordinate,
      facts: [{ name: "section.path", value: "" }],
    });

    // Grounding needs a non-blank description and one non-blank question; both
    // come from the coordinate, so thin evidence cannot starve them.
    expect(meaning.description.trim()).not.toBe("");
    expect(meaning.representativeQuestions).toHaveLength(1);
    expect(meaning.representativeQuestions[0]?.trim()).not.toBe("");
    expect(
      groundCardVersion({
        coordinate: documentCoordinate,
        facts: [{ name: "section.path", value: "" }],
        scopes: [documentScope],
        meaning,
        origin: { generator: "deterministic" },
      }).verdict,
    ).toBe("validated");
  });

  it("returns the same meaning for the same request", async () => {
    const request = { coordinate: sqlCoordinate, facts: [summary] };

    expect(await generator.generate(request)).toEqual(
      await generator.generate(request),
    );
  });

  it("flattens a list-valued fact instead of printing an object", async () => {
    const { meaning } = await generator.generate({
      coordinate: sqlCoordinate,
      facts: [{ name: "sql.columns", value: ["failed", "paid"] }],
    });

    expect(meaning.description).toContain("failed, paid");
    expect(meaning.description).not.toContain("[object Object]");
  });

  it("names nothing the request did not contain", async () => {
    const facts = [summary];
    const { meaning } = await generator.generate({
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

describe("keywords and aliases carry the words a person wrote", () => {
  const sectionFacts: readonly PublishedFact[] = [
    { name: "document.media_type", value: "text/markdown" },
    { name: "document.title", value: "결제 운영 안내" },
    { name: "section.label", value: "환불 처리" },
    { name: "section.path", value: ["결제 운영 안내", "환불 처리"] },
    { name: "structure.block_count", value: 2 },
    { name: "structure.block_kinds", value: ["heading", "paragraph"] },
    { name: "unit.kind", value: "section" },
  ];

  it("tokenizes the Korean title, label and path into keywords", async () => {
    const { meaning } = await generator.generate({
      coordinate: documentCoordinate,
      facts: sectionFacts,
    });

    expect(meaning.keywords).toEqual(["결제", "안내", "운영", "처리", "환불"]);
  });

  it("keeps machine-measured facts and fact names out of the keywords", async () => {
    const { meaning } = await generator.generate({
      coordinate: documentCoordinate,
      facts: sectionFacts,
    });

    // Values a parser measured are true of every Card and select none; the
    // fact names split into `document`, `title`, `block`, `count` used to be
    // keywords too, and matched every document on any English query.
    for (const noise of [
      "markdown", "text", "heading", "paragraph", "section", "2",
      "document", "title", "label", "path", "structure", "block", "count",
      "kind", "kinds", "media", "type", "unit",
    ]) {
      expect(meaning.keywords).not.toContain(noise);
    }
  });

  it("keeps document and unit identifiers out of the keywords", async () => {
    const { meaning } = await generator.generate({
      coordinate: documentCoordinate,
      facts: sectionFacts,
    });

    // Nobody queries for a system identifier, and its `doc`/`unit` prefix was
    // matching inside unrelated English words.
    expect(meaning.keywords).not.toContain("doc");
    expect(meaning.keywords).not.toContain("payments");
    expect(meaning.keywords).not.toContain("unit");
    expect(meaning.keywords).not.toContain("payment");
    expect(meaning.keywords).not.toContain("failures");
  });

  it("includes derived keywords when Ingestion publishes them", async () => {
    const { meaning } = await generator.generate({
      coordinate: documentCoordinate,
      facts: [
        ...sectionFacts,
        { name: "keywords.derived", value: ["3~5영업일", "계좌이체", "카드"] },
      ],
    });

    expect(meaning.keywords).toEqual(
      expect.arrayContaining(["5영업일", "계좌이체", "카드", "환불"]),
    );
    // `3~5영업일` splits into `3` and `5영업일`; the bare digit is dropped.
    expect(meaning.keywords).not.toContain("3");
  });

  it("drops a token that is digits alone", async () => {
    const { meaning } = await generator.generate({
      coordinate: documentCoordinate,
      facts: [
        { name: "section.label", value: "반차" },
        { name: "keywords.derived", value: ["0.5", "15", "2시간", "30분", "3~5영업일", "연차"] },
      ],
    });

    // Bare numbers match by substring inside any order number, time or count
    // a query happens to carry, so none of them may become a keyword.
    for (const digits of ["0", "5", "15", "30", "3"]) {
      expect(meaning.keywords).not.toContain(digits);
    }
    // A number with its unit is a word a person types for this area.
    expect(meaning.keywords).toEqual(
      expect.arrayContaining(["2시간", "30분", "5영업일", "반차", "연차"]),
    );
  });

  it("keeps identifier tokens that mix letters and digits", async () => {
    const { meaning } = await generator.generate({
      coordinate: {
        ...sqlCoordinate,
        columns: ["v2_flag", "col_2023", "status"],
      },
      facts: [],
    });

    expect(meaning.keywords).toEqual(
      expect.arrayContaining(["v2", "flag", "col", "status", "payments", "public"]),
    );
    expect(meaning.keywords).not.toContain("2023");
  });

  it("does not let a dropped digit token take a slot under the ceiling", async () => {
    const words = Array.from({ length: 62 }, (_, index) => `파생${String(index).padStart(2, "0")}`);
    const digits = Array.from({ length: 10 }, (_, index) => String(index + 1));
    const { meaning } = await generator.generate({
      coordinate: documentCoordinate,
      facts: [
        { name: "section.label", value: "환불 처리" },
        { name: "keywords.derived", value: [...digits, ...words] },
      ],
    });

    // Two label tokens plus 62 words is exactly the ceiling; the ten digits
    // were dropped before the count, so no word fell off to make room for them.
    expect(meaning.keywords).toHaveLength(64);
    expect(meaning.keywords).toContain("파생61");
    expect(meaning.keywords.some((keyword) => /^\p{N}+$/u.test(keyword))).toBe(false);
  });

  it("uses human document names as aliases without opaque coordinates", async () => {
    const { meaning } = await generator.generate({
      coordinate: documentCoordinate,
      facts: sectionFacts,
    });

    expect(meaning.aliases).toEqual(["결제 운영 안내", "환불 처리"]);
    expect(meaning.representativeQuestions).toEqual(["환불 처리?"]);
    expect(meaning.description).toBe("결제 운영 안내 · 환불 처리");
    expect(meaning.description).not.toContain("structure.block_count");
  });

  it("still takes a table's schema, name and columns as keywords", async () => {
    const { meaning } = await generator.generate({
      coordinate: sqlCoordinate,
      facts: [],
    });

    expect(meaning.keywords).toEqual([
      "at", "created", "failed", "payments", "public", "reason", "status",
    ]);
  });

  it("takes an HTTP path but not the method as keywords", async () => {
    const { meaning } = await generator.generate({
      coordinate: httpCoordinate,
      facts: [],
    });

    expect(meaning.keywords).toEqual(["id", "payments"]);
    // The method stays where it was: on the alias a person can cite.
    expect(meaning.aliases).toContain("GET /payments/{id}");
  });

  it("produces the same keywords whatever order the facts arrive in", async () => {
    const { meaning: forward } = await generator.generate({
      coordinate: documentCoordinate,
      facts: sectionFacts,
    });
    const { meaning: reversed } = await generator.generate({
      coordinate: documentCoordinate,
      facts: [...sectionFacts].reverse(),
    });

    expect(reversed.keywords).toEqual(forward.keywords);
    expect(reversed.aliases).toEqual(forward.aliases);
  });

  it("caps keywords at the read-model ceiling, keeping the heading words", async () => {
    const derived = Array.from({ length: 80 }, (_, index) => `파생${String(index).padStart(2, "0")}`);
    const { meaning } = await generator.generate({
      coordinate: sqlCoordinate,
      facts: [
        { name: "section.label", value: "환불 처리" },
        { name: "keywords.derived", value: derived },
      ],
    });

    expect(meaning.keywords).toHaveLength(64);
    // Filled by priority — label, then derived — before the cut, so the label
    // survives and the coordinate tokens are what fell off the end.
    expect(meaning.keywords).toContain("환불");
    expect(meaning.keywords).toContain("처리");
    expect(meaning.keywords).not.toContain("payments");
    // Sorted afterwards, so the cut never depends on input order.
    expect(meaning.keywords).toEqual([...meaning.keywords].sort());
    // And the same 64 every time.
    expect(
      (await generator.generate({
        coordinate: sqlCoordinate,
        facts: [
          { name: "keywords.derived", value: [...derived].reverse() },
          { name: "section.label", value: "환불 처리" },
        ],
      })).meaning.keywords,
    ).toEqual(meaning.keywords);
  });

  it("drops a token over 64 code units rather than cutting it", async () => {
    const long = "가".repeat(65);
    const { meaning } = await generator.generate({
      coordinate: documentCoordinate,
      facts: [{ name: "section.label", value: `${long} 환불` }],
    });

    expect(meaning.keywords).toEqual(["환불"]);
    expect(meaning.keywords.some((keyword) => keyword.length > 64)).toBe(false);
  });

  it("drops an alias over 128 code units rather than cutting it", async () => {
    const long = "가".repeat(129);
    const { meaning } = await generator.generate({
      coordinate: documentCoordinate,
      facts: [{ name: "section.label", value: long }],
    });

    expect(meaning.aliases).toEqual(["doc_payments", "unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd"]);
  });

  it("passes grounding with Korean headings in the matched lists", async () => {
    const { meaning } = await generator.generate({
      coordinate: documentCoordinate,
      facts: sectionFacts,
    });

    expect(
      groundCardVersion({
        coordinate: documentCoordinate,
        // The same facts the generator consumed: grounding checks the text
        // against what it was written from, and `structure.block_count` puts a
        // bare number in the description that only these facts account for.
        facts: sectionFacts,
        scopes: [documentScope],
        meaning,
        origin: { generator: "deterministic" },
      }).verdict,
    ).toBe("validated");
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
