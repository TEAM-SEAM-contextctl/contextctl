import { describe, expect, it } from "vitest";

import type { ApprovedCard } from "../../src/domain/card-catalog.js";
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
    // What does travel.
    expect(serialized).toContain("src_policy_docs");
    expect(serialized).toContain("doc_refund_policy");
    expect(serialized).toContain("scope_refund_policy_doc");
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
        },
        {
          kind: "http_source",
          reference: { scopeId: "scope_b", scopeVersion: "v1" },
          connector: "c",
          method: "GET",
          path: "/b",
        },
        {
          kind: "http_source",
          reference: { scopeId: "scope_a", scopeVersion: "v1" },
          connector: "c",
          method: "GET",
          path: "/a",
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
    const serialized = cardSelectionTextPayload(
      buildCardSelectionText(createPaymentsTableCard()),
    );

    // The SQL branch of the published schema names a `schema` field the approved
    // read model has no counterpart for. An empty string there would be a fact
    // nobody stated.
    expect(JSON.parse(serialized).scopes[0]).toEqual({
      kind: "sql",
      scopeId: "scope_payments_table",
      scopeVersion: "scopev_0001",
      connector: "postgres.main",
      table: "payments",
      columns: ["created_at", "failed_reason", "payment_id", "status"],
    });
  });

  it("keeps an HTTP Scope to the coordinates the read model carries", () => {
    const serialized = cardSelectionTextPayload(
      buildCardSelectionText(createPaymentApiCard()),
    );

    expect(JSON.parse(serialized).scopes[0]).toEqual({
      kind: "http",
      scopeId: "scope_payment_get",
      scopeVersion: "scopev_0001",
      connector: "payments.api",
      method: "GET",
      path: "/payments/{paymentId}",
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
    expect(entry.units).toBe([...entry.payload].length);
  });

  it("serializes object keys in canonical order regardless of build path", () => {
    const payload = cardSelectionTextPayload(
      buildCardSelectionText(createRefundPolicyCard()),
    );

    expect(payload.startsWith('{"aliases":')).toBe(true);
    expect(payload).toContain('"schema":"card-selection-text-v1"');
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
