import type { PublishedSourceCoordinate } from "@contextctl/contracts";
import {
  DeterministicCardMeaningGenerator,
  FallbackCardMeaningGenerator,
  OpenAiCompatibleCardMeaningGenerator,
  type CardMeaningFallbackReport,
  type CardMeaningGenerator,
} from "@contextctl/registry-lifecycle";

import { readNonEmpty } from "./paths.js";

/**
 * Which generator the CLI ended up composing.
 *
 * Reported rather than inferred, because the two backends are indistinguishable
 * from their output alone: a Card written by the deterministic generator looks
 * like a Card, just a poor one. An operator who configured a model and silently
 * got templates back has no way to tell from the Cards themselves, so the
 * composition says which one it built.
 */
export type CardMeaningBackendKind = "deterministic" | "llm_with_fallback";

export interface CardMeaningBackend {
  readonly kind: CardMeaningBackendKind;
  readonly generator: CardMeaningGenerator;
  /** The model name, when one is configured. */
  readonly model?: string;
  /**
   * The configured API root, when one is configured.
   *
   * Present so the operator can confirm *which* endpoint was bound without
   * re-reading their shell. The credential is deliberately absent from this
   * interface: everything here is written to stderr by the caller, and a value
   * that is never carried cannot be printed by mistake.
   */
  readonly endpoint?: string;
  /**
   * Things the operator should know about how this was assembled — currently a
   * partially configured model. Returned rather than printed because this
   * module composes; deciding where diagnostics go belongs to the command that
   * owns the process's streams.
   */
  readonly notices: readonly string[];
}

export const CARD_MEANING_BASE_URL_VARIABLE =
  "CONTEXTCTL_CARD_MEANING_BASE_URL";
export const CARD_MEANING_MODEL_VARIABLE = "CONTEXTCTL_CARD_MEANING_MODEL";
export const CARD_MEANING_API_KEY_VARIABLE = "CONTEXTCTL_CARD_MEANING_API_KEY";
export const CARD_MEANING_TIMEOUT_MS_VARIABLE =
  "CONTEXTCTL_CARD_MEANING_TIMEOUT_MS";
export const CARD_MEANING_CONTEXT_TOKENS_VARIABLE =
  "CONTEXTCTL_CARD_MEANING_CONTEXT_TOKENS";
export const CARD_MEANING_MAX_OUTPUT_TOKENS_VARIABLE =
  "CONTEXTCTL_CARD_MEANING_MAX_OUTPUT_TOKENS";

/**
 * Conservative enough to outlast a cold model load, short enough that a hung
 * endpoint does not hold a claim open indefinitely.
 */
const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * Deliberately below the usual deployed window rather than at it. The estimate
 * the generator budgets against is approximate, and the cost of guessing low
 * here is a fallback to deterministic text — the cost of guessing high is a
 * truncated prompt describing evidence the model never saw.
 */
const DEFAULT_CONTEXT_TOKENS = 8_192;
const DEFAULT_MAX_OUTPUT_TOKENS = 1_024;

/** What a masked secret is replaced with. */
const MASK = "***";

/**
 * Builds the Card meaning generator the CLI should hand to the daemon.
 *
 * Three variables — base URL, model, credential — are required together, and a
 * partial set is treated as *no* model rather than as an error. Refusing to
 * start would punish an operator who is mid-configuration for a feature that is
 * an enhancement, not a requirement: Registry claims Publications perfectly well
 * with deterministic text. Silently accepting it would be worse in the other
 * direction, though, so the partial case leaves a notice naming exactly which
 * variables are missing. Without that, the only symptom is Cards whose keywords
 * carry identifier tokens and nothing a natural-language query would match, and
 * nothing connects that back to a typo in a variable name.
 *
 * The tuning values are held to a different standard and are rejected outright
 * when unparseable. They have safe defaults, so falling back to one would be
 * easy — and that is precisely the problem: an operator who wrote
 * `TIMEOUT_MS=30s` asked for something specific, and honouring it as 30000 by
 * accident hides the mistake behind behaviour that looks correct.
 */
export function resolveCardMeaningBackend(input: {
  readonly environment: Readonly<Partial<Record<string, string>>>;
  readonly onFallback: (message: string) => void;
  readonly fetch?: typeof globalThis.fetch;
}): CardMeaningBackend {
  const { environment } = input;

  // Validated before the backend is chosen, so a malformed tuning value is
  // reported even when the model is not configured — otherwise the typo stays
  // invisible until the day someone finally sets the other three variables.
  const timeoutMs = readPositiveInteger(
    environment,
    CARD_MEANING_TIMEOUT_MS_VARIABLE,
    DEFAULT_TIMEOUT_MS,
  );
  const contextTokens = readPositiveInteger(
    environment,
    CARD_MEANING_CONTEXT_TOKENS_VARIABLE,
    DEFAULT_CONTEXT_TOKENS,
  );
  const maxOutputTokens = readPositiveInteger(
    environment,
    CARD_MEANING_MAX_OUTPUT_TOKENS_VARIABLE,
    DEFAULT_MAX_OUTPUT_TOKENS,
  );

  const baseUrl = readNonEmpty(environment, CARD_MEANING_BASE_URL_VARIABLE);
  const model = readNonEmpty(environment, CARD_MEANING_MODEL_VARIABLE);
  const apiKey = readNonEmpty(environment, CARD_MEANING_API_KEY_VARIABLE);

  const deterministic = new DeterministicCardMeaningGenerator();

  if (baseUrl === undefined || model === undefined || apiKey === undefined) {
    return {
      kind: "deterministic",
      generator: deterministic,
      notices: partialConfigurationNotices(
        { baseUrl, model, apiKey },
        apiKey,
      ),
    };
  }

  const primary = new OpenAiCompatibleCardMeaningGenerator({
    baseUrl,
    // The model as configured, never the masked form. Masking exists so a
    // credential cannot reach a log; putting it on the wire would send a model
    // name the endpoint does not have.
    model,
    apiKey,
    timeoutMs,
    contextTokens,
    maxOutputTokens,
    // Spread rather than assigned: `exactOptionalPropertyTypes` makes an
    // explicit `undefined` different from an absent key, and the config's own
    // `?? globalThis.fetch` default only applies to the absent one.
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
  });

  return {
    kind: "llm_with_fallback",
    generator: new FallbackCardMeaningGenerator(
      primary,
      deterministic,
      (report) => {
        input.onFallback(maskSecret(describeFallback(report), apiKey));
      },
    ),
    model: maskSecret(model, apiKey),
    endpoint: maskSecret(baseUrl, apiKey),
    notices: redundantVersionPrefixNotices(baseUrl, apiKey),
  };
}

/**
 * The URL the adapter will actually request.
 *
 * Exported because `doctor` has to show the same string. The adapter builds this
 * privately from the configured root, so anyone diagnosing a 404 is comparing a
 * base URL against a path they cannot see — which is exactly how one deployment
 * spent an afternoon on a doubled `/v1`.
 */
export function cardMeaningRequestUrl(baseUrl: string): string {
  const root = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${root}/v1/chat/completions`;
}

/**
 * Warns when the configured root already carries the path the adapter appends.
 *
 * `/v1` is the shape of every OpenAI-compatible endpoint an operator verifies by
 * hand — `curl .../v1/chat/completions` — so pasting that host *plus* `/v1` into
 * the base URL is the natural mistake, and it produces `/v1/v1/chat/completions`
 * and a 404 whose message names neither the path nor the reason.
 *
 * Warned rather than trimmed. A deployment is free to serve its API under a
 * `/v1` prefix of its own, and silently rewriting an operator's configuration to
 * one this code finds more likely would replace a legible 404 with a request to
 * somewhere they never named.
 */
function redundantVersionPrefixNotices(
  baseUrl: string,
  apiKey: string,
): readonly string[] {
  const root = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  if (!root.endsWith("/v1")) {
    return [];
  }
  const suggested = root.slice(0, -"/v1".length);
  return [
    maskSecret(
      [
        `경고: ${CARD_MEANING_BASE_URL_VARIABLE} 가 /v1 로 끝납니다: ${root}`,
        `  이 클라이언트가 /v1/chat/completions 를 직접 붙이므로 실제 요청은 ${cardMeaningRequestUrl(baseUrl)} 가 되어 404 가 날 수 있습니다.`,
        `  루트만 지정하십시오: ${suggested === "" ? "https://<호스트>" : suggested}`,
      ].join("\n"),
      apiKey,
    ),
  ];
}

/**
 * Replaces every occurrence of `secret` in `text` with `***`.
 *
 * This exists because the fallback report is not text this module wrote. Its
 * `message` comes from the transport failure, which embeds the underlying
 * fetch error verbatim, and a fetch error may quote the request it was making.
 * Today that does not include an `authorization` header; nothing in the type
 * system stops a future runtime — or a proxy library someone injects through
 * `fetch` — from putting one there. The credential is known at this point, so
 * removing it costs one string scan and does not depend on trusting whatever
 * produced the message.
 *
 * An empty or absent secret masks nothing. An empty needle matches at every
 * position, so masking one would replace the entire text with separators — the
 * guard is load-bearing, not defensive tidiness.
 */
export function maskSecret(text: string, secret: string | undefined): string {
  if (secret === undefined || secret === "") {
    return text;
  }
  // Split/join rather than a regex: the credential is arbitrary text and could
  // contain regex metacharacters, and escaping them is a bug waiting to happen.
  return text.split(secret).join(MASK);
}

/**
 * One line naming the failure kind, the reason, and the coordinate it happened
 * on. The coordinate is what makes the line actionable — a stream of "the model
 * failed" says the endpoint is down, while the same message repeating on one
 * document says the evidence there is the problem.
 */
function describeFallback(report: CardMeaningFallbackReport): string {
  // The endpoint is deliberately absent. This line is written once per Knowledge
  // Unit, so a misconfigured endpoint repeats it for every Card in the
  // publication; the URL belongs where it is read once, which is `doctor`.
  return `Card 의미 생성 실패(${report.kind}) — ${summarizeCoordinate(report.request.coordinate)}: ${report.message} (결정적 생성기로 대체함). contextctl doctor 로 설정을 확인하세요.`;
}

function summarizeCoordinate(coordinate: PublishedSourceCoordinate): string {
  switch (coordinate.kind) {
    case "document":
      return `${coordinate.documentId}/${coordinate.semanticUnitId}`;
    case "sql_table":
      return `${coordinate.schema}.${coordinate.table}`;
    case "http_operation":
      return `${coordinate.method} ${coordinate.path}`;
    default: {
      const unreachable: never = coordinate;
      throw new Error(`unknown coordinate: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * Names the missing variables when the model is configured only in part.
 *
 * Nothing is said when all three are absent: that is the documented default,
 * not a mistake, and warning about it on every invocation would train the
 * operator to ignore the channel the real warning arrives on.
 *
 * Variable *names* are safe to print — they are documented and carry no value.
 * The result still goes through the mask, because the one thing worse than a
 * missing warning is a warning that leaks the credential the operator did set.
 */
function partialConfigurationNotices(
  configured: {
    readonly baseUrl: string | undefined;
    readonly model: string | undefined;
    readonly apiKey: string | undefined;
  },
  apiKey: string | undefined,
): readonly string[] {
  const missing = [
    configured.baseUrl === undefined
      ? CARD_MEANING_BASE_URL_VARIABLE
      : undefined,
    configured.model === undefined ? CARD_MEANING_MODEL_VARIABLE : undefined,
    configured.apiKey === undefined ? CARD_MEANING_API_KEY_VARIABLE : undefined,
  ].filter((variable): variable is string => variable !== undefined);

  if (missing.length === 3) {
    return [];
  }

  return [
    maskSecret(
      `Card 의미 생성에 모델을 쓰려면 ${CARD_MEANING_BASE_URL_VARIABLE}, ${CARD_MEANING_MODEL_VARIABLE}, ${CARD_MEANING_API_KEY_VARIABLE}가 모두 필요합니다. ${missing.join(", ")}이(가) 비어 있어 결정적 생성기로 동작합니다 — Card 설명과 키워드가 식별자 위주로만 채워집니다.`,
      apiKey,
    ),
  ];
}

/**
 * A positive safe integer, or the default when the variable is absent.
 *
 * The shape is checked before the value is parsed, because `Number` is far more
 * permissive than an operator would expect: it reads `"0x10"` as 16 and `"1e3"`
 * as 1000, turning a typo into a plausible-looking setting. Non-integers are
 * refused rather than rounded for the same reason a bad value is refused at
 * all — `2.5` was meant to be something, and it was not `2`.
 */
function readPositiveInteger(
  environment: Readonly<Partial<Record<string, string>>>,
  variable: string,
  fallback: number,
): number {
  const raw = readNonEmpty(environment, variable);
  if (raw === undefined) {
    return fallback;
  }

  const parsed = /^[0-9]+$/u.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(
      `${variable} must be a positive integer, received ${JSON.stringify(raw)}`,
    );
  }
  return parsed;
}
