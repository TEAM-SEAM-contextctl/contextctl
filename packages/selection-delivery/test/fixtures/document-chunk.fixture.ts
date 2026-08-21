import type { FixtureChunk } from "./managed-execution.fixture.js";

/**
 * The indexed chunks of the refund policy document the demo Card points at.
 *
 * Each factory builds fresh objects every call, matching
 * `approved-card.fixture.ts`, so a test that narrows or reorders a returned
 * list cannot leak into the next one. The three chunks are deliberately close
 * in vocabulary — all three mention 환불 — so a ranking test measures the
 * ranking rather than an accidental single keyword hit.
 */
export function createRefundPolicyChunks(): readonly FixtureChunk[] {
  return [
    {
      chunkId: "chunk_refund_window",
      chunkRevisionId: "chunkrev_refund_window_v1",
      semanticUnitId: "unit_01890f5c-7b1a-7989-86c3-07e34e599ac5",
      documentId: "doc_refund_policy",
      contentDigest: "digest_refund_window",
      text: "환불 가능 기간: 구매일로부터 14일 이내에는 단순 변심으로도 환불할 수 있다.",
    },
    {
      chunkId: "chunk_refund_excluded",
      chunkRevisionId: "chunkrev_refund_excluded_v1",
      semanticUnitId: "unit_01890f5c-7b1a-7821-8b5b-f84cd5d1d3bc",
      documentId: "doc_refund_policy",
      contentDigest: "digest_refund_excluded",
      text: "환불 불가 상품: 개봉한 식품, 맞춤 제작 상품, 사용 흔적이 있는 전자제품은 환불할 수 없다.",
    },
    {
      chunkId: "chunk_shipping_fee",
      chunkRevisionId: "chunkrev_shipping_fee_v1",
      semanticUnitId: "unit_01890f5c-7b1a-7aba-8bc1-735b53ebf418",
      documentId: "doc_refund_policy",
      contentDigest: "digest_shipping_fee",
      text: "배송비 처리: 단순 변심 환불의 반품 배송비는 구매자가 부담한다.",
    },
  ];
}

/**
 * The chunk map keyed the way an executor looks it up: by `scopeId`.
 *
 * By the Scope rather than by the document index, because a plan hands an
 * executor a Scope reference and a bound and nothing else. The index a Scope
 * pins is the executor's own lookup, and a fixture keyed on it would let a test
 * pass with a plan that leaked physical coordinates it is not supposed to
 * carry.
 *
 * Two Scopes are registered against the same chunks on purpose: the demo Card
 * and the all-outcomes Card both point at the refund policy document, and both
 * have to resolve for the suites that use them.
 */
export function createRefundPolicyChunkMap(): Readonly<
  Record<string, readonly FixtureChunk[]>
> {
  return {
    scope_refund_policy_doc: createRefundPolicyChunks(),
    scope_indexed_document: createRefundPolicyChunks(),
  };
}
