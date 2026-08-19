import { describe, expect, it } from "vitest";

import type { CardMeaningRequest } from "@contextctl/registry-lifecycle";

import {
  CARD_MEANING_API_KEY_VARIABLE,
  cardMeaningRequestUrl,
  CARD_MEANING_BASE_URL_VARIABLE,
  CARD_MEANING_CONTEXT_TOKENS_VARIABLE,
  CARD_MEANING_MAX_OUTPUT_TOKENS_VARIABLE,
  CARD_MEANING_MODEL_VARIABLE,
  CARD_MEANING_TIMEOUT_MS_VARIABLE,
  maskSecret,
  resolveCardMeaningBackend,
  type CardMeaningBackend,
} from "../../src/cli/meaning-generator.js";

const SECRET = "sk-super-secret";

const request: CardMeaningRequest = {
  coordinate: {
    kind: "document",
    sourceId: "src_1",
    documentId: "doc_a",
    semanticUnitId: "unit_b",
  },
  facts: [{ name: "document.title", value: "운영 안내" }],
};

const fullEnvironment: Record<string, string> = {
  [CARD_MEANING_BASE_URL_VARIABLE]: "https://gllm.example.test",
  [CARD_MEANING_MODEL_VARIABLE]: "gemma4-12b-qat",
  [CARD_MEANING_API_KEY_VARIABLE]: SECRET,
};

/** Collects what the caller would have written to stderr, instead of writing it. */
function resolveWith(
  environment: Readonly<Partial<Record<string, string>>>,
  fetchStub?: typeof globalThis.fetch,
): { readonly backend: CardMeaningBackend; readonly fallbacks: string[] } {
  const fallbacks: string[] = [];
  const backend = resolveCardMeaningBackend({
    environment,
    onFallback: (message) => fallbacks.push(message),
    ...(fetchStub === undefined ? {} : { fetch: fetchStub }),
  });
  return { backend, fallbacks };
}

function chatCompletion(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("resolveCardMeaningBackend", () => {
  it("uses the deterministic generator when nothing is configured", () => {
    const { backend } = resolveWith({});

    expect(backend.kind).toBe("deterministic");
    // No notice: an unconfigured model is the documented default, and warning
    // about the default would train the operator to ignore this channel.
    expect(backend.notices).toHaveLength(0);
    expect(backend.model).toBeUndefined();
    expect(backend.endpoint).toBeUndefined();
  });

  it("binds the model when all three variables are set", () => {
    const { backend } = resolveWith(fullEnvironment);

    expect(backend.kind).toBe("llm_with_fallback");
    expect(backend.model).toBe("gemma4-12b-qat");
    expect(backend.endpoint).toBe("https://gllm.example.test");
    expect(backend.notices).toHaveLength(0);
  });

  // A partial configuration is the case that must never be silent: the only
  // other symptom is Cards whose keywords carry identifiers and nothing else.
  const partialCases: ReadonlyArray<{
    readonly label: string;
    readonly set: readonly string[];
  }> = [
    { label: "base URL only", set: [CARD_MEANING_BASE_URL_VARIABLE] },
    { label: "model only", set: [CARD_MEANING_MODEL_VARIABLE] },
    { label: "API key only", set: [CARD_MEANING_API_KEY_VARIABLE] },
    {
      label: "base URL and model",
      set: [CARD_MEANING_BASE_URL_VARIABLE, CARD_MEANING_MODEL_VARIABLE],
    },
    {
      label: "base URL and API key",
      set: [CARD_MEANING_BASE_URL_VARIABLE, CARD_MEANING_API_KEY_VARIABLE],
    },
    {
      label: "model and API key",
      set: [CARD_MEANING_MODEL_VARIABLE, CARD_MEANING_API_KEY_VARIABLE],
    },
  ];

  for (const { label, set } of partialCases) {
    it(`warns by variable name when only the ${label} is set`, () => {
      const environment: Record<string, string> = {};
      for (const variable of set) {
        const value = fullEnvironment[variable];
        expect(value).toBeDefined();
        environment[variable] = value ?? "";
      }
      const missing = Object.keys(fullEnvironment).filter(
        (variable) => !set.includes(variable),
      );

      const { backend } = resolveWith(environment);

      expect(backend.kind).toBe("deterministic");
      expect(backend.notices).toHaveLength(1);
      const notice = backend.notices[0] ?? "";
      for (const variable of missing) {
        expect(notice).toContain(variable);
      }
      expect(notice).not.toContain(SECRET);
    });
  }

  it("treats a blank variable as unset", () => {
    const { backend } = resolveWith({
      ...fullEnvironment,
      [CARD_MEANING_API_KEY_VARIABLE]: "  ",
    });

    expect(backend.kind).toBe("deterministic");
    expect(backend.notices).toHaveLength(1);
    expect(backend.notices[0]).toContain(CARD_MEANING_API_KEY_VARIABLE);
  });

  const numericVariables = [
    CARD_MEANING_TIMEOUT_MS_VARIABLE,
    CARD_MEANING_CONTEXT_TOKENS_VARIABLE,
    CARD_MEANING_MAX_OUTPUT_TOKENS_VARIABLE,
  ];

  for (const variable of numericVariables) {
    for (const rejected of ["abc", "0", "-5", "2.5"]) {
      it(`rejects ${variable}=${rejected} instead of using the default`, () => {
        expect(() => resolveWith({ [variable]: rejected })).toThrow(TypeError);
      });
    }

    it(`accepts a positive integer for ${variable}`, () => {
      const { backend } = resolveWith({
        ...fullEnvironment,
        [variable]: "1000",
      });

      expect(backend.kind).toBe("llm_with_fallback");
    });
  }

  it("never carries the credential in anything the caller may print", () => {
    const { backend } = resolveWith({
      ...fullEnvironment,
      // A base URL that embeds the credential is the realistic leak: some
      // deployments put the token in the path.
      [CARD_MEANING_BASE_URL_VARIABLE]: `https://gllm.example.test/${SECRET}`,
    });

    expect(backend.endpoint).not.toContain(SECRET);
    expect(backend.model).not.toContain(SECRET);
    for (const notice of backend.notices) {
      expect(notice).not.toContain(SECRET);
    }
  });

  it("falls back to deterministic text and masks the credential in the report", async () => {
    // The credential is planted inside the transport error on purpose: the
    // report's message is not text this module wrote, and the mask has to hold
    // regardless of what the runtime put in there.
    const failingFetch: typeof globalThis.fetch = () =>
      Promise.reject(new Error(`connect ECONNREFUSED ${SECRET}`));
    const { backend, fallbacks } = resolveWith(fullEnvironment, failingFetch);

    const meaning = await backend.generator.generate(request);

    expect(meaning.description).toBe(
      "Semantic unit unit_b of document doc_a. document.title: 운영 안내",
    );
    expect(fallbacks).toHaveLength(1);
    const message = fallbacks[0] ?? "";
    expect(message).not.toContain(SECRET);
    expect(message).toContain("***");
    expect(message).toContain("transport");
    // The coordinate is what makes the line actionable.
    expect(message).toContain("doc_a/unit_b");
  });

  it("returns the model's own meaning when the call succeeds", async () => {
    const written = {
      description: "운영 안내 문서의 배포 절차 요약",
      representativeQuestions: ["운영 안내는 어떤 절차를 설명하나요?"],
      aliases: ["운영 안내"],
      keywords: ["운영", "배포절차"],
    };
    const requestedUrls: string[] = [];
    const okFetch: typeof globalThis.fetch = (url) => {
      requestedUrls.push(String(url));
      return Promise.resolve(
        // The deployed model wraps its JSON in a code fence; the reader is
        // expected to tolerate that, so the stub reproduces it.
        chatCompletion(`\`\`\`json\n${JSON.stringify(written)}\n\`\`\``),
      );
    };
    const { backend, fallbacks } = resolveWith(fullEnvironment, okFetch);

    const meaning = await backend.generator.generate(request);

    expect(meaning).toEqual(written);
    expect(fallbacks).toHaveLength(0);
    expect(requestedUrls).toEqual([
      "https://gllm.example.test/v1/chat/completions",
    ]);
  });
});

describe("maskSecret", () => {
  it("leaves the text alone when there is no secret", () => {
    expect(maskSecret("bearer token", undefined)).toBe("bearer token");
    expect(maskSecret("bearer token", "")).toBe("bearer token");
  });

  it("replaces every occurrence", () => {
    expect(maskSecret(`${SECRET} and ${SECRET}`, SECRET)).toBe("*** and ***");
  });

  it("leaves text that does not contain the secret alone", () => {
    expect(maskSecret("nothing sensitive here", SECRET)).toBe(
      "nothing sensitive here",
    );
  });

  it("handles a secret carrying regex metacharacters", () => {
    // The credential is arbitrary text; treating it as a pattern would either
    // throw or match the wrong thing.
    expect(maskSecret("a.+b in the middle", "a.+b")).toBe("*** in the middle");
  });
});

describe("base URL that already carries the version prefix", () => {
  const complete = (baseUrl: string) => ({
    CONTEXTCTL_CARD_MEANING_BASE_URL: baseUrl,
    CONTEXTCTL_CARD_MEANING_MODEL: "gemma4-12b-qat",
    CONTEXTCTL_CARD_MEANING_API_KEY: "sk-super-secret",
  });

  it("builds the URL the adapter will request", () => {
    // Mirrors `openai-compatible-card-meaning-generator.ts`, which appends this
    // path privately. `doctor` shows the result so an operator can compare it
    // against the endpoint they verified by hand.
    expect(cardMeaningRequestUrl("https://host.example.com")).toBe(
      "https://host.example.com/v1/chat/completions",
    );
    expect(cardMeaningRequestUrl("https://host.example.com/")).toBe(
      "https://host.example.com/v1/chat/completions",
    );
  });

  it("warns when the root ends in /v1, with the doubled URL and the fix", () => {
    const backend = resolveCardMeaningBackend({
      environment: complete("https://gllm.dilato.kr/v1"),
      onFallback: () => {},
    });

    expect(backend.kind).toBe("llm_with_fallback");
    expect(backend.notices).toHaveLength(1);
    const notice = backend.notices[0] ?? "";
    // The doubled path, because naming it is what makes the 404 legible.
    expect(notice).toContain("https://gllm.dilato.kr/v1/v1/chat/completions");
    // And the value to use instead, because a warning without a fix is a note.
    expect(notice).toContain("https://gllm.dilato.kr");
  });

  it("warns for a trailing slash after the prefix too", () => {
    const backend = resolveCardMeaningBackend({
      environment: complete("https://gllm.dilato.kr/v1/"),
      onFallback: () => {},
    });

    expect(backend.notices).toHaveLength(1);
  });

  it("stays silent for a root without the prefix", () => {
    const backend = resolveCardMeaningBackend({
      environment: complete("https://gllm.dilato.kr"),
      onFallback: () => {},
    });

    expect(backend.kind).toBe("llm_with_fallback");
    expect(backend.notices).toEqual([]);
  });

  it("does not trim the prefix away on the operator's behalf", () => {
    const backend = resolveCardMeaningBackend({
      environment: complete("https://gllm.dilato.kr/v1"),
      onFallback: () => {},
    });

    // A deployment may genuinely serve its API under its own `/v1`. Rewriting
    // the setting would send the request somewhere the operator never named and
    // replace a legible 404 with a silent one.
    expect(backend.endpoint).toBe("https://gllm.dilato.kr/v1");
  });

  it("keeps the credential out of the warning", () => {
    const backend = resolveCardMeaningBackend({
      environment: complete("https://gllm.dilato.kr/v1"),
      onFallback: () => {},
    });

    expect(JSON.stringify(backend.notices)).not.toContain("sk-super-secret");
  });
});
