import { describe, expect, it } from "vitest";

import {
  derivePublicationKeywords,
  DOCUMENT_KEYWORD_EXTRACTION_POLICY_VERSION,
  MAX_DERIVED_PUBLICATION_KEYWORDS,
} from "../src/domain/derived-publication-keywords.js";

describe("derived Publication keywords", () => {
  it("publishes bounded word forms from prose without leaking headings or code", () => {
    const keywords = derivePublicationKeywords([
      { kind: "heading", analysisText: "내부 전용 제목" },
      {
        kind: "paragraph",
        analysisText:
          "배송 조회는 운송장 번호를 사용합니다. 운송장은 출고 후 2시간 이내에 발급됩니다.",
      },
      { kind: "code", analysisText: "secretOverrideToken()" },
    ]);

    expect(keywords).toEqual([...keywords].sort());
    expect(keywords).toEqual(
      expect.arrayContaining(["2", "발급됩니다", "번호를", "운송장"]),
    );
    expect(keywords).not.toContain("내부");
    expect(keywords).not.toContain("secretoverridetoken");
    expect(keywords).not.toContain("운송장 번호를");
  });

  it("normalizes, deduplicates, ranks, and caps the same input deterministically", () => {
    const uniqueTerms = Array.from(
      { length: MAX_DERIVED_PUBLICATION_KEYWORDS + 8 },
      (_, index) => `term${String(index).padStart(2, "0")}`,
    );
    const blocks = [
      {
        kind: "paragraph" as const,
        analysisText: `ＲＥＴＲＹ retry ${uniqueTerms.join(" ")}`,
      },
    ];

    const first = derivePublicationKeywords(blocks);
    const repeated = derivePublicationKeywords(structuredClone(blocks));

    expect(repeated).toEqual(first);
    expect(first).toHaveLength(MAX_DERIVED_PUBLICATION_KEYWORDS);
    expect(first.filter((keyword) => keyword === "retry")).toEqual(["retry"]);
    expect(first).toContain("term00");
    expect(first).not.toContain("term31");
  });

  it.each([
    {
      label: "leave policy",
      text: "연차는 입사 1년 후 15일이 부여됩니다. 사용하지 않은 연차는 다음 해로 이월되지 않습니다.",
      expected: ["15", "일이", "이월되지", "연차는"],
    },
    {
      label: "payment retry policy",
      text: "결제 실패는 최대 세 번까지 재시도합니다. 재시도 간격은 5분, 30분, 2시간입니다.",
      expected: ["간격은", "재시도", "재시도합니다"],
    },
  ])(
    "keeps the body vocabulary needed by the $label Card",
    ({ text, expected }) => {
      const keywords = derivePublicationKeywords([
        { kind: "paragraph", analysisText: text },
      ]);

      expect(keywords).toEqual(expect.arrayContaining(expected));
    },
  );

  it("keeps the extraction policy explicit for Publication provenance", () => {
    expect(DOCUMENT_KEYWORD_EXTRACTION_POLICY_VERSION).toBe(
      "document-keywords-v1",
    );
  });
});
