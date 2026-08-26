export interface GeneratedCardSelectionCase {
  readonly id: string;
  readonly query: string;
  readonly document: string;
  readonly sections: readonly string[];
}

/**
 * Questions whose decisive terms live in the demo document body, not only in
 * its headings. This freezes the product path that turns Markdown into Cards;
 * the older Selection fixture starts from hand-authored Cards and cannot catch
 * a lossy Ingestion or Registry projection.
 */
export const GENERATED_CARD_SELECTION_CASES: readonly GeneratedCardSelectionCase[] = [
  {
    id: "payment-limit-retry",
    query: "카드 한도 초과로 결제가 실패하면 자동으로 다시 시도하나요?",
    document: "payment.md",
    sections: ["카드 한도 초과 처리", "PG 오류 코드"],
  },
  {
    id: "payment-retry-schedule",
    query: "결제 실패 자동 재시도 간격은 어떻게 되나요?",
    document: "payment.md",
    sections: ["결제 실패와 재시도"],
  },
  {
    id: "leave-carryover",
    query: "남은 연차는 다음 해로 이월되나요?",
    document: "leave.md",
    sections: ["잔여 연차와 이월"],
  },
  {
    id: "leave-first-year",
    query: "입사 1년 미만 직원은 연차를 며칠 받나요?",
    document: "leave.md",
    sections: ["연차 부여 기준"],
  },
  {
    id: "leave-half-day-deduction",
    query: "오전 반차와 오후 반차는 연차를 얼마나 차감하나요?",
    document: "leave.md",
    sections: ["반차"],
  },
  {
    id: "shipping-invoice",
    query: "운송장 번호는 언제부터 조회할 수 있나요?",
    document: "shipping.md",
    sections: ["배송 조회"],
  },
  {
    id: "shipping-delay",
    query: "배송이 지연되면 어떤 보상을 받을 수 있나요?",
    document: "shipping.md",
    sections: ["배송 지연 안내"],
  },
  {
    id: "refund-card",
    query: "카드 결제 환불은 보통 며칠 걸리나요?",
    document: "refund.md",
    sections: ["환불 기한"],
  },
  {
    id: "refund-custom",
    query: "주문 제작 상품은 단순 변심으로 환불할 수 있나요?",
    document: "refund.md",
    sections: ["환불 불가 사유"],
  },
  {
    id: "expense-receipt",
    query: "5만원 이상 경비에는 어떤 증빙이 필요한가요?",
    document: "expense.md",
    sections: ["증빙 서류"],
  },
  {
    id: "expense-deadline",
    query: "전월 경비 정산 마감일은 언제인가요?",
    document: "expense.md",
    sections: ["정산 마감일"],
  },
];
