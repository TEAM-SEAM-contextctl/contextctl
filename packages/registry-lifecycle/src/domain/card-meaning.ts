/** Expression fields an LLM may generate; grounded against Observation before use. */
export interface CardMeaning {
  readonly description: string;
  readonly representativeQuestions: readonly string[];
  readonly aliases: readonly string[];
  readonly keywords: readonly string[];
}

/**
 * What produced a meaning, kept on the version so degradation is visible.
 *
 * The design's answer to "the operator cannot tell that generation quality
 * degraded" is not to refuse — the deterministic generator is the operating
 * baseline — but to show what wrote the words. A meaning that silently came
 * from a template reads like a model wrote it, and without this record nobody
 * would know the model had been down for a week.
 *
 * `model` names the model only. Base URLs, credentials and provider responses
 * never enter the domain (SEAM-106 §9.3).
 */
export interface CardMeaningOrigin {
  readonly generator: "deterministic" | "model";
  /** The model that wrote the text, when `generator` is `model`. */
  readonly model?: string | undefined;
  /**
   * Set when a model failed and the deterministic generator filled in. The
   * failure itself goes to operator diagnostics; this is the durable trace on
   * the version the outage actually shaped.
   */
  readonly fallbackFromModel?: string | undefined;
}
