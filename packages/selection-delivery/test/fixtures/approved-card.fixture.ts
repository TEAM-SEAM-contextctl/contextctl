import type { ApprovedCard } from "../../src/domain/card-catalog.js";

/**
 * The three approved Cards the demo selects over, one per Scope kind.
 *
 * Each factory takes no arguments and builds a fresh object every call, so a
 * test that mutates or narrows a returned Card cannot leak into the next one.
 */

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
          connectorId: "vector.local",
          accessHandle: "documents/policies/indexes/refund",
        },
        selection: { kind: "document" },
      },
    ],
  };
}

/** SQL Card. Answers stock questions, and shares the "환불" vocabulary. */
export function createInventoryCard(): ApprovedCard {
  return {
    cardId: "card_inventory",
    versionId: "cardv_inventory_v1",
    meaning: {
      description: "상품 재고 테이블 — 상품별 현재 재고 수량과 환불 가능 여부",
      representativeQuestions: ["현재 재고가 있는 상품은 무엇인가요?"],
      aliases: ["stock", "inventory"],
      keywords: ["재고", "품절", "stock", "수량"],
    },
    policy: { sensitive: false, allowedUsage: ["retrieval"] },
    scopes: [
      {
        kind: "sql_source",
        reference: {
          scopeId: "scope_inventory_table",
          scopeVersion: "scopev_0001",
        },
        connector: "postgres.main",
        table: "inventory",
        columns: [
          "product_id",
          "product_name",
          "refundable",
          "stock_quantity",
        ],
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
      aliases: ["payment lookup"],
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
      },
    ],
  };
}

/** The full demo catalog, in a stable order. */
export function createDemoCardSet(): readonly ApprovedCard[] {
  return [
    createRefundPolicyCard(),
    createInventoryCard(),
    createPaymentApiCard(),
  ];
}
