import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type {
  ApprovedCard,
  ApprovedHttpParameter,
  ApprovedHttpScope,
  ApprovedScope,
  ApprovedSqlScope,
} from "../../src/domain/card-catalog.js";
import {
  buildCardSelectionEntry,
  buildCardSelectionText,
  CARD_SELECTION_TEXT_SCHEMA,
  cardSelectionTextDigest,
  cardSelectionTextPayload,
  normalizeSelectionText,
} from "../../src/domain/card-selection-text.js";
import {
  createPaymentApiCard,
  createPaymentsTableCard,
  createRefundPolicyCard,
} from "../fixtures/approved-card.fixture.js";

function cardWith(meaning: Partial<ApprovedCard["meaning"]>): ApprovedCard {
  const card = createRefundPolicyCard();
  return { ...card, meaning: { ...card.meaning, ...meaning } };
}

describe("buildCardSelectionText", () => {
  it("names the schema it was built under", () => {
    expect(buildCardSelectionText(createRefundPolicyCard()).schema).toBe(
      CARD_SELECTION_TEXT_SCHEMA,
    );
  });

  it("carries only declared meaning and public Scope coordinates", () => {
    const text = buildCardSelectionText(createRefundPolicyCard());
    const serialized = cardSelectionTextPayload(text);

    // The three fields a document Scope carries that a consumer never receives.
    // A vector outlives the request it was built for, so an infrastructure
    // coordinate inside one is a leak with no expiry.
    expect(serialized).not.toContain("vector.local");
    expect(serialized).not.toContain("documents/policies/indexes/refund");
    expect(serialized).not.toContain("docidx_refund_policy");
    // `indexVersion` stays out for a different reason: it moves on every
    // republication, and a Card's vector must not be invalidated because a
    // document it points at was reindexed.
    expect(serialized).not.toContain("idxv_0001");
    // Opaque managed-document identity remains on the approved Scope, not in
    // the semantic model input. The Card's declared language does travel.
    expect(serialized).not.toContain("src_policy_docs");
    expect(serialized).not.toContain("doc_refund_policy");
    expect(serialized).not.toContain("scope_refund_policy_doc");
    expect(serialized).toContain("환불 정책 문서");
  });

  it("normalizes to NFKC, collapses whitespace and trims", () => {
    // "ﾃｽﾄ" is half-width katakana; NFKC folds it onto "テスト".
    const text = buildCardSelectionText(
      cardWith({ description: "  ﾃｽﾄ\r\n\t 문서   설명  " }),
    );

    expect(text.description).toBe("テスト 문서 설명");
  });

  it("drops empty entries, deduplicates and orders by code point", () => {
    const text = buildCardSelectionText(
      cardWith({ keywords: ["환불", "", "  ", "refund", "환불", "배송비"] }),
    );

    expect(text.keywords).toEqual(["refund", "배송비", "환불"]);
  });

  it("treats an entry that differs only in normalization as one entry", () => {
    // U+AC00 composed, then the same syllable as U+1100 U+1161 decomposed.
    const text = buildCardSelectionText(
      cardWith({ aliases: ["가", "가"] }),
    );

    expect(text.aliases).toEqual(["가"]);
  });

  it("orders by code point rather than by UTF-16 code unit", () => {
    // U+FF21 (fullwidth A) folds to "A" under NFKC, so it is not a useful
    // probe; U+10000 is an astral character whose surrogate pair (U+D800…)
    // sorts *below* U+E000 under a code-unit comparison and above it under a
    // code-point one.
    const text = buildCardSelectionText(
      cardWith({ aliases: ["\u{10000}", "\uE000"] }),
    );

    expect(text.aliases).toEqual(["\uE000", "\u{10000}"]);
  });

  it("orders Scopes by scopeId then scopeVersion", () => {
    const card = createRefundPolicyCard();
    const withThreeScopes: ApprovedCard = {
      ...card,
      scopes: [
        {
          kind: "http_source",
          reference: { scopeId: "scope_b", scopeVersion: "v2" },
          connector: "c",
          method: "GET",
          path: "/b",
          operationId: "getB",
          parameters: [],
        },
        {
          kind: "http_source",
          reference: { scopeId: "scope_b", scopeVersion: "v1" },
          connector: "c",
          method: "GET",
          path: "/b",
          operationId: "getB",
          parameters: [],
        },
        {
          kind: "http_source",
          reference: { scopeId: "scope_a", scopeVersion: "v1" },
          connector: "c",
          method: "GET",
          path: "/a",
          operationId: "getA",
          parameters: [],
        },
      ],
    };

    expect(
      buildCardSelectionText(withThreeScopes).scopes.map(
        (scope) => `${scope.scopeId}/${scope.scopeVersion}`,
      ),
    ).toEqual(["scope_a/v1", "scope_b/v1", "scope_b/v2"]);
  });

  it("invents no field a Scope does not declare", () => {
    const text = buildCardSelectionText(createPaymentsTableCard());

    // Exhaustive rather than a containment check, and that is the whole test:
    // every field of the published SQL branch is either transcribed from a
    // field the approved read model declares, or it is not here at all. A
    // placeholder for one the model has no counterpart for would be a fact
    // nobody stated, embedded into a vector that outlives the Card.
    expect(text.scopes[0]).toEqual({
      kind: "sql",
      scopeId: "scope_payments_table",
      scopeVersion: "scopev_0001",
      connector: "postgres.main",
      schema: "public",
      table: "payments",
      columns: ["created_at", "failed_reason", "payment_id", "status"],
    });
  });

  it("keeps an HTTP Scope to the coordinates the read model carries", () => {
    const text = buildCardSelectionText(createPaymentApiCard());

    expect(text.scopes[0]).toEqual({
      kind: "http",
      scopeId: "scope_payment_get",
      scopeVersion: "scopev_0001",
      connector: "payments.api",
      method: "GET",
      path: "/payments/{paymentId}",
      operationId: "getPayment",
      parameters: [{ location: "path", name: "paymentId", required: true }],
    });
  });
});

describe("cardSelectionTextDigest", () => {
  it("is stable across two builds of the same Card", () => {
    expect(
      cardSelectionTextDigest(buildCardSelectionText(createRefundPolicyCard())),
    ).toBe(
      cardSelectionTextDigest(buildCardSelectionText(createRefundPolicyCard())),
    );
  });

  it("ignores the order a Card's own vocabulary was written in", () => {
    const card = createRefundPolicyCard();
    const reordered = cardWith({
      keywords: [...card.meaning.keywords].reverse(),
      aliases: [...card.meaning.aliases].reverse(),
    });

    // The identity of a Card is what it declares, not the sequence someone
    // typed it in. A digest that moved on a reorder would rebuild every vector
    // in the catalog for an edit that changed nothing.
    expect(cardSelectionTextDigest(buildCardSelectionText(reordered))).toBe(
      cardSelectionTextDigest(buildCardSelectionText(card)),
    );
  });

  it("moves when the declared meaning moves", () => {
    expect(
      cardSelectionTextDigest(
        buildCardSelectionText(cardWith({ keywords: ["환불", "취소"] })),
      ),
    ).not.toBe(
      cardSelectionTextDigest(buildCardSelectionText(createRefundPolicyCard())),
    );
  });

  it("is the digest of exactly the string that gets embedded", () => {
    const text = buildCardSelectionText(createRefundPolicyCard());
    const entry = buildCardSelectionEntry(createRefundPolicyCard());

    expect(entry.payload).toBe(cardSelectionTextPayload(text));
    expect(entry.selectionTextDigest).toBe(cardSelectionTextDigest(text));
    expect(entry.selectionTextDigest).toBe(
      `sha256:${createHash("sha256").update(entry.payload, "utf8").digest("hex")}`,
    );
    expect(entry.units).toBe([...entry.payload].length);
  });

  it("embeds normalized semantic lines without opaque schema syntax", () => {
    const payload = cardSelectionTextPayload(
      buildCardSelectionText(createRefundPolicyCard()),
    );

    expect(payload.startsWith("환불 정책 문서")).toBe(true);
    expect(payload).not.toContain("card-selection-text-v3");
    expect(payload).not.toContain("scope_refund_policy_doc");
  });
});

/**
 * The digest of a Card whose only Scope is the given one.
 *
 * Everything else about the Card is held fixed, so a difference between two of
 * these can have come from nothing but the field under test. Taken from
 * `buildCardSelectionEntry` rather than from `cardSelectionTextDigest` because
 * the entry is what a candidate index actually stores and compares: a collision
 * the text function avoided but the entry re-introduced would be invisible from
 * one layer up.
 */
function digestOfScope(scope: ApprovedScope): string {
  const card = createRefundPolicyCard();

  return buildCardSelectionEntry({ ...card, scopes: [scope] })
    .selectionTextDigest;
}

/** One SQL Scope, varying only in which schema inside the connector it names. */
function sqlScopeIn(schema: string): ApprovedSqlScope {
  return {
    kind: "sql_source",
    reference: { scopeId: "scope_payments", scopeVersion: "scopev_0001" },
    connector: "postgres.main",
    schema,
    table: "payments",
    columns: ["payment_id", "status"],
  };
}

/** One HTTP Scope on one path, varying only in what identifies the operation. */
function httpScopeOf(
  operationId: string | undefined,
  parameters: readonly ApprovedHttpParameter[],
): ApprovedHttpScope {
  return {
    kind: "http_source",
    reference: { scopeId: "scope_payment_get", scopeVersion: "scopev_0001" },
    connector: "payments.api",
    method: "GET",
    path: "/payments/{paymentId}",
    operationId,
    parameters,
  };
}

const PAYMENT_ID_PARAMETER: ApprovedHttpParameter = {
  location: "path",
  name: "paymentId",
  required: true,
};

/**
 * Two Scopes that differ in a coordinate must not embed as one Card.
 *
 * These are the cases the canonical text exists to keep apart, and each one was
 * a real collision before the coordinate it names was carried: two Cards
 * produced byte-identical text, therefore one digest, therefore one vector, and
 * the candidate index could not tell the two apart at all. A consumer handed
 * the resulting guide could not know which table it had been granted or which
 * of two operations on one path it was allowed to call — which is the one
 * question a coordinate has to answer.
 */
describe("Scope coordinate identity", () => {
  it("separates two tables that differ only by schema", () => {
    // `public.payments` and `analytics.payments` under one connector.
    expect(digestOfScope(sqlScopeIn("public"))).not.toBe(
      digestOfScope(sqlScopeIn("analytics")),
    );
  });

  it("separates two operations on one path that differ only by parameters", () => {
    const bySince = httpScopeOf("getPayment", [
      PAYMENT_ID_PARAMETER,
      { location: "query", name: "since", required: false },
    ]);
    const byStatus = httpScopeOf("getPayment", [
      PAYMENT_ID_PARAMETER,
      { location: "query", name: "status", required: false },
    ]);

    expect(digestOfScope(bySince)).not.toBe(digestOfScope(byStatus));
  });

  it("separates two operations that differ only by operationId", () => {
    expect(
      digestOfScope(httpScopeOf("getPayment", [PAYMENT_ID_PARAMETER])),
    ).not.toBe(
      digestOfScope(httpScopeOf("refundPayment", [PAYMENT_ID_PARAMETER])),
    );
  });

  it("carries an unnamed operation as an absent key, never as an empty one", () => {
    const entry = buildCardSelectionEntry({
      ...createRefundPolicyCard(),
      scopes: [httpScopeOf(undefined, [PAYMENT_ID_PARAMETER])],
    });
    const [scope] = entry.text.scopes;

    // A source that names no operation and one whose operation is called ""
    // are different logical records. Writing the second where the first is
    // meant would put a value in the vector that nobody declared.
    expect(Object.keys(scope as object)).not.toContain("operationId");
    expect(entry.payload).not.toContain("operationId");
    expect(entry.selectionTextDigest).not.toBe(
      digestOfScope(httpScopeOf("", [PAYMENT_ID_PARAMETER])),
    );
  });

  it("ignores the order the parameters were declared in", () => {
    const status: ApprovedHttpParameter = {
      location: "query",
      name: "status",
      required: false,
    };
    // The same set, written down the other way round. Declaration order is a
    // fact about how the Scope was typed, not about what it accepts, and a
    // digest that moved on a reorder would rebuild the Card's vector for an
    // edit that changed nothing — the same reason `columns` is sorted.
    expect(
      digestOfScope(httpScopeOf("getPayment", [PAYMENT_ID_PARAMETER, status])),
    ).toBe(
      digestOfScope(httpScopeOf("getPayment", [status, PAYMENT_ID_PARAMETER])),
    );
  });
});

describe("normalizeSelectionText", () => {
  it("applies the same rule a query and a Card are both transformed under", () => {
    expect(normalizeSelectionText("  휴가를\r\n  며칠  ")).toBe("휴가를 며칠");
  });

  it("leaves case alone", () => {
    // Unlike lexical scoring, which lowercases before matching substrings: an
    // encoder was trained on cased text and an acronym is a signal.
    expect(normalizeSelectionText("REFUND Policy")).toBe("REFUND Policy");
  });
});
