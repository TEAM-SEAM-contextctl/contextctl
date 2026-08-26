export type SelectionGeneralizationSplit = "calibration" | "holdout";

export interface SelectionGeneralizationCase {
  readonly id: string;
  readonly split: SelectionGeneralizationSplit;
  readonly query: string;
  readonly document: string;
  readonly sections: readonly string[];
  readonly allowedSections?: readonly {
    readonly document: string;
    readonly section: string;
  }[];
}

const calibration = (
  input: Omit<SelectionGeneralizationCase, "split">,
): SelectionGeneralizationCase => ({ ...input, split: "calibration" });

const holdout = (
  input: Omit<SelectionGeneralizationCase, "split">,
): SelectionGeneralizationCase => ({ ...input, split: "holdout" });

/**
 * The 11 cases that exposed the v3 catalog-growth defect. They are calibration
 * evidence from the moment the defect was analysed and must not be reported as
 * an unseen holdout again.
 */
const SELECTION_GENERALIZATION_PRIMARY_CALIBRATION_CASES = [
  calibration({
    id: "payment-approval-timeout",
    query: "PG 승인 응답이 60초를 넘으면 주문은 어떻게 처리하나요?",
    document: "payment.md",
    sections: ["결제 승인"],
  }),
  calibration({
    id: "payment-large-retry",
    query: "결제 금액이 100만 원을 넘으면 자동 재시도하나요?",
    document: "payment.md",
    sections: ["예외 규정"],
  }),
  calibration({
    id: "payment-partial-failure",
    query: "부분 결제에서 카드 승인이 실패하면 포인트는 어떻게 되나요?",
    document: "payment.md",
    sections: ["부분 결제"],
    allowedSections: [{ document: "payment.md", section: "결제 승인" }],
  }),
  calibration({
    id: "leave-two-halves",
    query: "같은 날 오전 반차와 오후 반차를 모두 쓰면 연차는 얼마나 차감되나요?",
    document: "leave.md",
    sections: ["반차"],
  }),
  calibration({
    id: "leave-sick-document",
    query: "병가를 4일 연속 사용하면 어떤 서류가 필요한가요?",
    document: "leave.md",
    sections: ["병가"],
  }),
  calibration({
    id: "shipping-island",
    query: "울릉도 배송은 얼마나 걸리고 추가 배송비는 얼마인가요?",
    document: "shipping.md",
    sections: ["도서산간 배송"],
    allowedSections: [{ document: "shipping.md", section: "배송비" }],
  }),
  calibration({
    id: "shipping-missing",
    query: "배송 완료로 표시됐는데 물건을 못 받으면 언제까지 접수해야 하나요?",
    document: "shipping.md",
    sections: ["분실·파손 접수 절차"],
  }),
  calibration({
    id: "refund-transfer",
    query: "계좌이체 결제 환불은 언제 처리되나요?",
    document: "refund.md",
    sections: ["환불 기한"],
  }),
  calibration({
    id: "refund-no-arrival",
    query: "환불 신청 후 반품이 10일 안에 도착하지 않으면 어떻게 되나요?",
    document: "refund.md",
    sections: ["예외 규정"],
  }),
  calibration({
    id: "expense-card-approval",
    query: "법인카드로 30만 원을 초과해 결제하려면 무엇이 필요한가요?",
    document: "expense.md",
    sections: ["법인카드 사용 기준"],
  }),
  calibration({
    id: "expense-quarter-end",
    query: "분기 말 경비는 언제까지 등록해야 하나요?",
    document: "expense.md",
    sections: ["정산 마감일"],
  }),
] as const satisfies readonly SelectionGeneralizationCase[];

/**
 * The first generalization set became calibration evidence when its only
 * failure was inspected to define lexical-semantic rank agreement. Keeping the
 * cases prevents regression without misreporting them as unseen evidence.
 */
export const SELECTION_GENERALIZATION_SECONDARY_CALIBRATION_CASES = [
  calibration({
    id: "expense-lost-receipt",
    query: "영수증을 잃어버린 지출도 한 번은 정산받을 수 있나요?",
    document: "expense.md",
    sections: ["증빙 서류"],
  }),
  calibration({
    id: "expense-long-trip",
    query: "국내 출장이 엿새째가 되면 일비는 그대로 나오나요?",
    document: "expense.md",
    sections: ["출장비와 일비"],
  }),
  calibration({
    id: "leave-probation",
    query: "수습 기간 두 번째 달에 쓸 수 있는 휴가는 무엇인가요?",
    document: "leave.md",
    sections: ["예외 규정"],
  }),
  calibration({
    id: "leave-parent-bereavement",
    query: "부모님이 돌아가신 경우 회사에서 며칠을 쉴 수 있나요?",
    document: "leave.md",
    sections: ["경조휴가"],
  }),
  calibration({
    id: "payment-virtual-account",
    query: "가상계좌를 발급받고 하루 안에 입금하지 않으면 주문은 어떻게 되나요?",
    document: "payment.md",
    sections: ["결제 수단"],
  }),
  calibration({
    id: "payment-maintenance-code",
    query: "PG-2001 오류가 나면 언제 다시 결제를 시도하나요?",
    document: "payment.md",
    sections: ["PG 오류 코드"],
  }),
  calibration({
    id: "refund-defect-discovery",
    query: "받은 물건의 하자를 20일 뒤에 알았는데 철회 신청이 가능한가요?",
    document: "refund.md",
    sections: ["청약철회 기간"],
  }),
  calibration({
    id: "refund-different-color",
    query: "같은 상품을 다른 색상으로 바꾸려면 며칠 안에 신청해야 하나요?",
    document: "refund.md",
    sections: ["교환 규정"],
  }),
  calibration({
    id: "shipping-afternoon-order",
    query: "평일 오후 세 시에 주문하면 출고와 도착은 언제인가요?",
    document: "shipping.md",
    sections: ["배송 소요 기간"],
  }),
  calibration({
    id: "shipping-jeju-frozen",
    query: "제주도로 냉동 상품을 새벽 배송받을 수 있나요?",
    document: "shipping.md",
    sections: ["도서산간 배송"],
  }),
  calibration({
    id: "shipping-weather-alert",
    query: "폭설 특보가 내려진 지역의 주문은 바로 출고하나요?",
    document: "shipping.md",
    sections: ["예외 규정"],
  }),
] as const satisfies readonly SelectionGeneralizationCase[];

/** Retained as calibration after the policy changed following its first run. */
export const SELECTION_GENERALIZATION_TERTIARY_CALIBRATION_CASES = [
  calibration({
    id: "expense-original-retention",
    query: "정산이 끝난 영수증 원본은 얼마 동안 보관해야 하나요?",
    document: "expense.md",
    sections: ["증빙 서류"],
  }),
  calibration({
    id: "expense-entertainment-approval",
    query: "고객 접대비가 50만 원을 넘으면 누구의 승인이 필요한가요?",
    document: "expense.md",
    sections: ["예외 규정"],
  }),
  calibration({
    id: "leave-two-and-half-years",
    query: "입사한 지 2년 반이면 연차가 며칠 생기나요?",
    document: "leave.md",
    sections: ["연차 부여 기준"],
  }),
  calibration({
    id: "leave-long-request",
    query: "휴가를 닷새 이상 이어서 쓰려면 언제 신청해야 하나요?",
    document: "leave.md",
    sections: ["휴가 신청 절차"],
  }),
  calibration({
    id: "payment-third-failure",
    query: "정기 결제가 세 차례 모두 실패하면 주문은 어떻게 되나요?",
    document: "payment.md",
    sections: ["결제 실패와 재시도"],
  }),
  calibration({
    id: "payment-repeated-limit",
    query: "같은 카드에서 하루 동안 한도 초과가 세 번 나면 어떻게 되나요?",
    document: "payment.md",
    sections: ["카드 한도 초과 처리"],
  }),
  calibration({
    id: "refund-statement-delay",
    query: "카드 환불이 고객 명세서에 반영되기까지 최대 며칠이 걸리나요?",
    document: "refund.md",
    sections: ["환불 기한"],
  }),
  calibration({
    id: "refund-change-of-mind-cost",
    query: "단순 변심으로 반품할 때 배송비는 누가 부담하나요?",
    document: "refund.md",
    sections: ["반품 조건"],
  }),
  calibration({
    id: "shipping-three-days-late",
    query: "출고된 지 3영업일이 지났는데 배송이 끝나지 않으면 어떤 안내를 받나요?",
    document: "shipping.md",
    sections: ["배송 지연 안내"],
  }),
  calibration({
    id: "shipping-tracking-retention",
    query: "발급된 운송장 번호는 출고 후 몇 달 동안 조회할 수 있나요?",
    document: "shipping.md",
    sections: ["배송 조회"],
  }),
  calibration({
    id: "shipping-address-redelivery",
    query: "주소를 잘못 써서 반송된 주문을 다시 받으려면 배송비가 얼마인가요?",
    document: "shipping.md",
    sections: ["예외 규정"],
  }),
] as const satisfies readonly SelectionGeneralizationCase[];

/** Retained as calibration after one failure led to inflection normalization. */
export const SELECTION_GENERALIZATION_QUATERNARY_CALIBRATION_CASES = [
  calibration({
    id: "expense-late-previous-month",
    query: "지난달 비용을 이번 달 6일에 올리면 언제 정산되나요?",
    document: "expense.md",
    sections: ["정산 마감일"],
  }),
  calibration({
    id: "expense-private-car-distance",
    query: "출장에서 자차로 120km를 이동하면 교통비는 어떤 기준으로 받나요?",
    document: "expense.md",
    sections: ["출장비와 일비"],
  }),
  calibration({
    id: "leave-four-half-days",
    query: "반차를 네 번 사용하면 연차가 모두 며칠 차감되나요?",
    document: "leave.md",
    sections: ["반차"],
  }),
  calibration({
    id: "leave-company-cancellation",
    query: "회사 사정으로 승인된 휴가가 취소되면 그 일수는 다음 해로 넘어가나요?",
    document: "leave.md",
    sections: ["잔여 연차와 이월"],
  }),
  calibration({
    id: "payment-one-time-failure",
    query: "고객이 직접 하는 일회성 결제가 실패해도 자동으로 다시 시도하나요?",
    document: "payment.md",
    sections: ["결제 실패와 재시도"],
  }),
  calibration({
    id: "payment-pg-1002",
    query: "PG-1002 응답을 받으면 시스템은 어떻게 처리하나요?",
    document: "payment.md",
    sections: ["PG 오류 코드"],
    allowedSections: [
      { document: "payment.md", section: "카드 한도 초과 처리" },
    ],
  }),
  calibration({
    id: "refund-closed-card",
    query: "결제했던 카드가 해지된 주문은 환불금을 어디로 며칠 안에 받나요?",
    document: "refund.md",
    sections: ["예외 규정"],
  }),
  calibration({
    id: "refund-exchange-out-of-stock",
    query: "교환을 신청했는데 같은 상품 재고가 없으면 어떻게 처리되나요?",
    document: "refund.md",
    sections: ["교환 규정"],
  }),
  calibration({
    id: "shipping-jeju-free-order",
    query: "5만 원어치를 제주로 주문하면 배송비는 모두 얼마인가요?",
    document: "shipping.md",
    sections: ["배송비"],
    allowedSections: [
      { document: "shipping.md", section: "도서산간 배송" },
    ],
  }),
  calibration({
    id: "shipping-damaged-photo",
    query: "배송된 상품이 파손됐다면 사진은 언제 함께 내야 하나요?",
    document: "shipping.md",
    sections: ["분실·파손 접수 절차"],
  }),
  calibration({
    id: "shipping-holiday-delay",
    query: "명절 연휴 무렵에는 배송이 평소보다 며칠 더 걸릴 수 있나요?",
    document: "shipping.md",
    sections: ["배송 지연 안내"],
  }),
] as const satisfies readonly SelectionGeneralizationCase[];

export const SELECTION_GENERALIZATION_CALIBRATION_CASES = [
  ...SELECTION_GENERALIZATION_PRIMARY_CALIBRATION_CASES,
  ...SELECTION_GENERALIZATION_SECONDARY_CALIBRATION_CASES,
  ...SELECTION_GENERALIZATION_TERTIARY_CALIBRATION_CASES,
  ...SELECTION_GENERALIZATION_QUATERNARY_CALIBRATION_CASES,
] as const;

/**
 * Sealed after every v4 branch and constant was frozen. These cases were not
 * executed or inspected while implementing the final policy.
 */
export const SELECTION_GENERALIZATION_HOLDOUT_CASES = [
  holdout({
    id: "expense-sixty-day-limit",
    query: "발생한 지 60일이 넘은 경비도 지금 정산을 신청할 수 있나요?",
    document: "expense.md",
    sections: ["정산 마감일"],
  }),
  holdout({
    id: "expense-card-purpose-deadline",
    query: "법인카드를 쓴 뒤 용도와 참석자는 언제까지 입력해야 하나요?",
    document: "expense.md",
    sections: ["법인카드 사용 기준"],
  }),
  holdout({
    id: "leave-eleven-sick-days",
    query: "병가를 11일 사용하면 급여와 필요한 서류는 어떻게 되나요?",
    document: "leave.md",
    sections: ["병가"],
  }),
  holdout({
    id: "leave-spouse-childbirth",
    query: "배우자가 출산하면 경조휴가를 며칠 받을 수 있나요?",
    document: "leave.md",
    sections: ["경조휴가"],
  }),
  holdout({
    id: "payment-point-maximum",
    query: "한 주문에서 포인트는 결제 금액의 최대 몇 퍼센트까지 쓸 수 있나요?",
    document: "payment.md",
    sections: ["부분 결제"],
  }),
  holdout({
    id: "payment-overseas-installment",
    query: "해외에서 발급된 카드도 무이자 할부를 사용할 수 있나요?",
    document: "payment.md",
    sections: ["예외 규정"],
  }),
  holdout({
    id: "refund-digital-content-started",
    query: "이미 이용을 시작한 디지털 콘텐츠도 청약철회할 수 있나요?",
    document: "refund.md",
    sections: ["청약철회 기간"],
  }),
  holdout({
    id: "refund-opened-food",
    query: "포장을 개봉한 식품은 환불이나 교환이 가능한가요?",
    document: "refund.md",
    sections: ["환불 불가 사유"],
  }),
  holdout({
    id: "shipping-basic-fee",
    query: "주문 금액이 5만 원보다 적으면 기본 배송비는 얼마인가요?",
    document: "shipping.md",
    sections: ["배송비"],
  }),
  holdout({
    id: "shipping-carrier-reflection",
    query: "집하된 뒤 택배사 배송 조회에 반영되기까지 최대 몇 시간이 걸리나요?",
    document: "shipping.md",
    sections: ["배송 조회"],
  }),
  holdout({
    id: "shipping-seven-day-compensation",
    query: "배송 지연이 7영업일을 넘으면 고객은 어떤 보상을 받나요?",
    document: "shipping.md",
    sections: ["배송 지연 안내"],
  }),
] as const satisfies readonly SelectionGeneralizationCase[];

export const SELECTION_GENERALIZATION_CASES = [
  ...SELECTION_GENERALIZATION_CALIBRATION_CASES,
  ...SELECTION_GENERALIZATION_HOLDOUT_CASES,
] as const;
