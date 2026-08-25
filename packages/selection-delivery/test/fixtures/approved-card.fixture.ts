import type { ApprovedCard } from "../../src/domain/card-catalog.js";

/**
 * The three approved Cards the demo selects over, one per Scope kind.
 *
 * Each factory takes no arguments and builds a fresh object every call, so a
 * test that mutates or narrows a returned Card cannot leak into the next one.
 */

/**
 * The one query the demo Card set is written against.
 *
 * It lives here rather than in each suite because the same literal was declared
 * separately in six test files: changing the query in one place left the others
 * scoring against the old wording, and nothing failed loudly enough to say so.
 * A demo Card set and the query those Cards are designed to answer are one pair
 * that has to move together, so they are declared together.
 *
 * Each of the three Cards below matches a different clause of it: "환불 불가"
 * reaches the policy document, "결제 실패 내역" reaches the payments table, and
 * "결제 상태 조회" reaches the lookup API.
 */
export const DEMO_QUERY =
  "환불 불가 상품과 결제 실패 내역, 그리고 결제 상태 조회 방법을 알려줘";

/**
 * A query from a domain no demo Card covers, used as a negative control.
 *
 * Widening a Card's vocabulary until it is admitted and a Card being admitted
 * because it can actually answer produce the same observation — an admitted
 * Card — so the difference has to be measured somewhere else. Asserting that
 * *no* Card is admitted for an unrelated query is that measurement: it fails
 * the moment a keyword is broad enough to catch text the Card cannot answer,
 * which is exactly the failure the product claims to avoid.
 *
 * None of the three Cards' keywords or aliases occurs in this text, so every
 * score falls back to the indirect signals and stays under the admit threshold.
 */
export const UNRELATED_QUERY = "사내 연차 규정과 휴가 신청 절차를 알려줘";

/** Managed document Card. Answers refund eligibility questions. */
export function createRefundPolicyCard(): ApprovedCard {
  return {
    cardId: "card_refund_policy",
    versionId: "cardv_refund_policy_v1",
    meaning: {
      description:
        "환불 정책 문서 — 환불 가능 기간, 환불 불가 상품, 배송비 처리 규정",
      representativeQuestions: [
        "환불이 불가능한 상품은 무엇인가요?",
        "환불 가능 기간은 며칠인가요?",
      ],
      aliases: ["refund policy", "반품 정책"],
      keywords: ["환불", "반품", "refund", "배송비"],
    },
    policy: { sensitive: false, allowedUsage: ["retrieval"] },
    scopes: [
      {
        kind: "managed_document",
        reference: {
          scopeId: "scope_refund_policy_doc",
          scopeVersion: "scopev_0001",
        },
        documentIndex: {
          documentIndexId: "docidx_refund_policy",
          sourceId: "src_policy_docs",
          documentId: "doc_refund_policy",
          indexVersion: "idxv_0001",
        },
        selection: { kind: "document" },
      },
    ],
  };
}

/**
 * SQL Card. Answers what went wrong with past payments.
 *
 * Its vocabulary is deliberately narrower than the lookup API's: the bare word
 * "결제" belongs to `createPaymentApiCard`, and declaring it here too would drag
 * this table into every query that merely mentions payment. This table answers
 * "which payments failed, and why", not "what is the status of this payment",
 * so both declared keywords carry the "실패" the table can actually account for.
 */
export function createPaymentsTableCard(): ApprovedCard {
  return {
    cardId: "card_payments_table",
    versionId: "cardv_payments_table_v1",
    meaning: {
      description: "결제 내역 테이블 — 결제별 상태와 실패 사유, 발생 시각",
      representativeQuestions: [
        "결제 실패 내역은 어디에서 확인하나요?",
        "실패한 결제의 사유는 무엇인가요?",
      ],
      aliases: ["payment failures"],
      keywords: ["결제 실패", "실패 내역"],
    },
    policy: { sensitive: false, allowedUsage: ["retrieval"] },
    scopes: [
      {
        kind: "sql_source",
        reference: {
          scopeId: "scope_payments_table",
          scopeVersion: "scopev_0001",
        },
        connector: "postgres.main",
        schema: "public",
        table: "payments",
        columns: ["created_at", "failed_reason", "payment_id", "status"],
      },
    ],
  };
}

/** HTTP Card. Answers payment lookup questions. */
export function createPaymentApiCard(): ApprovedCard {
  return {
    cardId: "card_payment_api",
    versionId: "cardv_payment_api_v1",
    meaning: {
      description: "결제 단건 조회 API — 결제 상태와 실패 사유 조회",
      representativeQuestions: ["특정 결제의 상태를 조회하려면 어떻게 하나요?"],
      aliases: ["payment lookup", "결제 상태 조회"],
      keywords: ["결제", "payment", "실패"],
    },
    policy: { sensitive: false, allowedUsage: ["retrieval"] },
    scopes: [
      {
        kind: "http_source",
        reference: {
          scopeId: "scope_payment_get",
          scopeVersion: "scopev_0001",
        },
        connector: "payments.api",
        method: "GET",
        path: "/payments/{paymentId}",
        operationId: "getPayment",
        parameters: [{ location: "path", name: "paymentId", required: true }],
      },
    ],
  };
}

/** The full demo catalog, in a stable order. */
export function createDemoCardSet(): readonly ApprovedCard[] {
  return [
    createRefundPolicyCard(),
    createPaymentsTableCard(),
    createPaymentApiCard(),
  ];
}

/**
 * The query the four Cards below are written against, and the reason they are
 * separate from the demo set.
 *
 * A test about what a resolution *serializes* needs every Scope kind and every
 * `fulfillment` state present at once, and the demo Cards only reach that under
 * a widened threshold band — which made the serialization suite depend on the
 * exact number `card_payment_api` happens to score. A scoring heuristic that
 * moved would then break tests about serialization.
 *
 * Each Card declares a distinct multi-token alias that appears in the query
 * literally. Exact aliases are explicit selection evidence under the shipped
 * policy, so all four are admitted without making this serialization fixture
 * depend on a calibrated BM25 or semantic score.
 *
 * The terms are distinct enough that none is a substring of another, so each
 * Card matches on its own word rather than on a neighbour's.
 */
export const ALL_OUTCOMES_QUERY =
  "환불 정책 문서와 재고 원장 표, 결제 조회 엔드포인트, 그리고 유실된 색인 문서를 한 번에 확인한다";

/**
 * Managed document Card that resolves to `fulfilled`.
 *
 * Its Scope is `scope_indexed_document`, one of the two
 * `createRefundPolicyChunkMap()` registers, so the fixture executor answers it
 * with the refund policy chunks. Its physical binding is deliberately
 * non-empty: the serialization tests assert these values never reach a
 * consumer, and an exclusion check over a Card that never carried them proves
 * nothing.
 */
export function createIndexedDocumentCard(): ApprovedCard {
  return {
    cardId: "card_indexed_document",
    versionId: "cardv_indexed_document_v1",
    meaning: {
      description: "환불 정책 문서의 색인 — 우리가 발행하고 색인한 문서다",
      representativeQuestions: ["환불정책문서에는 무엇이 적혀 있나요?"],
      aliases: ["indexed policy document", "환불 정책 문서"],
      keywords: ["환불정책문서"],
    },
    policy: { sensitive: false, allowedUsage: ["retrieval"] },
    scopes: [
      {
        kind: "managed_document",
        reference: {
          scopeId: "scope_indexed_document",
          scopeVersion: "scopev_0001",
        },
        documentIndex: {
          documentIndexId: "docidx_refund_policy",
          sourceId: "src_policy_docs",
          documentId: "doc_refund_policy",
          indexVersion: "idxv_0001",
        },
        selection: { kind: "document" },
      },
    ],
  };
}

/** SQL Card that resolves to `delegated`: we hand over coordinates, never run them. */
export function createLedgerTableCard(): ApprovedCard {
  return {
    cardId: "card_ledger_table",
    versionId: "cardv_ledger_table_v1",
    meaning: {
      description: "재고 원장 테이블 — 상품별 입출고 이력",
      representativeQuestions: ["재고원장에서 입출고 이력을 어떻게 보나요?"],
      aliases: ["inventory ledger", "재고 원장"],
      keywords: ["재고원장"],
    },
    policy: { sensitive: false, allowedUsage: ["retrieval"] },
    scopes: [
      {
        kind: "sql_source",
        reference: {
          scopeId: "scope_ledger_table",
          scopeVersion: "scopev_0001",
        },
        connector: "postgres.ledger",
        schema: "public",
        table: "inventory_ledger",
        columns: ["ledger_id", "product_id", "delta_quantity", "recorded_at"],
      },
    ],
  };
}

/** HTTP Card that resolves to `delegated`, for the same reason the SQL one does. */
export function createLookupApiCard(): ApprovedCard {
  return {
    cardId: "card_lookup_api",
    versionId: "cardv_lookup_api_v1",
    meaning: {
      description: "결제 조회 엔드포인트 — 결제 단건의 현재 상태",
      representativeQuestions: [
        "결제조회엔드포인트는 어떤 상태를 돌려주나요?",
      ],
      aliases: ["settlement lookup", "결제 조회 엔드포인트"],
      keywords: ["결제조회엔드포인트"],
    },
    policy: { sensitive: false, allowedUsage: ["retrieval"] },
    scopes: [
      {
        kind: "http_source",
        reference: {
          scopeId: "scope_lookup_api",
          scopeVersion: "scopev_0001",
        },
        connector: "billing.api",
        method: "GET",
        path: "/settlements/{settlementId}",
        // The one Card in the fixtures whose source names no operation, held
        // explicitly at `undefined` rather than omitted. It is what makes the
        // serialization suites cover the absent-key branch end to end: an
        // `operationId` that never appears anywhere would let a build that
        // emitted `""` for it pass every assertion in this repository.
        operationId: undefined,
        parameters: [
          { location: "path", name: "settlementId", required: true },
        ],
      },
    ],
  };
}

/**
 * Managed document Card that resolves to `failed`.
 *
 * Its `scopeId` is registered in no chunk map, and `FixtureManagedExecutor`
 * answers an unregistered Scope with a `scope_not_published` failure. The
 * failure therefore comes from the executor's own behaviour rather than from a
 * stub written to fail, which is what makes the resulting item honest.
 *
 * Its binding differs from the indexed Card's so the exclusion checks cover the
 * guide of a `failed` item too: that guide is serialized just like a fulfilled
 * one, and nothing about failing exempts it from the field ban.
 */
export function createUnindexedDocumentCard(): ApprovedCard {
  return {
    cardId: "card_unindexed_document",
    versionId: "cardv_unindexed_document_v1",
    meaning: {
      description: "색인이 유실된 문서 — 승인은 살아 있으나 색인을 읽을 수 없다",
      representativeQuestions: ["유실된색인 문서는 어떻게 보고되나요?"],
      aliases: ["retired index", "유실된 색인 문서"],
      keywords: ["유실된색인"],
    },
    policy: { sensitive: false, allowedUsage: ["retrieval"] },
    scopes: [
      {
        kind: "managed_document",
        reference: {
          scopeId: "scope_unindexed_document",
          scopeVersion: "scopev_0001",
        },
        documentIndex: {
          documentIndexId: "docidx_not_registered",
          sourceId: "src_policy_docs",
          documentId: "doc_retired_terms",
          indexVersion: "idxv_0002",
        },
        selection: { kind: "document" },
      },
    ],
  };
}

/**
 * The four Cards above, in catalog order.
 *
 * Resolved against `ALL_OUTCOMES_QUERY` under the default thresholds they
 * produce all three Scope kinds and all three `fulfillment` states, with a
 * managed document on both sides of the fulfilled/failed split.
 */
export function createAllOutcomesCardSet(): readonly ApprovedCard[] {
  return [
    createIndexedDocumentCard(),
    createLedgerTableCard(),
    createLookupApiCard(),
    createUnindexedDocumentCard(),
  ];
}
