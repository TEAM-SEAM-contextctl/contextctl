import type { ApprovedCard, ApprovedScope } from "../../src/domain/card-catalog.js";
import { canonicalDigest } from "../../src/domain/canonical-digest.js";

/** The fixed release corpus required by the final design's Selection gate. */
export const SELECTION_EVAL_DATASET_ID = "selection-eval-v1" as const;

export type SelectionEvalSourceKind = "managed_document" | "sql_source" | "http_source";
export type SelectionEvalLanguage = "ko" | "en" | "mixed";
export type SelectionEvalCategory = "single" | "multi" | "unrelated" | "ambiguous";
export type SelectionEvalSplit = "calibration" | "holdout";

export interface SelectionEvalCase {
  readonly id: string;
  readonly split: SelectionEvalSplit;
  readonly category: SelectionEvalCategory;
  readonly language: SelectionEvalLanguage;
  readonly query: string;
  /** Cards that must occur in the first five ranks, even when their verdict is defer. */
  readonly relevant: readonly string[];
  readonly expectedAdmit: readonly string[];
  readonly expectedDefer: readonly string[];
  readonly forbidden: readonly string[];
  readonly rationale: string;
}

const policy = { sensitive: false, allowedUsage: ["retrieval"] } as const;

function managed(
  id: string,
  description: string,
  questions: readonly string[],
  aliases: readonly string[],
  keywords: readonly string[],
): ApprovedCard {
  return card(id, description, questions, aliases, keywords, {
    kind: "managed_document",
    reference: { scopeId: `managed.${id}`, scopeVersion: "1" },
    documentIndex: {
      documentIndexId: `index.${id}`,
      sourceId: `source.${id}`,
      documentId: `document.${id}`,
      indexVersion: "1",
    },
    selection: { kind: "document" },
  });
}

function sql(
  id: string,
  description: string,
  questions: readonly string[],
  aliases: readonly string[],
  keywords: readonly string[],
  table: string,
  columns: readonly string[],
): ApprovedCard {
  return card(id, description, questions, aliases, keywords, {
    kind: "sql_source",
    reference: { scopeId: `sql.${id}`, scopeVersion: "1" },
    connector: "warehouse",
    schema: "public",
    table,
    columns,
  });
}

function http(
  id: string,
  description: string,
  questions: readonly string[],
  aliases: readonly string[],
  keywords: readonly string[],
  path: string,
  operationId: string,
): ApprovedCard {
  return card(id, description, questions, aliases, keywords, {
    kind: "http_source",
    reference: { scopeId: `http.${id}`, scopeVersion: "1" },
    connector: "service-api",
    method: "GET",
    path,
    operationId,
    parameters: [{ location: "query", name: "id", required: true }],
  });
}

function card(
  id: string,
  description: string,
  representativeQuestions: readonly string[],
  aliases: readonly string[],
  keywords: readonly string[],
  scope: ApprovedScope,
): ApprovedCard {
  return {
    cardId: id,
    versionId: `${id}.v1`,
    meaning: { description, representativeQuestions, aliases, keywords },
    policy,
    scopes: [scope],
  };
}

export const SELECTION_EVAL_CARDS: readonly ApprovedCard[] = [
  managed("doc_leave", "연차 부여, 사용, 이월 규정", ["연차는 며칠이고 이월할 수 있나요?"], ["휴가 규정", "leave policy"], ["연차", "휴가", "이월", "leave"]),
  managed("doc_shipping", "주문 배송과 운송장 발급 안내", ["운송장은 언제 발급되나요?"], ["배송 안내", "shipping guide"], ["배송", "운송장", "택배", "shipping"]),
  managed("doc_refund", "구매 취소와 환불 처리 규정", ["환불은 며칠 걸리나요?"], ["환불 정책", "refund policy"], ["환불", "취소", "반품", "refund"]),
  managed("doc_security", "보안 사고 신고와 대응 절차", ["보안 사고는 어디에 신고하나요?"], ["사고 대응", "security incident"], ["보안", "침해", "신고", "incident"]),
  managed("doc_benefits", "임직원 복지와 교육비 지원 안내", ["교육비 지원을 받을 수 있나요?"], ["복지 안내", "employee benefits"], ["복지", "교육비", "지원", "benefits"]),
  sql("sql_orders", "주문 상태와 주문 금액 조회", ["주문 상태를 확인해줘"], ["주문 데이터", "order records"], ["주문", "상태", "금액", "orders"], "orders", ["order_id", "status", "total_amount"]),
  sql("sql_inventory", "상품별 현재 재고 수량 조회", ["상품 재고가 몇 개 남았나요?"], ["재고 데이터", "inventory records"], ["재고", "수량", "상품", "inventory"], "inventory", ["sku", "quantity", "updated_at"]),
  sql("sql_payments", "결제 실패 코드와 거래 상태 조회", ["결제 실패 원인을 확인해줘"], ["결제 거래", "payment records"], ["결제", "실패", "거래", "payments"], "payments", ["payment_id", "status", "failure_code"]),
  sql("sql_customers", "고객 등급과 가입 상태 조회", ["고객 등급을 확인해줘"], ["고객 데이터", "customer records"], ["고객", "등급", "가입", "customers"], "customers", ["customer_id", "tier", "joined_at"]),
  sql("sql_audit", "운영 변경 감사 로그 조회", ["누가 설정을 변경했나요?"], ["감사 기록", "audit log"], ["감사", "변경", "운영자", "audit"], "audit_log", ["actor_id", "action", "created_at"]),
  http("http_weather", "지역별 현재 날씨 조회", ["서울 날씨를 알려줘"], ["날씨 API", "weather api"], ["날씨", "기온", "강수", "weather"], "/v1/weather", "getWeather"),
  http("http_currency", "통화 환율 조회", ["달러 환율을 알려줘"], ["환율 API", "exchange rate api"], ["환율", "통화", "달러", "exchange"], "/v1/exchange-rate", "getExchangeRate"),
  http("http_shipment", "운송장 번호의 실시간 배송 상태 조회", ["이 운송장은 지금 어디에 있나요?"], ["배송 추적 API", "shipment tracking"], ["운송장", "배송", "추적", "shipment"], "/v1/shipment", "getShipment"),
  http("http_payment", "결제 식별자의 실시간 승인 상태 조회", ["결제가 승인됐는지 알려줘"], ["결제 상태 API", "payment status api"], ["결제", "승인", "상태", "payment"], "/v1/payment", "getPayment"),
  http("http_profile", "사용자 계정 프로필 조회", ["사용자 프로필을 보여줘"], ["프로필 API", "user profile api"], ["사용자", "프로필", "계정", "profile"], "/v1/profile", "getProfile"),
] as const;

function q(input: SelectionEvalCase): SelectionEvalCase {
  return input;
}

export const SELECTION_EVAL_CASES: readonly SelectionEvalCase[] = [
  // Single Card: 15 (ko 8 / en 4 / mixed 3), calibration 9 / holdout 6.
  q({ id: "s01", split: "calibration", category: "single", language: "ko", query: "안 쓴 연차는 다음 해로 이월되나요?", relevant: ["doc_leave"], expectedAdmit: ["doc_leave"], expectedDefer: [], forbidden: ["doc_benefits"], rationale: "문서의 연차 이월 규정" }),
  q({ id: "s02", split: "calibration", category: "single", language: "ko", query: "운송장 번호는 언제 발급돼?", relevant: ["doc_shipping"], expectedAdmit: ["doc_shipping"], expectedDefer: [], forbidden: ["http_shipment"], rationale: "배송 안내 문서의 발급 규정" }),
  q({ id: "s03", split: "calibration", category: "single", language: "ko", query: "반품 뒤 환불 처리 기간을 알려줘", relevant: ["doc_refund"], expectedAdmit: ["doc_refund"], expectedDefer: [], forbidden: ["sql_payments"], rationale: "환불 정책 문서" }),
  q({ id: "s04", split: "calibration", category: "single", language: "ko", query: "상품 재고 수량이 얼마나 남았나요?", relevant: ["sql_inventory"], expectedAdmit: ["sql_inventory"], expectedDefer: [], forbidden: ["sql_orders"], rationale: "재고 테이블" }),
  q({ id: "s05", split: "calibration", category: "single", language: "ko", query: "결제 실패 코드를 조회해줘", relevant: ["sql_payments"], expectedAdmit: ["sql_payments"], expectedDefer: [], forbidden: ["http_payment"], rationale: "결제 거래 테이블" }),
  q({ id: "s06", split: "calibration", category: "single", language: "en", query: "What is the current exchange rate for dollars?", relevant: ["http_currency"], expectedAdmit: ["http_currency"], expectedDefer: [], forbidden: ["sql_payments"], rationale: "live exchange-rate endpoint" }),
  q({ id: "s07", split: "calibration", category: "single", language: "en", query: "Show the employee benefits and training support policy", relevant: ["doc_benefits"], expectedAdmit: ["doc_benefits"], expectedDefer: [], forbidden: ["doc_leave"], rationale: "benefits document" }),
  q({ id: "s08", split: "calibration", category: "single", language: "mixed", query: "서울 weather API로 현재 기온 알려줘", relevant: ["http_weather"], expectedAdmit: ["http_weather"], expectedDefer: [], forbidden: ["http_currency"], rationale: "mixed-language weather endpoint" }),
  q({ id: "s09", split: "calibration", category: "single", language: "mixed", query: "customer records에서 고객 등급을 조회해줘", relevant: ["sql_customers"], expectedAdmit: ["sql_customers"], expectedDefer: [], forbidden: ["http_profile"], rationale: "mixed-language customer table" }),
  q({ id: "s10", split: "holdout", category: "single", language: "ko", query: "보안 침해 사고 신고 절차가 뭐야?", relevant: ["doc_security"], expectedAdmit: ["doc_security"], expectedDefer: [], forbidden: ["sql_audit"], rationale: "보안 사고 대응 문서" }),
  q({ id: "s11", split: "holdout", category: "single", language: "ko", query: "주문 금액과 현재 상태를 조회해줘", relevant: ["sql_orders"], expectedAdmit: ["sql_orders"], expectedDefer: [], forbidden: ["http_payment"], rationale: "주문 테이블" }),
  q({ id: "s12", split: "holdout", category: "single", language: "ko", query: "운송장 실시간 배송 위치를 추적해줘", relevant: ["http_shipment"], expectedAdmit: ["http_shipment"], expectedDefer: [], forbidden: ["doc_shipping"], rationale: "실시간 배송 추적 endpoint" }),
  q({ id: "s13", split: "holdout", category: "single", language: "en", query: "Who changed the production setting? Check the audit log", relevant: ["sql_audit"], expectedAdmit: ["sql_audit"], expectedDefer: [], forbidden: ["doc_security"], rationale: "audit table" }),
  q({ id: "s14", split: "holdout", category: "single", language: "en", query: "Fetch the current user profile", relevant: ["http_profile"], expectedAdmit: ["http_profile"], expectedDefer: [], forbidden: ["sql_customers"], rationale: "profile endpoint" }),
  q({ id: "s15", split: "holdout", category: "single", language: "mixed", query: "payment status API에서 승인 상태 확인해줘", relevant: ["http_payment"], expectedAdmit: ["http_payment"], expectedDefer: [], forbidden: ["sql_payments"], rationale: "mixed-language payment endpoint" }),

  // Multi Card: 15 (ko 8 / en 4 / mixed 3); every case crosses source kinds.
  q({ id: "m01", split: "calibration", category: "multi", language: "ko", query: "배송 안내와 운송장 실시간 추적을 함께 알려줘", relevant: ["doc_shipping", "http_shipment"], expectedAdmit: ["doc_shipping", "http_shipment"], expectedDefer: [], forbidden: ["sql_orders"], rationale: "규정 문서와 실시간 API" }),
  q({ id: "m02", split: "calibration", category: "multi", language: "ko", query: "환불 규정과 결제 실패 거래를 같이 확인해줘", relevant: ["doc_refund", "sql_payments"], expectedAdmit: ["doc_refund", "sql_payments"], expectedDefer: [], forbidden: ["http_payment"], rationale: "환불 문서와 결제 테이블" }),
  q({ id: "m03", split: "calibration", category: "multi", language: "ko", query: "고객 등급과 사용자 프로필을 함께 조회해줘", relevant: ["sql_customers", "http_profile"], expectedAdmit: ["sql_customers", "http_profile"], expectedDefer: [], forbidden: ["doc_benefits"], rationale: "고객 테이블과 프로필 API" }),
  q({ id: "m04", split: "calibration", category: "multi", language: "ko", query: "보안 사고 대응 절차와 변경 감사 기록이 필요해", relevant: ["doc_security", "sql_audit"], expectedAdmit: ["doc_security", "sql_audit"], expectedDefer: [], forbidden: ["doc_leave"], rationale: "보안 문서와 감사 테이블" }),
  q({ id: "m05", split: "calibration", category: "multi", language: "ko", query: "주문 상태와 결제 승인 상태를 같이 보여줘", relevant: ["sql_orders", "http_payment"], expectedAdmit: ["sql_orders", "http_payment"], expectedDefer: [], forbidden: ["doc_refund"], rationale: "주문 테이블과 결제 API" }),
  q({ id: "m06", split: "calibration", category: "multi", language: "en", query: "Show the leave policy and my user profile", relevant: ["doc_leave", "http_profile"], expectedAdmit: ["doc_leave", "http_profile"], expectedDefer: [], forbidden: ["sql_customers"], rationale: "policy document and profile endpoint" }),
  q({ id: "m07", split: "calibration", category: "multi", language: "en", query: "Check inventory records and live shipment tracking", relevant: ["sql_inventory", "http_shipment"], expectedAdmit: ["sql_inventory", "http_shipment"], expectedDefer: [], forbidden: ["doc_shipping"], rationale: "inventory table and tracking endpoint" }),
  q({ id: "m08", split: "calibration", category: "multi", language: "mixed", query: "복지 policy와 customer tier를 같이 알려줘", relevant: ["doc_benefits", "sql_customers"], expectedAdmit: ["doc_benefits", "sql_customers"], expectedDefer: [], forbidden: ["doc_leave"], rationale: "mixed document and SQL query" }),
  q({ id: "m09", split: "calibration", category: "multi", language: "mixed", query: "refund policy와 payment status API 둘 다 확인해줘", relevant: ["doc_refund", "http_payment"], expectedAdmit: ["doc_refund", "http_payment"], expectedDefer: [], forbidden: ["sql_payments"], rationale: "mixed document and API query" }),
  q({ id: "m10", split: "holdout", category: "multi", language: "ko", query: "연차 규정과 현재 날씨를 같이 알려줘", relevant: ["doc_leave", "http_weather"], expectedAdmit: ["doc_leave", "http_weather"], expectedDefer: [], forbidden: ["doc_benefits"], rationale: "휴가 문서와 날씨 API" }),
  q({ id: "m11", split: "holdout", category: "multi", language: "ko", query: "교육비 지원과 상품 재고 수량을 확인해줘", relevant: ["doc_benefits", "sql_inventory"], expectedAdmit: ["doc_benefits", "sql_inventory"], expectedDefer: [], forbidden: ["sql_customers"], rationale: "복지 문서와 재고 테이블" }),
  q({ id: "m12", split: "holdout", category: "multi", language: "ko", query: "결제 실패 거래와 환율을 함께 조회해줘", relevant: ["sql_payments", "http_currency"], expectedAdmit: ["sql_payments", "http_currency"], expectedDefer: [], forbidden: ["http_payment"], rationale: "결제 테이블과 환율 API" }),
  q({ id: "m13", split: "holdout", category: "multi", language: "en", query: "Read the security incident guide and fetch today's weather", relevant: ["doc_security", "http_weather"], expectedAdmit: ["doc_security", "http_weather"], expectedDefer: [], forbidden: ["sql_audit"], rationale: "security document and weather endpoint" }),
  q({ id: "m14", split: "holdout", category: "multi", language: "en", query: "Compare order records with the shipping guide", relevant: ["sql_orders", "doc_shipping"], expectedAdmit: ["sql_orders", "doc_shipping"], expectedDefer: [], forbidden: ["http_shipment"], rationale: "order table and shipping document" }),
  q({ id: "m15", split: "holdout", category: "multi", language: "mixed", query: "audit log와 security incident 절차를 같이 찾아줘", relevant: ["sql_audit", "doc_security"], expectedAdmit: ["sql_audit", "doc_security"], expectedDefer: [], forbidden: ["doc_leave"], rationale: "mixed audit table and security document" }),

  // Unrelated or unsupported: 10 (ko 5 / en 3 / mixed 2).
  q({ id: "u01", split: "calibration", category: "unrelated", language: "ko", query: "양자역학의 파동함수를 설명해줘", relevant: [], expectedAdmit: [], expectedDefer: [], forbidden: ["doc_security"], rationale: "카탈로그 밖 지식" }),
  q({ id: "u02", split: "calibration", category: "unrelated", language: "ko", query: "주말 영화 상영 시간을 예약해줘", relevant: [], expectedAdmit: [], expectedDefer: [], forbidden: ["sql_orders"], rationale: "지원하지 않는 실행" }),
  q({ id: "u03", split: "calibration", category: "unrelated", language: "ko", query: "내 컴퓨터 전원을 종료해줘", relevant: [], expectedAdmit: [], expectedDefer: [], forbidden: ["http_profile"], rationale: "지원하지 않는 장치 제어" }),
  q({ id: "u04", split: "calibration", category: "unrelated", language: "en", query: "Write a sonnet about the moon", relevant: [], expectedAdmit: [], expectedDefer: [], forbidden: ["http_weather"], rationale: "catalog-unrelated generation" }),
  q({ id: "u05", split: "calibration", category: "unrelated", language: "en", query: "Compile this Rust program", relevant: [], expectedAdmit: [], expectedDefer: [], forbidden: ["sql_audit"], rationale: "unsupported code execution" }),
  q({ id: "u06", split: "calibration", category: "unrelated", language: "mixed", query: "달 표면의 gravity를 계산해줘", relevant: [], expectedAdmit: [], expectedDefer: [], forbidden: ["http_weather"], rationale: "mixed catalog-unrelated science" }),
  q({ id: "u07", split: "holdout", category: "unrelated", language: "ko", query: "오늘 저녁 메뉴를 추천해줘", relevant: [], expectedAdmit: [], expectedDefer: [], forbidden: ["doc_benefits"], rationale: "카탈로그 밖 추천" }),
  q({ id: "u08", split: "holdout", category: "unrelated", language: "ko", query: "피아노 코드를 연주해줘", relevant: [], expectedAdmit: [], expectedDefer: [], forbidden: ["sql_orders"], rationale: "지원하지 않는 장치 실행" }),
  q({ id: "u09", split: "holdout", category: "unrelated", language: "en", query: "Translate this poem into French", relevant: [], expectedAdmit: [], expectedDefer: [], forbidden: ["http_currency"], rationale: "unsupported translation request" }),
  q({ id: "u10", split: "holdout", category: "unrelated", language: "mixed", query: "Kubernetes pod를 지금 재시작해줘", relevant: [], expectedAdmit: [], expectedDefer: [], forbidden: ["doc_security"], rationale: "unsupported infrastructure mutation" }),

  // Intentionally ambiguous: 10 (ko 4 / en 4 / mixed 2).
  q({ id: "a01", split: "calibration", category: "ambiguous", language: "ko", query: "배송 상태가 궁금해", relevant: ["http_shipment"], expectedAdmit: [], expectedDefer: ["http_shipment"], forbidden: ["doc_shipping"], rationale: "규정인지 실시간 상태인지 불명확" }),
  q({ id: "a02", split: "calibration", category: "ambiguous", language: "ko", query: "결제 상태를 확인하고 싶어", relevant: ["http_payment"], expectedAdmit: [], expectedDefer: ["http_payment"], forbidden: ["sql_payments"], rationale: "실시간 승인과 과거 거래가 불명확" }),
  q({ id: "a03", split: "calibration", category: "ambiguous", language: "ko", query: "고객 정보를 찾아줘", relevant: ["sql_customers"], expectedAdmit: [], expectedDefer: ["sql_customers"], forbidden: ["http_profile"], rationale: "고객 테이블과 프로필이 불명확" }),
  q({ id: "a04", split: "calibration", category: "ambiguous", language: "en", query: "I need help with shipping", relevant: ["doc_shipping"], expectedAdmit: [], expectedDefer: ["doc_shipping"], forbidden: ["http_shipment"], rationale: "guide versus live tracking is unclear" }),
  q({ id: "a05", split: "calibration", category: "ambiguous", language: "en", query: "Check the payment records", relevant: ["sql_payments"], expectedAdmit: ["sql_payments"], expectedDefer: [], forbidden: ["http_payment"], rationale: "the word records resolves the ambiguity" }),
  q({ id: "a06", split: "calibration", category: "ambiguous", language: "mixed", query: "leave policy 좀 확인해줘", relevant: ["doc_leave"], expectedAdmit: ["doc_leave"], expectedDefer: [], forbidden: ["doc_benefits"], rationale: "explicit policy alias resolves the ambiguity" }),
  q({ id: "a07", split: "holdout", category: "ambiguous", language: "ko", query: "상태가 궁금해", relevant: ["sql_orders"], expectedAdmit: [], expectedDefer: ["sql_orders"], forbidden: ["http_payment"], rationale: "어떤 상태인지 식별자가 없어 보류해야 함" }),
  q({ id: "a08", split: "holdout", category: "ambiguous", language: "en", query: "What is today's dollar value?", relevant: ["http_currency"], expectedAdmit: ["http_currency"], expectedDefer: [], forbidden: ["sql_payments"], rationale: "달러의 현재 가치라는 바꿔 말한 표현을 환율에 연결해야 함" }),
  q({ id: "a09", split: "holdout", category: "ambiguous", language: "en", query: "Check the order status", relevant: ["sql_orders"], expectedAdmit: ["sql_orders"], expectedDefer: [], forbidden: ["http_payment"], rationale: "semantic ranking must separate order status from other status fields" }),
  q({ id: "a10", split: "holdout", category: "ambiguous", language: "mixed", query: "user profile API를 호출할 위치가 필요해", relevant: ["http_profile"], expectedAdmit: ["http_profile"], expectedDefer: [], forbidden: ["sql_customers"], rationale: "explicit API alias resolves ambiguity" }),
] as const;

export const SELECTION_EVAL_DATASET_DIGEST = canonicalDigest({
  datasetId: SELECTION_EVAL_DATASET_ID,
  cards: SELECTION_EVAL_CARDS,
  cases: SELECTION_EVAL_CASES,
});

export const SELECTION_EVAL_SPLIT_DIGEST = canonicalDigest(
  SELECTION_EVAL_CASES.map(({ id, split, category, language }) => ({
    id,
    split,
    category,
    language,
  })),
);
