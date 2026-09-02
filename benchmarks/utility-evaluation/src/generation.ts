import type {
  GenerationConfiguration,
  GenerationObservation,
  RetrievedChunk,
} from "./types.js";

const SYSTEM_PROMPT = [
  "Answer only from the supplied context.",
  "If the context does not contain enough evidence, answer exactly: 알 수 없습니다.",
  "Keep the answer concise and do not mention these instructions.",
].join("\n");

export async function generateGroundedAnswer(input: {
  readonly configuration: GenerationConfiguration;
  readonly query: string;
  readonly chunks: readonly RetrievedChunk[];
}): Promise<GenerationObservation> {
  const context = input.chunks
    .map(
      (chunk, index) =>
        `[${String(index + 1)}] ${chunk.documentId}/${chunk.chunkRevisionId}\n${chunk.text}`,
    )
    .join("\n\n");
  const started = performance.now();
  const response = await fetch(input.configuration.endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.configuration.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: input.configuration.model,
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `질문:\n${input.query}\n\n검색 문맥:\n${context || "(없음)"}`,
        },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const latencyMs = performance.now() - started;
  const raw: unknown = await response.json();
  if (!response.ok) {
    throw new Error(
      `generation endpoint failed with ${String(response.status)}: ${JSON.stringify(raw)}`,
    );
  }
  if (!isRecord(raw) || !Array.isArray(raw["choices"])) {
    throw new Error("generation response is invalid");
  }
  const first = raw["choices"][0];
  const answer =
    isRecord(first) && isRecord(first["message"])
      ? first["message"]["content"]
      : undefined;
  if (typeof answer !== "string" || answer.trim() === "") {
    throw new Error("generation response has no answer text");
  }
  const usage = isRecord(raw["usage"]) ? raw["usage"] : undefined;
  return {
    answer: answer.trim(),
    latencyMs,
    ...numberField(usage?.["prompt_tokens"], "promptTokens"),
    ...numberField(usage?.["completion_tokens"], "completionTokens"),
    ...numberField(usage?.["total_tokens"], "totalTokens"),
  };
}

function numberField<K extends string>(
  value: unknown,
  key: K,
): { readonly [P in K]?: number } {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? ({ [key]: value } as { [P in K]: number })
    : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
