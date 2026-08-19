import type { PublishedSourceCoordinateV2 as PublishedSourceCoordinate } from "@contextctl/contracts";
import { describe, expect, it } from "vitest";

import type { CardMeaning } from "../../src/domain/context-card.js";
import { groundCardVersion } from "../../src/domain/evidence-grounding.js";
import type {
  ManagedDocumentScope,
  RetrievalScope,
} from "../../src/domain/retrieval-scope.js";

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
    semanticUnitIds: ["unit_payment_failures"],
  },
};

const meaning: CardMeaning = {
  description: "환불 실패 결제의 재시도 정책",
  representativeQuestions: ["결제가 실패하면 언제 재시도되나요?"],
  aliases: ["payment retry"],
  keywords: ["payment", "retry"],
};

function rules(result: ReturnType<typeof groundCardVersion>): string[] {
  return result.outcome === "rejected"
    ? result.findings.map((finding) => finding.rule)
    : [];
}

describe("groundCardVersion", () => {
  it("validates a card whose scope matches the observed coordinate", () => {
    expect(
      groundCardVersion(documentCoordinate, [documentScope], meaning),
    ).toEqual({ outcome: "validated" });
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

    const result = groundCardVersion(sqlCoordinate, [scope], meaning);

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

    expect(rules(groundCardVersion(sqlCoordinate, [scope], meaning))).toEqual([
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

    expect(rules(groundCardVersion(httpCoordinate, [scope], meaning))).toEqual([
      "scope.http.path",
    ]);
  });

  it("rejects a document scope built from another document", () => {
    const scope: RetrievalScope = {
      ...documentScope,
      documentIndex: { ...documentScope.documentIndex, documentId: "doc_other" },
    };

    expect(
      rules(groundCardVersion(documentCoordinate, [scope], meaning)),
    ).toEqual(["scope.document.documentId"]);
  });

  it("rejects a semantic selection that omits the observed unit", () => {
    const scope: RetrievalScope = {
      ...documentScope,
      selection: { kind: "semantic_units", semanticUnitIds: ["unit_other"] },
    };

    expect(
      rules(groundCardVersion(documentCoordinate, [scope], meaning)),
    ).toEqual(["scope.document.semanticUnitIds"]);
  });

  it("rejects a scope kind incompatible with the coordinate", () => {
    expect(rules(groundCardVersion(sqlCoordinate, [documentScope], meaning))).toEqual(
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
      rules(groundCardVersion(documentCoordinate, [documentScope], blank)),
    ).toEqual(["meaning.description", "meaning.representativeQuestions"]);
  });

  it("rejects a card version that carries no scope at all", () => {
    expect(rules(groundCardVersion(documentCoordinate, [], meaning))).toEqual([
      "scope.present",
    ]);
  });

  describe("approved-card-read-v1 limits", () => {
    // Nothing here is truncated. A description cut mid-sentence still reads
    // like a description, so it would be served as if it were whole and the
    // operator who could have fixed it never learns it was too long.
    function ground(overrides: Partial<CardMeaning>) {
      return groundCardVersion(documentCoordinate, [documentScope], {
        ...meaning,
        ...overrides,
      });
    }

    it("rejects a description over 1,024 code units", () => {
      const result = ground({ description: "가".repeat(1_025) });

      expect(rules(result)).toContain("meaning.description");
      expect(result.outcome).toBe("rejected");
    });

    it("accepts a description exactly at the limit", () => {
      expect(ground({ description: "가".repeat(1_024) }).outcome).toBe(
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

      const result = groundCardVersion(documentCoordinate, scopes, meaning);

      expect(rules(result)).toContain("scope.count");
    });

    it("accepts exactly 64 scopes", () => {
      const scopes = Array.from({ length: 64 }, () => documentScope);

      expect(rules(groundCardVersion(documentCoordinate, scopes, meaning))).not.toContain(
        "scope.count",
      );
    });
  });
});
