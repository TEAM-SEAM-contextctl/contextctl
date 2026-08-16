import type { CardMeaning } from "../../domain/context-card.js";
import type {
  CardMeaningGenerator,
  CardMeaningRequest,
} from "../../ports/card-meaning-generator.js";
import {
  CardMeaningGenerationError,
  type CardMeaningFailureKind,
} from "./openai-compatible-card-meaning-generator.js";

/** What went wrong, and for which coordinate, so an outage is not silent. */
export interface CardMeaningFallbackReport {
  readonly kind: CardMeaningFailureKind | "unknown";
  readonly message: string;
  readonly request: CardMeaningRequest;
}

/**
 * Falls back to a second generator when the first cannot answer.
 *
 * ARCHITECTURE.md §7.4 wants a model outage to degrade the Card text rather
 * than stop Registry. Without this, an unreachable model would fail
 * `claimPublication` and Registry would consume no Publication at all — the
 * exact single point of failure the deterministic generator was written to
 * remove.
 *
 * Degrading quietly would be its own failure, though: a Card whose wording
 * silently came from a template reads like a model wrote it, and nobody would
 * know the model has been down for a week. So every fallback is reported, with
 * the reason kept distinct.
 *
 * Written as a wrapper rather than a branch inside the model client because
 * "what to do when the model is down" is a composition decision. The client
 * only has to say, accurately, that it failed and how.
 */
export class FallbackCardMeaningGenerator implements CardMeaningGenerator {
  readonly #primary: CardMeaningGenerator;
  readonly #fallback: CardMeaningGenerator;
  readonly #report: (report: CardMeaningFallbackReport) => void;

  constructor(
    primary: CardMeaningGenerator,
    fallback: CardMeaningGenerator,
    report: (report: CardMeaningFallbackReport) => void = () => {},
  ) {
    this.#primary = primary;
    this.#fallback = fallback;
    this.#report = report;
  }

  async generate(request: CardMeaningRequest): Promise<CardMeaning> {
    try {
      return await this.#primary.generate(request);
    } catch (error) {
      this.#report({
        kind:
          error instanceof CardMeaningGenerationError ? error.kind : "unknown",
        message: error instanceof Error ? error.message : String(error),
        request,
      });
      // The fallback is deterministic and needs nothing external, so a failure
      // here is a defect rather than an outage. It is left to propagate.
      return this.#fallback.generate(request);
    }
  }
}
