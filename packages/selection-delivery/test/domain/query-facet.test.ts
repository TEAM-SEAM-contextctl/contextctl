import { describe, expect, it } from "vitest";

import {
  extractQueryFacets,
  QUERY_FACET_POLICY_VERSION,
} from "../../src/domain/query-facet.js";

describe("query-facet-v1", () => {
  it("splits only explicit boundaries and records source intent", () => {
    const result = extractQueryFacets(
      "환불 정책 문서를 찾고, 결제 테이블도 확인해줘",
    );

    expect(result.policyVersion).toBe(QUERY_FACET_POLICY_VERSION);
    expect(result.ambiguous).toBe(false);
    expect(result.facets.map((facet) => facet.normalizedText)).toEqual([
      "환불 정책 문서를 찾고",
      "결제 테이블도 확인해줘",
    ]);
    expect(result.facets[0]?.explicitSourceKinds).toEqual([
      "managed_document",
    ]);
    expect(result.facets[1]?.explicitSourceKinds).toEqual(["sql_source"]);
  });

  it("does not split a coordinator inside quotes or backticks", () => {
    const quoted = extractQueryFacets(
      '"refund and exchange" 문서와 `orders and refunds` 경로',
    );

    expect(quoted.facets).toHaveLength(1);
    expect(quoted.ambiguous).toBe(false);
  });

  it("does not mistake a business-policy word for an explicit document request", () => {
    const result = extractQueryFacets("refund policy rules");

    expect(result.facets[0]?.explicitSourceKinds).toEqual([]);
  });

  it("fails open when explicit decomposition exceeds the facet limit", () => {
    const result = extractQueryFacets("one; two; three; four; five");

    expect(result.ambiguous).toBe(true);
    expect(result.facets).toHaveLength(1);
    expect(result.facets[0]?.extraction).toBe("whole_query");
  });

  it("fails open on an unclosed protected segment", () => {
    const result = extractQueryFacets('refund and "delivery');

    expect(result.ambiguous).toBe(true);
    expect(result.facets).toHaveLength(1);
  });

  it("is byte-deterministic after normalization", () => {
    const first = extractQueryFacets("Refund   Policy AND Delivery API");
    const second = extractQueryFacets("Ｒｅｆｕｎｄ policy and delivery api");

    expect(second).toEqual(first);
  });
});
