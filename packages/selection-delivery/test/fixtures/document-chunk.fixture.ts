import type { FixtureChunk } from "../../src/infrastructure/fixture-document-retriever.js";

/**
 * The indexed chunks of the refund policy document the demo Card points at.
 *
 * Each factory builds fresh objects every call, matching
 * `approved-card.fixture.ts`, so a test that narrows or reorders a returned
 * list cannot leak into the next one. The three chunks are deliberately close
 * in vocabulary — all three mention 환불 — so a ranking test measures the
 * scoring rather than an accidental single keyword hit.
 */
export function createRefundPolicyChunks(): readonly FixtureChunk[] {
  return [
    {
      chunkId: "chunk_refund_window",
      chunkRevisionId: "chunkrev_refund_window_v1",
      semanticUnitId: "unit_refund_window",
      documentId: "doc_refund_policy",
      contentDigest: "digest_refund_window",
      text: "환불 가능 기간: 구매일로부터 14일 이내에는 단순 변심으로도 환불할 수 있다.",
    },
    {
      chunkId: "chunk_refund_excluded",
      chunkRevisionId: "chunkrev_refund_excluded_v1",
      semanticUnitId: "unit_refund_excluded",
      documentId: "doc_refund_policy",
      contentDigest: "digest_refund_excluded",
      text: "환불 불가 상품: 개봉한 식품, 맞춤 제작 상품, 사용 흔적이 있는 전자제품은 환불할 수 없다.",
    },
    {
      chunkId: "chunk_shipping_fee",
      chunkRevisionId: "chunkrev_shipping_fee_v1",
      semanticUnitId: "unit_shipping_fee",
      documentId: "doc_refund_policy",
      contentDigest: "digest_shipping_fee",
      text: "배송비 처리: 단순 변심 환불의 반품 배송비는 구매자가 부담한다.",
    },
  ];
}

/**
 * The chunk map keyed the way a retriever looks it up: by the
 * `documentIndexId` the refund policy Card's Scope declares.
 */
export function createRefundPolicyChunkMap(): Readonly<
  Record<string, readonly FixtureChunk[]>
> {
  return { docidx_refund_policy: createRefundPolicyChunks() };
}
