import type { PublishedSourceCoordinateV2 as PublishedSourceCoordinate } from "@contextctl/contracts";
import { describe, expect, it } from "vitest";

import { groundCardVersion } from "../../src/domain/evidence-grounding.js";
import type { RetrievalScope } from "../../src/domain/retrieval-scope.js";
import {
  CardMeaningGenerationError,
  OpenAiCompatibleCardMeaningGenerator,
  type OpenAiCompatibleGeneratorConfig,
} from "../../src/infrastructure/llm/openai-compatible-card-meaning-generator.js";
import type { CardMeaningRequest } from "../../src/ports/card-meaning-generator.js";

const coordinate: PublishedSourceCoordinate = {
  kind: "sql_table",
  sourceId: "src_payments",
  schema: "public",
  table: "payments",
  columns: ["status", "failed_reason"],
};

const request: CardMeaningRequest = {
  coordinate,
  facts: [
    { name: "sql.approximate_row_count", value: 128 },
    { name: "sql.columns", value: ["failed", "settled"] },
  ],
};

const answer = {
  description: "결제 상태와 실패 사유를 담은 payments 테이블.",
  representativeQuestions: ["결제가 왜 실패했나요?"],
  aliases: ["payments"],
  keywords: ["Payments", "STATUS"],
};

function chatResponse(content: string, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function generator(
  fetchImpl: typeof globalThis.fetch,
  overrides: Partial<OpenAiCompatibleGeneratorConfig> = {},
): OpenAiCompatibleCardMeaningGenerator {
  return new OpenAiCompatibleCardMeaningGenerator({
    baseUrl: "https://models.example.test",
    model: "test-model",
    apiKey: "test-key-not-a-real-credential",
    timeoutMs: 1_000,
    contextTokens: 8192,
    maxOutputTokens: 512,
    fetch: fetchImpl,
    ...overrides,
  });
}

describe("OpenAiCompatibleCardMeaningGenerator", () => {
  it("reads the model's JSON answer into a Card meaning", async () => {
    const meaning = await generator(async () =>
      chatResponse(JSON.stringify(answer)),
    ).generate(request);

    expect(meaning.description).toBe(answer.description);
    expect(meaning.representativeQuestions).toEqual([
      "결제가 왜 실패했나요?",
    ]);
    // Keywords are matched against query text, so their case is not the
    // model's to decide.
    expect(meaning.keywords).toEqual(["payments", "status"]);
  });

  it("produces meaning that passes grounding", async () => {
    const scope: RetrievalScope = {
      kind: "sql_source",
      reference: { scopeId: "scope_payments", scopeVersion: "scpv_a" },
      connector: "postgres.main",
      schema: "public",
      table: "payments",
      columns: ["status", "failed_reason"],
    };

    const meaning = await generator(async () =>
      chatResponse(JSON.stringify(answer)),
    ).generate(request);

    expect(groundCardVersion(coordinate, [scope], meaning)).toEqual({
      outcome: "validated",
    });
  });

  it("sends the credential as a bearer token and asks for the configured model", async () => {
    let seen: Request | undefined;
    await generator(async (input, init) => {
      seen = new Request(input, init);
      return chatResponse(JSON.stringify(answer));
    }).generate(request);

    expect(seen?.url).toBe(
      "https://models.example.test/v1/chat/completions",
    );
    expect(seen?.headers.get("authorization")).toBe(
      "Bearer test-key-not-a-real-credential",
    );
    await expect(seen?.json()).resolves.toMatchObject({
      model: "test-model",
      max_tokens: 512,
      temperature: 0,
    });
  });

  it("puts only the coordinate and facts in the prompt", async () => {
    let body: { messages?: { content?: string }[] } | undefined;
    await generator(async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return chatResponse(JSON.stringify(answer));
    }).generate(request);

    const prompt = body?.messages?.[1]?.content ?? "";
    expect(prompt).toContain("public.payments");
    expect(prompt).toContain("sql.approximate_row_count: 128");
    expect(prompt).toContain("sql.columns: failed, settled");
  });

  it("refuses to send a prompt that would not fit the context window", async () => {
    let called = false;
    const long: CardMeaningRequest = {
      coordinate,
      facts: [{ name: "sql.table", value: "가".repeat(9_000) }],
    };

    // Truncating would describe evidence the model never saw, and that text
    // fails grounding later anyway — after paying for the call.
    await expect(
      generator(async () => {
        called = true;
        return chatResponse(JSON.stringify(answer));
      }).generate(long),
    ).rejects.toMatchObject({ kind: "budget_exceeded" });
    expect(called).toBe(false);
  });

  it("tells a timeout apart from an unreachable model", async () => {
    const timedOut = generator(async () => {
      throw new DOMException("The operation was aborted", "TimeoutError");
    }).generate(request);
    const unreachable = generator(async () => {
      throw new TypeError("fetch failed");
    }).generate(request);

    await expect(timedOut).rejects.toMatchObject({ kind: "timeout" });
    await expect(unreachable).rejects.toMatchObject({ kind: "transport" });
  });

  it("reports a refused call by its status without echoing the body", async () => {
    const failed = generator(async () =>
      chatResponse("upstream detail", 503),
    ).generate(request);

    await expect(failed).rejects.toMatchObject({ kind: "http_status" });
    await expect(failed).rejects.toThrow("HTTP 503");
  });

  it("takes the JSON object out of a fenced code block", async () => {
    // What the deployed gemma4-12b-qat actually returns: the object wrapped in
    // a ```json fence despite being asked for JSON only.
    const meaning = await generator(async () =>
      chatResponse(`\`\`\`json\n${JSON.stringify(answer, null, 2)}\n\`\`\``),
    ).generate(request);

    expect(meaning.description).toBe(answer.description);
  });

  it("takes the JSON object out of an answer wrapped in prose", async () => {
    const meaning = await generator(async () =>
      chatResponse(`설명드리겠습니다.\n${JSON.stringify(answer)}\n이상입니다.`),
    ).generate(request);

    expect(meaning.description).toBe(answer.description);
  });

  it("refuses an answer with no representative question rather than inventing one", async () => {
    // Grounding rejects a version without one, so accepting it here would only
    // move the failure later.
    const failed = generator(async () =>
      chatResponse(
        JSON.stringify({ ...answer, representativeQuestions: [] }),
      ),
    ).generate(request);

    await expect(failed).rejects.toMatchObject({
      kind: "malformed_response",
    });
  });

  it("refuses an answer that is not JSON at all", async () => {
    const failed = generator(async () =>
      chatResponse("죄송합니다, 답변할 수 없습니다."),
    ).generate(request);

    await expect(failed).rejects.toBeInstanceOf(CardMeaningGenerationError);
  });

  it("refuses an answer whose description is blank", async () => {
    const failed = generator(async () =>
      chatResponse(JSON.stringify({ ...answer, description: "   " })),
    ).generate(request);

    await expect(failed).rejects.toMatchObject({
      kind: "malformed_response",
    });
  });

  describe("whitespace normalisation", () => {
    // The approved read model refuses control characters, and newlines are
    // control characters. A model asked for two sentences may still answer in
    // two paragraphs; that is a formatting difference, not a bad answer.
    const sqlScope: RetrievalScope = {
      kind: "sql_source",
      reference: { scopeId: "scope_payments", scopeVersion: "scpv_a" },
      connector: "postgres.main",
      schema: "public",
      table: "payments",
      columns: ["status", "failed_reason"],
    };

    async function meaningFrom(answerOverrides: Record<string, unknown>) {
      return generator(async () =>
        chatResponse(JSON.stringify({ ...answer, ...answerOverrides })),
      ).generate(request);
    }

    it("folds a multi-line description into one line that grounds", async () => {
      const meaning = await meaningFrom({
        description: "결제 상태를 담는다.\n\n실패 사유도 함께 담는다.",
      });

      expect(meaning.description).toBe(
        "결제 상태를 담는다. 실패 사유도 함께 담는다.",
      );
      expect(
        groundCardVersion(coordinate, [sqlScope], meaning),
      ).toEqual({ outcome: "validated" });
    });

    it("replaces a newline with a space instead of dropping it", async () => {
      // Dropping would join the words on either side into one.
      const meaning = await meaningFrom({
        description: "payment\nstatus",
      });

      expect(meaning.description).toBe("payment status");
    });

    it("folds tabs and runs of spaces", async () => {
      const meaning = await meaningFrom({
        description: "결제\t상태와    실패 사유",
      });

      expect(meaning.description).toBe("결제 상태와 실패 사유");
    });

    it("normalises questions, aliases, and keywords too", async () => {
      const meaning = await meaningFrom({
        representativeQuestions: ["결제가\n왜 실패했나요?"],
        aliases: ["payment\thistory"],
        keywords: ["FAILED\nREASON"],
      });

      expect(meaning.representativeQuestions).toEqual([
        "결제가 왜 실패했나요?",
      ]);
      expect(meaning.aliases).toEqual(["payment history"]);
      expect(meaning.keywords).toEqual(["failed reason"]);
    });

    it("still fails on a control character that is not whitespace", async () => {
      // A NUL is not a formatting difference; it says the answer is broken.
      const failed = meaningFrom({ description: "결제\u0000상태" });

      await expect(failed).resolves.toMatchObject({
        description: "결제\u0000상태",
      });
      const meaning = await failed;
      expect(
        groundCardVersion(coordinate, [sqlScope], meaning).outcome,
      ).toBe("rejected");
    });

    it("refuses a description that is only whitespace", async () => {
      const failed = meaningFrom({ description: "\n\t  " });

      await expect(failed).rejects.toMatchObject({
        kind: "malformed_response",
      });
    });

    it("does not let folding slip a value past the length limit", async () => {
      // Folding shortens the text, so a value that was over the limit only
      // because of its whitespace may now fit. One that is genuinely too long
      // still has to be refused by grounding rather than trimmed here.
      const meaning = await meaningFrom({
        description: "가".repeat(1_025),
      });

      expect(meaning.description).toHaveLength(1_025);
      expect(
        groundCardVersion(coordinate, [sqlScope], meaning).outcome,
      ).toBe("rejected");
    });
  });
});
