import type {
  PublishedFact,
  PublishedSourceCoordinate,
} from "@contextctl/contracts";
import { describe, expect, it } from "vitest";

import type { CardMeaning } from "../../src/domain/context-card.js";
import { groundCardVersion } from "../../src/domain/fact-grounding.js";
import type {
  ManagedDocumentScope,
  RetrievalScope,
} from "../../src/domain/retrieval-scope.js";

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

const documentScope: ManagedDocumentScope = {
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

/** The unit's observed facts, the closed vocabulary grounding checks against. */
const FACTS: readonly PublishedFact[] = [
  { name: "section.label", value: "Payment failures" },
];

/** The baseline origin: deterministic text needs no semantic review. */
const DETERMINISTIC = { generator: "deterministic" } as const;

const meaning: CardMeaning = {
  description: "환불 실패 결제의 재시도 정책",
  representativeQuestions: ["결제가 실패하면 언제 재시도되나요?"],
  aliases: ["payment retry"],
  keywords: ["payment", "retry"],
};

function rules(result: ReturnType<typeof groundCardVersion>): string[] {
  return result.findings.map((finding) => finding.rule);
}

describe("groundCardVersion", () => {
  it("validates a card whose scope matches the observed coordinate", () => {
    const report = groundCardVersion({
      coordinate: documentCoordinate,
      facts: FACTS,
      scopes: [documentScope],
      meaning,
      origin: DETERMINISTIC,
    });

    expect(report.verdict).toBe("validated");
    expect(report.findings).toEqual([]);
  });

  it("rejects a SQL column that the observed table does not have", () => {
    const scope: RetrievalScope = {
      kind: "sql_source",
      reference: { scopeId: "scope_payments_table", scopeVersion: "scpv_cccc" },
      connector: "postgres.main",
      schema: "public",
      table: "payments",
      columns: ["status", "card_number"],
    };

    const result = groundCardVersion({ coordinate: sqlCoordinate, facts: FACTS, scopes: [scope], meaning: meaning, origin: DETERMINISTIC });

    expect(rules(result)).toEqual(["scope.sql.columns"]);
  });

  it("rejects a SQL scope pointing at another table", () => {
    const scope: RetrievalScope = {
      kind: "sql_source",
      reference: { scopeId: "scope_payments_table", scopeVersion: "scpv_cccc" },
      connector: "postgres.main",
      schema: "public",
      table: "refunds",
      columns: ["status"],
    };

    expect(rules(groundCardVersion({ coordinate: sqlCoordinate, facts: FACTS, scopes: [scope], meaning: meaning, origin: DETERMINISTIC }))).toEqual([
      "scope.sql.table",
    ]);
  });

  // Only the path drifts here. This test used to drift the method too, but v2
  // pins `method` to the `GET` literal on both the coordinate and the Scope, so
  // a mismatch can no longer be constructed through the type — a stronger
  // guarantee than the assertion that was here. `checkHttpScope` still compares
  // the two at runtime, and that comparison now has no test: it is reachable
  // only from a stored row an older build wrote, and this file builds its
  // scopes in memory. Kept rather than deleted because the row reader does not
  // validate the verb either, so removing it would leave nothing checking it.
  it("rejects an HTTP scope whose path drifted from the source", () => {
    const scope: RetrievalScope = {
      kind: "http_source",
      reference: { scopeId: "scope_get_payment", scopeVersion: "scpv_dddd" },
      connector: "payments.api",
      method: "GET",
      path: "/payments",
      operationId: "getPayment",
      parameters: [],
    };

    expect(rules(groundCardVersion({ coordinate: httpCoordinate, facts: FACTS, scopes: [scope], meaning: meaning, origin: DETERMINISTIC }))).toEqual([
      "scope.http.path",
    ]);
  });

  it("rejects a document scope built from another document", () => {
    const scope: RetrievalScope = {
      ...documentScope,
      documentIndex: { ...documentScope.documentIndex, documentId: "doc_other" },
    };

    expect(
      rules(groundCardVersion({ coordinate: documentCoordinate, facts: FACTS, scopes: [scope], meaning: meaning, origin: DETERMINISTIC })),
    ).toEqual(["scope.document.documentId"]);
  });

  it("rejects a semantic selection that omits the observed unit", () => {
    const scope: RetrievalScope = {
      ...documentScope,
      selection: { kind: "semantic_units", semanticUnitIds: ["unit_01890f5c-7b1a-7211-8c3c-e592509dc531"] },
    };

    expect(
      rules(groundCardVersion({ coordinate: documentCoordinate, facts: FACTS, scopes: [scope], meaning: meaning, origin: DETERMINISTIC })),
    ).toEqual(["scope.document.semanticUnitIds"]);
  });

  it("rejects a scope kind incompatible with the coordinate", () => {
    expect(rules(groundCardVersion({ coordinate: sqlCoordinate, facts: FACTS, scopes: [documentScope], meaning: meaning, origin: DETERMINISTIC }))).toEqual(
      ["scope.kind"],
    );
  });

  it("rejects blank LLM-authored expression", () => {
    const blank: CardMeaning = {
      description: "   ",
      representativeQuestions: [],
      aliases: [],
      keywords: [],
    };

    expect(
      rules(groundCardVersion({ coordinate: documentCoordinate, facts: FACTS, scopes: [documentScope], meaning: blank, origin: DETERMINISTIC })),
    ).toEqual(["meaning.description", "meaning.representativeQuestions"]);
  });

  it("rejects a card version that carries no scope at all", () => {
    expect(rules(groundCardVersion({ coordinate: documentCoordinate, facts: FACTS, scopes: [], meaning: meaning, origin: DETERMINISTIC }))).toEqual([
      "scope.present",
    ]);
  });

  describe("approved-card-read-v1 limits", () => {
    // Nothing here is truncated. A description cut mid-sentence still reads
    // like a description, so it would be served as if it were whole and the
    // operator who could have fixed it never learns it was too long.
    function ground(overrides: Partial<CardMeaning>) {
      return groundCardVersion({ coordinate: documentCoordinate, facts: FACTS, scopes: [documentScope], meaning: {
        ...meaning,
        ...overrides,
      }, origin: DETERMINISTIC });
    }

    it("rejects a description over 1,024 code units", () => {
      const result = ground({ description: "가".repeat(1_025) });

      expect(rules(result)).toContain("meaning.description");
      expect(result.verdict).toBe("rejected");
    });

    it("accepts a description exactly at the limit", () => {
      expect(ground({ description: "가".repeat(1_024) }).verdict).toBe(
        "validated",
      );
    });

    it("rejects more than 16 representative questions", () => {
      const result = ground({
        representativeQuestions: Array.from(
          { length: 17 },
          (_value, index) => `질문 ${index}`,
        ),
      });

      expect(rules(result)).toContain("meaning.representativeQuestions");
    });

    it("rejects a single question over 512 code units", () => {
      const result = ground({ representativeQuestions: ["가".repeat(513)] });

      expect(rules(result)).toContain("meaning.representativeQuestions");
    });

    it("rejects more than 32 aliases and an alias over 128 units", () => {
      const tooMany = ground({
        aliases: Array.from({ length: 33 }, (_value, index) => `alias${index}`),
      });
      const tooLong = ground({ aliases: ["a".repeat(129)] });

      expect(rules(tooMany)).toContain("meaning.aliases");
      expect(rules(tooLong)).toContain("meaning.aliases");
    });

    it("rejects more than 64 keywords and a keyword over 64 units", () => {
      const tooMany = ground({
        keywords: Array.from({ length: 65 }, (_value, index) => `kw${index}`),
      });
      const tooLong = ground({ keywords: ["k".repeat(65)] });

      expect(rules(tooMany)).toContain("meaning.keywords");
      expect(rules(tooLong)).toContain("meaning.keywords");
    });

    it("rejects a blank entry inside an optional list", () => {
      // The list may be empty, but an entry that is present must say something.
      expect(rules(ground({ aliases: ["payments", "   "] }))).toContain(
        "meaning.aliases",
      );
    });

    it("rejects control characters anywhere in the meaning", () => {
      // They break canonical comparison, so a snapshot version would depend on
      // bytes no reader can see.
      expect(rules(ground({ description: "결제\u0007 실패" }))).toContain(
        "meaning.description",
      );
      expect(rules(ground({ keywords: ["pay\u0000ments"] }))).toContain(
        "meaning.keywords",
      );
    });

    it("rejects more than 64 scopes on one Card", () => {
      // Splitting the Card is the answer. A Card that silently covers fewer
      // scopes than it claims is worse than one an operator was told to split.
      const scopes = Array.from({ length: 65 }, (_value, index) => ({
        ...documentScope,
        reference: {
          scopeId: `scope_${index}`,
          scopeVersion: "scpv_aaaa",
        },
      }));

      const result = groundCardVersion({ coordinate: documentCoordinate, facts: FACTS, scopes: scopes, meaning: meaning, origin: DETERMINISTIC });

      expect(rules(result)).toContain("scope.count");
    });

    it("accepts exactly 64 scopes", () => {
      const scopes = Array.from({ length: 64 }, () => documentScope);

      expect(rules(groundCardVersion({ coordinate: documentCoordinate, facts: FACTS, scopes: scopes, meaning: meaning, origin: DETERMINISTIC }))).not.toContain(
        "scope.count",
      );
    });
  });

  describe("machine fragments are checked against the facts", () => {
    // The completion condition of SEAM-106 §6.4, as behaviour: identifiers,
    // numbers and enumerated values that look machine-readable must exist in
    // the unit's facts or coordinate. Values from another knowledge unit fail
    // the same way fabricated ones do — they are absent from *this* unit.
    const sqlFacts: readonly PublishedFact[] = [
      { name: "sql.approximate_row_count", value: 1200 },
      { name: "sql.columns", value: ["created_at", "failed_reason", "status"] },
    ];
    const sqlScope: RetrievalScope = {
      kind: "sql_source",
      reference: { scopeId: "scope_payments_table", scopeVersion: "scpv_cccc" },
      connector: "postgres.main",
      schema: "public",
      table: "payments",
      columns: ["failed_reason", "status"],
    };

    function groundSql(overrides: Partial<CardMeaning>) {
      return groundCardVersion({
        coordinate: sqlCoordinate,
        facts: sqlFacts,
        scopes: [sqlScope],
        meaning: { ...meaning, ...overrides },
        origin: DETERMINISTIC,
      });
    }

    it("accepts values that all exist in the facts and coordinate", () => {
      const report = groundSql({
        description: "public.payments 테이블의 failed_reason, 약 1200행",
      });

      expect(report.verdict).toBe("validated");
    });

    it("rejects a column carried over from a different knowledge unit", () => {
      // `shipment_status` is a real-looking column — of some other table. It is
      // absent from this unit's facts and coordinate, which is the only test a
      // deterministic checker can apply, and the right one: mixing units and
      // inventing values are the same defect seen from here.
      const report = groundSql({
        description: "payments 테이블은 shipment_status 컬럼을 담는다",
      });

      expect(report.verdict).toBe("rejected");
      expect(report.findings).toEqual([
        expect.objectContaining({
          rule: "meaning.fabricatedValue",
          severity: "fatal",
        }),
      ]);
    });

    it("rejects an altered number", () => {
      // The observed row count is 1200. A description that says 8000 reads as
      // authoritative and is checkable — so it is checked.
      const report = groundSql({ description: "약 8000행을 담는 테이블" });

      expect(report.verdict).toBe("rejected");
      expect(report.findings[0]?.message).toContain("8000");
    });

    it("rejects an enumerated value the coordinate contradicts", () => {
      const report = groundCardVersion({
        coordinate: httpCoordinate,
        facts: [{ name: "http.operation_id", value: "getPayment" }],
        scopes: [
          {
            kind: "http_source",
            reference: { scopeId: "scope_get_payment", scopeVersion: "scpv_dddd" },
            connector: "payments.api",
            method: "GET",
            path: "/payments/{id}",
            operationId: "getPayment",
            parameters: [{ location: "path", name: "id", required: true }],
          },
        ],
        meaning: { ...meaning, description: "POST /payments/{id} 를 호출한다" },
        origin: DETERMINISTIC,
      });

      expect(report.verdict).toBe("rejected");
      expect(report.findings[0]?.message).toContain("POST");
    });

    it("does not reject prose for being prose", () => {
      // Sentences in any language carry no machine-shaped token, so nothing is
      // extracted and nothing can be fabricated.
      const report = groundSql({
        description: "결제 실패가 기록되는 곳을 설명하는 문서",
      });

      expect(report.verdict).toBe("validated");
    });
  });

  describe("three-way verdict and coverage", () => {
    it("marks model-authored expression for review, never plain validated", () => {
      // Structure and facts check out, and the verdict still is not
      // `validated`: a machine cannot prove the model's sentence faithful, so
      // the judgement is recorded as pending. Auto-approval of a model version
      // is impossible twice over — promotion is an operator command, and now
      // the report says review even before anyone reads the text.
      const report = groundCardVersion({
        coordinate: documentCoordinate,
        facts: FACTS,
        scopes: [documentScope],
        meaning,
        origin: { generator: "model", model: "gemma4-12b-qat" },
      });

      expect(report.verdict).toBe("needs_review");
      expect(report.findings).toEqual([
        expect.objectContaining({ rule: "meaning.modelAuthored", severity: "review" }),
      ]);
      expect(report.origin).toEqual({
        generator: "model",
        model: "gemma4-12b-qat",
      });
    });

    it("counts a fact as covered only when its value appears in the text", () => {
      const report = groundCardVersion({
        coordinate: documentCoordinate,
        facts: [
          { name: "section.label", value: "Payment failures" },
          { name: "document.title", value: "운영 안내" },
        ],
        scopes: [documentScope],
        meaning: {
          ...meaning,
          description: "운영 안내 문서의 결제 절",
        },
        origin: DETERMINISTIC,
      });

      // Informational, not a gate: coverage tells the reviewing operator what
      // the text reflects, and the glossary forbids using it as approval basis.
      expect(report.factCoverage).toEqual({
        covered: ["document.title"],
        uncovered: ["section.label"],
      });
      expect(report.verdict).toBe("validated");
    });
  });
});
