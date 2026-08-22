import type { PublishedSourceCoordinate } from "@contextctl/contracts";
import { describe, expect, it } from "vitest";

import type { CardMeaning } from "../../src/domain/context-card.js";
import { DeterministicCardMeaningGenerator } from "../../src/infrastructure/deterministic-card-meaning-generator.js";
import {
  FallbackCardMeaningGenerator,
  type CardMeaningFallbackReport,
} from "../../src/infrastructure/llm/fallback-card-meaning-generator.js";
import { CardMeaningGenerationError } from "../../src/infrastructure/llm/openai-compatible-card-meaning-generator.js";
import type {
  CardMeaningGenerator,
  CardMeaningRequest,
} from "../../src/ports/card-meaning-generator.js";

const coordinate: PublishedSourceCoordinate = {
  kind: "document",
  sourceId: "src_payments",
  documentId: "doc_payments",
  semanticUnitId: "unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd",
};

const request: CardMeaningRequest = {
  coordinate,
  facts: [{ name: "section.label", value: "결제 실패" }],
};

const modelMeaning: CardMeaning = {
  description: "모델이 쓴 설명",
  representativeQuestions: ["결제가 왜 실패했나요?"],
  aliases: [],
  keywords: [],
};

const modelAnswer = {
  meaning: modelMeaning,
  origin: { generator: "model", model: "gemma4-12b-qat" },
} as const;

function failing(error: unknown): CardMeaningGenerator {
  return {
    generate: async () => {
      throw error;
    },
  };
}

describe("FallbackCardMeaningGenerator", () => {
  it("uses the model when it answers", async () => {
    const reports: CardMeaningFallbackReport[] = [];
    const generator = new FallbackCardMeaningGenerator(
      { generate: async () => modelAnswer },
      new DeterministicCardMeaningGenerator(),
      { primaryModel: "gemma4-12b-qat", report: (report) => reports.push(report) },
    );

    // The origin passes through untouched: nothing degraded, so nothing may
    // claim it did.
    await expect(generator.generate(request)).resolves.toEqual(modelAnswer);
    expect(reports).toEqual([]);
  });

  it("keeps producing meaning when the model is unreachable", async () => {
    // A failing model must degrade the wording, not stop Registry from
    // consuming the Publication at all (ARCHITECTURE 7.4).
    const generator = new FallbackCardMeaningGenerator(
      failing(new CardMeaningGenerationError("transport", "unreachable")),
      new DeterministicCardMeaningGenerator(),
      { primaryModel: "gemma4-12b-qat" },
    );

    const { meaning, origin } = await generator.generate(request);

    expect(meaning.description).toContain("unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd");
    // The durable trace of the outage, on the version it shaped: the words are
    // the deterministic generator's, and the origin says which model was down.
    expect(origin).toEqual({
      generator: "deterministic",
      fallbackFromModel: "gemma4-12b-qat",
    });
  });

  it("reports each fallback with the reason kept distinct", async () => {
    const reports: CardMeaningFallbackReport[] = [];
    const deterministic = new DeterministicCardMeaningGenerator();
    for (const kind of ["timeout", "http_status"] as const) {
      await new FallbackCardMeaningGenerator(
        failing(new CardMeaningGenerationError(kind, `${kind} happened`)),
        deterministic,
        { primaryModel: "gemma4-12b-qat", report: (report) => reports.push(report) },
      ).generate(request);
    }

    // Degrading quietly would hide a model that has been down for a week, and
    // a delay calls for a different response than an outright refusal.
    expect(reports.map((report) => report.kind)).toEqual([
      "timeout",
      "http_status",
    ]);
    expect(reports[0]?.request).toBe(request);
  });

  it("reports an unexpected failure as unknown rather than swallowing it", async () => {
    const reports: CardMeaningFallbackReport[] = [];
    const generator = new FallbackCardMeaningGenerator(
      failing(new Error("something else broke")),
      new DeterministicCardMeaningGenerator(),
      { primaryModel: "gemma4-12b-qat", report: (report) => reports.push(report) },
    );

    await generator.generate(request);

    expect(reports[0]?.kind).toBe("unknown");
    expect(reports[0]?.message).toBe("something else broke");
  });

  it("lets a fallback failure propagate instead of hiding a defect", async () => {
    // The deterministic generator needs nothing external, so its failing is a
    // bug in us, not an outage to absorb.
    const generator = new FallbackCardMeaningGenerator(
      failing(new CardMeaningGenerationError("timeout", "slow")),
      failing(new Error("deterministic generator is broken")),
      { primaryModel: "gemma4-12b-qat" },
    );

    await expect(generator.generate(request)).rejects.toThrow(
      "deterministic generator is broken",
    );
  });
});
