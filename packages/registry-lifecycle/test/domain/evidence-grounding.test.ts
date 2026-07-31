import type { PublishedSourceCoordinate } from "@contextctl/contracts";
import { describe, expect, it } from "vitest";

import type { CardMeaning } from "../../src/domain/context-card.js";
import { groundCardVersion } from "../../src/domain/evidence-grounding.js";
import type { RetrievalScope } from "../../src/domain/retrieval-scope.js";

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
};

const documentScope: RetrievalScope = {
  kind: "managed_document",
  reference: { scopeId: "scope_payment_failures", scopeVersion: "scpv_aaaa" },
  documentIndex: {
    documentIndexId: "didx_payments",
    sourceId: "src_payments",
    documentId: "doc_payments",
    indexVersion: "idxv_aaaa",
    connectorId: "vector.local",
    accessHandle: "documents/payments/indexes/aaaa",
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
      table: "refunds",
      columns: ["status"],
    };

    expect(rules(groundCardVersion(sqlCoordinate, [scope], meaning))).toEqual([
      "scope.sql.table",
    ]);
  });

  it("rejects an HTTP scope whose method and path drifted from the source", () => {
    const scope: RetrievalScope = {
      kind: "http_source",
      reference: { scopeId: "scope_get_payment", scopeVersion: "scpv_dddd" },
      connector: "payments.api",
      method: "DELETE",
      path: "/payments",
    };

    expect(rules(groundCardVersion(httpCoordinate, [scope], meaning))).toEqual([
      "scope.http.method",
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
});
