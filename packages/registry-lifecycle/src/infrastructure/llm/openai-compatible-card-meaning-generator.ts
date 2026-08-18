import type {
  PublishedFact,
  PublishedSourceCoordinate,
} from "@contextctl/contracts";

import type { CardMeaning } from "../../domain/context-card.js";
import type {
  CardMeaningGenerator,
  CardMeaningRequest,
} from "../../ports/card-meaning-generator.js";

/**
 * Why a model-backed generation did not produce usable text.
 *
 * ARCHITECTURE.md §7.4 asks that an outage stay distinguishable from a delay,
 * so the reasons are kept apart rather than collapsed into one error: a
 * `timeout` says the model is slow, `transport` that it is unreachable,
 * `http_status` that it answered and refused, and `malformed_response` that it
 * answered with something unusable. `budget_exceeded` is not a fault at all —
 * the request was too large to send and was never attempted.
 */
export type CardMeaningFailureKind =
  | "budget_exceeded"
  | "timeout"
  | "transport"
  | "http_status"
  | "malformed_response";

export class CardMeaningGenerationError extends Error {
  readonly kind: CardMeaningFailureKind;

  constructor(kind: CardMeaningFailureKind, message: string) {
    super(message);
    this.name = "CardMeaningGenerationError";
    this.kind = kind;
  }
}

export interface OpenAiCompatibleGeneratorConfig {
  /** Root of the OpenAI-compatible API, without a trailing path. */
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
  /**
   * Total context the model accepts, input and output together.
   *
   * Not a tuning knob: the deployed model's own limit. The prompt is refused
   * before it is sent when it would not fit, because a truncated prompt
   * produces text about evidence the model never saw, and that text fails
   * grounding anyway — later, and after paying for the call.
   */
  readonly contextTokens: number;
  /** Ceiling on the answer, reserved out of the same context window. */
  readonly maxOutputTokens: number;
  /** Injected so tests never reach the network. Defaults to global fetch. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Card expression text from an OpenAI-compatible model.
 *
 * The model writes description, questions, aliases, and keywords, and nothing
 * else. Coordinates, scopes, and every other machine-decidable value are
 * already fixed by the observation before this runs, which is what keeps a
 * model from naming a table or document that does not exist (root CLAUDE.md
 * §2-4). `groundCardVersion` re-checks the output regardless; nothing here is
 * exempt.
 *
 * Configuration arrives through the constructor. The daemon still owns loading
 * it and resolving the credential — this class only spends what it is handed,
 * the same way `SqliteCardStore` writes to a database the daemon opened.
 */
export class OpenAiCompatibleCardMeaningGenerator
  implements CardMeaningGenerator
{
  readonly #config: OpenAiCompatibleGeneratorConfig;
  readonly #fetch: typeof globalThis.fetch;

  constructor(config: OpenAiCompatibleGeneratorConfig) {
    this.#config = config;
    this.#fetch = config.fetch ?? globalThis.fetch;
  }

  async generate(request: CardMeaningRequest): Promise<CardMeaning> {
    const prompt = buildPrompt(request);
    const budget = this.#config.contextTokens - this.#config.maxOutputTokens;
    const estimated = estimateTokens(prompt);
    if (estimated > budget) {
      throw new CardMeaningGenerationError(
        "budget_exceeded",
        `prompt needs about ${estimated} tokens but only ${budget} are left for input`,
      );
    }

    const response = await this.#post(prompt);
    return readMeaning(await this.#readContent(response));
  }

  async #post(prompt: string): Promise<Response> {
    try {
      return await this.#fetch(`${trimSlash(this.#config.baseUrl)}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#config.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.#config.model,
          max_tokens: this.#config.maxOutputTokens,
          // Same observation in, same words out, as far as the model allows.
          temperature: 0,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ],
        }),
        signal: AbortSignal.timeout(this.#config.timeoutMs),
      });
    } catch (error) {
      // A slow model and an unreachable one call for different responses, so
      // the abort is not folded into a generic transport failure.
      const timedOut =
        error instanceof DOMException && error.name === "TimeoutError";
      throw new CardMeaningGenerationError(
        timedOut ? "timeout" : "transport",
        timedOut
          ? `model did not answer within ${this.#config.timeoutMs}ms`
          : `could not reach the model: ${describeError(error)}`,
      );
    }
  }

  async #readContent(response: Response): Promise<string> {
    if (!response.ok) {
      // The body may carry the provider's own message; the status is what the
      // operator needs, and neither may include the credential.
      throw new CardMeaningGenerationError(
        "http_status",
        `model answered with HTTP ${response.status}`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new CardMeaningGenerationError(
        "malformed_response",
        `model answer was not JSON: ${describeError(error)}`,
      );
    }

    const content = firstChoiceContent(payload);
    if (content === undefined) {
      throw new CardMeaningGenerationError(
        "malformed_response",
        "model answer carried no message content",
      );
    }
    return content;
  }
}

const SYSTEM_PROMPT = [
  "You write the search-facing description of one knowledge area for a retrieval control plane.",
  "Answer with a single JSON object and nothing else, using these keys:",
  '"description" (one or two sentences), "representativeQuestions" (1-5 strings),',
  '"aliases" (0-5 strings), "keywords" (0-10 lowercase strings).',
  "Use only the coordinate and evidence you are given.",
  "Never invent a table, column, document, path, or field that does not appear there.",
].join("\n");

function buildPrompt(request: CardMeaningRequest): string {
  return [
    "Coordinate:",
    describeCoordinate(request.coordinate),
    "",
    "Evidence:",
    ...request.evidence.map(
      (fact) => `- ${fact.name}: ${formatValue(fact.value)}`,
    ),
  ].join("\n");
}

function describeCoordinate(coordinate: PublishedSourceCoordinate): string {
  switch (coordinate.kind) {
    case "document":
      return `document ${coordinate.documentId}, semantic unit ${coordinate.semanticUnitId}`;
    case "sql_table":
      return `table ${coordinate.schema}.${coordinate.table}, columns ${coordinate.columns.join(", ")}`;
    case "http_operation":
      return `HTTP operation ${coordinate.method} ${coordinate.path}`;
    default: {
      const unreachable: never = coordinate;
      throw new Error(`unknown coordinate: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * Rough token count, deliberately pessimistic.
 *
 * The real tokenizer lives in the model, and pulling one in to be exact would
 * add a dependency to guard a limit that only needs to not be crossed. Four
 * characters per token is the usual English rule of thumb; CJK text runs
 * denser, so the shorter of the two estimates would understate it. Erring high
 * costs a fallback to deterministic text, erring low costs a truncated prompt.
 */
function estimateTokens(prompt: string): number {
  const byCharacters = Math.ceil(prompt.length / 4);
  const byNonAscii = countNonAscii(prompt);
  return Math.max(byCharacters, byNonAscii) + PROMPT_OVERHEAD_TOKENS;
}

const PROMPT_OVERHEAD_TOKENS = Math.ceil(SYSTEM_PROMPT.length / 4);

function countNonAscii(value: string): number {
  let count = 0;
  for (const character of value) {
    if (character.charCodeAt(0) > 127) {
      count += 1;
    }
  }
  return count;
}

function firstChoiceContent(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices[0] === undefined) {
    return undefined;
  }
  const message = (choices[0] as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) {
    return undefined;
  }
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content : undefined;
}

/**
 * Reads the model's JSON into a `CardMeaning`.
 *
 * Anything the model got wrong — prose around the JSON, a missing key, a
 * number where a string belongs — is a malformed response, not something to
 * patch up. Repairing it here would mean guessing at intent, and a guess is
 * exactly what must not end up in a Card.
 */
function readMeaning(content: string): CardMeaning {
  const json = extractJsonObject(content);
  if (json === undefined) {
    throw new CardMeaningGenerationError(
      "malformed_response",
      "model answer contained no JSON object",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new CardMeaningGenerationError(
      "malformed_response",
      `model answer was not valid JSON: ${describeError(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new CardMeaningGenerationError(
      "malformed_response",
      "model answer was not a JSON object",
    );
  }

  const record = parsed as Record<string, unknown>;
  const description =
    typeof record["description"] === "string"
      ? collapseWhitespace(record["description"])
      : record["description"];
  if (typeof description !== "string" || description === "") {
    throw new CardMeaningGenerationError(
      "malformed_response",
      "model answer had no description",
    );
  }

  const representativeQuestions = readStrings(
    record["representativeQuestions"],
  );
  if (representativeQuestions.length === 0) {
    // Grounding rejects a Card Version with no question, so accepting one here
    // would only move the failure later.
    throw new CardMeaningGenerationError(
      "malformed_response",
      "model answer had no representative question",
    );
  }

  return {
    description,
    representativeQuestions,
    aliases: readStrings(record["aliases"]),
    keywords: readStrings(record["keywords"]).map((keyword) =>
      keyword.toLowerCase(),
    ),
  };
}

/** Takes the outermost JSON object, tolerating text around it but not inside. */
function extractJsonObject(content: string): string | undefined {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  return start === -1 || end <= start
    ? undefined
    : content.slice(start, end + 1);
}

function readStrings(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map(collapseWhitespace)
    .filter((entry) => entry !== "");
}

/**
 * Folds the whitespace a model writes into single spaces.
 *
 * The approved read model refuses control characters, and newlines and tabs are
 * control characters. A model asked for one or two sentences may still answer in
 * two paragraphs, and that answer would be stored as a rejected version even
 * though nothing about it was wrong: the fallback generator only reacts to a
 * failed call, so a successful one that reads badly has nowhere to go.
 *
 * Newlines become spaces rather than being dropped, because dropping them joins
 * the words on either side into one. This changes the shape of the text and not
 * its content, which is why it is done here while an over-length value is still
 * refused — there, content would go missing.
 *
 * Only whitespace is folded. A NUL or an escape byte is not a formatting
 * difference, it says the answer is broken, and `readMeaning` still fails on it.
 */
function collapseWhitespace(value: string): string {
  return value
    .replace(/[\t\n\r\f\v\u0085\u2028\u2029]+/gu, " ")
    .replace(/ {2,}/gu, " ")
    .trim();
}

function formatValue(value: PublishedFact["value"]): string {
  return Array.isArray(value) ? value.join(", ") : String(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function trimSlash(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}
