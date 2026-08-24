import type { ApprovedCard } from "../../src/domain/card-catalog.js";
import type { CandidateScore } from "../../src/domain/query-scoring.js";
import {
  DEFAULT_SELECTION_THRESHOLDS,
  judgeCandidates,
  type SelectionVerdict,
} from "../../src/domain/selection-verdict.js";
import {
  SELECTION_EVAL_CARDS,
  SELECTION_EVAL_CASES,
  type SelectionEvalCase,
  type SelectionEvalCategory,
  type SelectionEvalLanguage,
  type SelectionEvalSourceKind,
  type SelectionEvalSplit,
} from "./selection-eval-v1.js";

export interface SelectionEvalScoringResult {
  readonly candidates: readonly CandidateScore[];
  readonly embeddingCalls: number;
  readonly elapsedMs: number;
}

export interface SelectionEvalMetrics {
  readonly queryCount: number;
  readonly requiredRecallAt5: number;
  readonly admittedRequiredRecall: number;
  readonly multiFullSetRecall: number;
  readonly verdictMacroF1: number;
  readonly ambiguousAdmitDeferMacroF1: number;
  readonly unrelatedFalseAdmitRate: number;
  readonly forbiddenAdmits: number;
  readonly averageCandidateCount: number;
  readonly p95LatencyMs: number;
  readonly embeddingCalls: number;
  readonly maxEmbeddingCallsPerQuery: number;
}

export interface SelectionEvalReport {
  readonly calibration: SelectionEvalMetrics;
  readonly holdout: SelectionEvalMetrics;
  readonly all: SelectionEvalMetrics;
  readonly cases: readonly SelectionEvalCaseResult[];
}

export interface SelectionEvalCaseResult {
  readonly id: string;
  readonly split: SelectionEvalSplit;
  readonly category: SelectionEvalCategory;
  readonly top5: readonly string[];
  readonly admitted: readonly string[];
  readonly deferred: readonly string[];
  readonly forbiddenAdmits: readonly string[];
  readonly candidateCount: number;
  readonly elapsedMs: number;
  readonly embeddingCalls: number;
  readonly expectedByCard: Readonly<Record<string, SelectionVerdict>>;
  readonly actualByCard: Readonly<Record<string, SelectionVerdict>>;
}

export interface SelectionEvalGateResult {
  readonly passed: boolean;
  readonly failures: readonly string[];
}

/**
 * Refuses a corpus whose shape could inflate one aggregate while omitting a
 * source kind, language or split required by the final design.
 */
export function assertSelectionEvalDataset(): void {
  const problems: string[] = [];
  const cardsById = new Map(SELECTION_EVAL_CARDS.map((card) => [card.cardId, card]));
  if (cardsById.size !== SELECTION_EVAL_CARDS.length) problems.push("duplicate Card id");
  if (new Set(SELECTION_EVAL_CASES.map((entry) => entry.id)).size !== 50) {
    problems.push("query ids are not 50 unique values");
  }
  assertCount(problems, "query", SELECTION_EVAL_CASES.length, 50);
  assertCount(problems, "calibration", countBy("split", "calibration"), 30);
  assertCount(problems, "holdout", countBy("split", "holdout"), 20);
  for (const [category, expected] of Object.entries({
    single: 15,
    multi: 15,
    unrelated: 10,
    ambiguous: 10,
  }) as readonly (readonly [SelectionEvalCategory, number])[]) {
    assertCount(problems, category, countBy("category", category), expected);
  }
  for (const [language, expected] of Object.entries({ ko: 25, en: 15, mixed: 10 }) as readonly (
    readonly [SelectionEvalLanguage, number]
  )[]) {
    assertCount(problems, language, countBy("language", language), expected);
    assertPresentInBothSplits(problems, language, (entry) => entry.language === language);
  }

  let crossSourceMulti = 0;
  const requiredSourceCount = new Map<SelectionEvalSourceKind, number>();
  for (const entry of SELECTION_EVAL_CASES) {
    const verdictLabels = [...entry.expectedAdmit, ...entry.expectedDefer, ...entry.forbidden];
    const listed = [...entry.relevant, ...verdictLabels];
    if (new Set(verdictLabels).size !== verdictLabels.length) {
      problems.push(`${entry.id}: a Card occurs in more than one verdict label set`);
    }
    for (const cardId of listed) {
      if (!cardsById.has(cardId)) problems.push(`${entry.id}: unknown Card ${cardId}`);
    }
    if (entry.category === "single" && entry.relevant.length !== 1) {
      problems.push(`${entry.id}: single query must have one relevant Card`);
    }
    if (entry.category === "multi" && entry.relevant.length < 2) {
      problems.push(`${entry.id}: multi query must have at least two relevant Cards`);
    }
    if (entry.category === "unrelated" && entry.relevant.length !== 0) {
      problems.push(`${entry.id}: unrelated query has a relevant Card`);
    }
    const sourceKinds = new Set(
      entry.relevant.flatMap((cardId) => sourceKindsOf(cardsById.get(cardId))),
    );
    if (entry.category === "multi" && sourceKinds.size >= 2) crossSourceMulti += 1;
    for (const sourceKind of sourceKinds) {
      requiredSourceCount.set(sourceKind, (requiredSourceCount.get(sourceKind) ?? 0) + 1);
    }
  }
  if (crossSourceMulti < 10) problems.push(`${crossSourceMulti} cross-source multi queries, fewer than 10`);
  for (const sourceKind of ["managed_document", "sql_source", "http_source"] as const) {
    if ((requiredSourceCount.get(sourceKind) ?? 0) < 10) {
      problems.push(`${sourceKind} occurs in fewer than 10 relevant query labels`);
    }
    assertPresentInBothSplits(problems, sourceKind, (entry) =>
      entry.relevant.some((cardId) => sourceKindsOf(cardsById.get(cardId)).includes(sourceKind)),
    );
  }
  if (problems.length > 0) {
    throw new Error(`selection-eval-v1 is not usable: ${problems.join("; ")}`);
  }
}

export async function evaluateSelection(
  score: (query: string) => Promise<SelectionEvalScoringResult>,
): Promise<SelectionEvalReport> {
  assertSelectionEvalDataset();
  const cardIds = SELECTION_EVAL_CARDS.map((card) => card.cardId);
  const cases: SelectionEvalCaseResult[] = [];
  for (const entry of SELECTION_EVAL_CASES) {
    const measured = await score(entry.query);
    const judged = judgeCandidates(measured.candidates, DEFAULT_SELECTION_THRESHOLDS);
    const expectedByCard = Object.fromEntries(
      cardIds.map((cardId) => [cardId, expectedVerdict(entry, cardId)]),
    ) as Record<string, SelectionVerdict>;
    const actualByCard = Object.fromEntries(
      judged.outcomes.map((outcome) => [outcome.cardId, outcome.verdict]),
    ) as Record<string, SelectionVerdict>;
    cases.push({
      id: entry.id,
      split: entry.split,
      category: entry.category,
      top5: judged.provenance.ranked.slice(0, 5).map((candidate) => candidate.cardId),
      admitted: judged.outcomes.filter((outcome) => outcome.verdict === "admit").map((outcome) => outcome.cardId),
      deferred: judged.outcomes.filter((outcome) => outcome.verdict === "defer").map((outcome) => outcome.cardId),
      forbiddenAdmits: entry.forbidden.filter((cardId) => actualByCard[cardId] === "admit"),
      candidateCount: measured.candidates.length,
      elapsedMs: measured.elapsedMs,
      embeddingCalls: measured.embeddingCalls,
      expectedByCard,
      actualByCard,
    });
  }
  return {
    calibration: summarize(cases.filter((entry) => entry.split === "calibration")),
    holdout: summarize(cases.filter((entry) => entry.split === "holdout")),
    all: summarize(cases),
    cases,
  };
}

/** Applies every release threshold that can be decided from an eval report. */
export function selectionEvalGate(
  lexical: SelectionEvalReport,
  hybrid: SelectionEvalReport,
): SelectionEvalGateResult {
  const failures: string[] = [];
  const holdout = hybrid.holdout;
  minimum(failures, "required recall@5", holdout.requiredRecallAt5, 0.9);
  minimum(failures, "admitted required recall", holdout.admittedRequiredRecall, 0.8);
  minimum(failures, "verdict macro F1", holdout.verdictMacroF1, 0.75);
  minimum(failures, "multi full-set recall", holdout.multiFullSetRecall, 0.75);
  maximum(failures, "unrelated false-admit rate", holdout.unrelatedFalseAdmitRate, 0.1);
  if (holdout.forbiddenAdmits !== 0) failures.push(`forbidden admits ${holdout.forbiddenAdmits}, expected 0`);
  if (holdout.admittedRequiredRecall < lexical.holdout.admittedRequiredRecall) {
    failures.push("hybrid admitted-required recall is lower than lexical");
  }
  if (holdout.unrelatedFalseAdmitRate > lexical.holdout.unrelatedFalseAdmitRate) {
    failures.push("hybrid unrelated false-admit rate is higher than lexical");
  }
  const ambiguousImprovement =
    holdout.ambiguousAdmitDeferMacroF1 - lexical.holdout.ambiguousAdmitDeferMacroF1;
  if (ambiguousImprovement < 0.05) {
    failures.push(`ambiguous admit/defer macro F1 improvement ${ambiguousImprovement}, expected at least 0.05`);
  }
  if (holdout.maxEmbeddingCallsPerQuery > 1) {
    failures.push(`query embedding calls ${holdout.maxEmbeddingCallsPerQuery}, expected at most 1`);
  }
  return { passed: failures.length === 0, failures };
}

function summarize(results: readonly SelectionEvalCaseResult[]): SelectionEvalMetrics {
  const definitions = new Map(SELECTION_EVAL_CASES.map((entry) => [entry.id, entry]));
  let relevantTotal = 0;
  let relevantTop5 = 0;
  let expectedAdmitTotal = 0;
  let admittedRequired = 0;
  let multiCount = 0;
  let multiFullSet = 0;
  let unrelatedCount = 0;
  let unrelatedFalseAdmit = 0;
  let forbiddenAdmits = 0;
  const allExpected: SelectionVerdict[] = [];
  const allActual: SelectionVerdict[] = [];
  const ambiguousExpected: SelectionVerdict[] = [];
  const ambiguousActual: SelectionVerdict[] = [];

  for (const result of results) {
    const definition = definitions.get(result.id);
    if (definition === undefined) throw new Error(`unknown selection eval result ${result.id}`);
    relevantTotal += definition.relevant.length;
    relevantTop5 += definition.relevant.filter((cardId) => result.top5.includes(cardId)).length;
    expectedAdmitTotal += definition.expectedAdmit.length;
    admittedRequired += definition.expectedAdmit.filter((cardId) => result.admitted.includes(cardId)).length;
    if (definition.category === "multi") {
      multiCount += 1;
      if (definition.expectedAdmit.every((cardId) => result.admitted.includes(cardId))) multiFullSet += 1;
    }
    if (definition.category === "unrelated") {
      unrelatedCount += 1;
      if (result.admitted.length > 0) unrelatedFalseAdmit += 1;
    }
    forbiddenAdmits += result.forbiddenAdmits.length;
    const expectedQueryVerdict = queryVerdict(
      definition.expectedAdmit.length,
      definition.expectedDefer.length,
    );
    const actualQueryVerdict = queryVerdict(result.admitted.length, result.deferred.length);
    allExpected.push(expectedQueryVerdict);
    allActual.push(actualQueryVerdict);
    if (definition.category === "ambiguous") {
      ambiguousExpected.push(expectedQueryVerdict);
      ambiguousActual.push(actualQueryVerdict);
    }
  }
  const elapsed = results.map((entry) => entry.elapsedMs).sort((left, right) => left - right);
  return {
    queryCount: results.length,
    requiredRecallAt5: ratio(relevantTop5, relevantTotal),
    admittedRequiredRecall: ratio(admittedRequired, expectedAdmitTotal),
    multiFullSetRecall: ratio(multiFullSet, multiCount),
    verdictMacroF1: macroF1(allExpected, allActual, ["admit", "defer", "reject"]),
    ambiguousAdmitDeferMacroF1: macroF1(ambiguousExpected, ambiguousActual, ["admit", "defer"]),
    unrelatedFalseAdmitRate: ratio(unrelatedFalseAdmit, unrelatedCount),
    forbiddenAdmits,
    averageCandidateCount: ratio(results.reduce((sum, entry) => sum + entry.candidateCount, 0), results.length),
    p95LatencyMs: percentile95(elapsed),
    embeddingCalls: results.reduce((sum, entry) => sum + entry.embeddingCalls, 0),
    maxEmbeddingCallsPerQuery: Math.max(0, ...results.map((entry) => entry.embeddingCalls)),
  };
}

function expectedVerdict(entry: SelectionEvalCase, cardId: string): SelectionVerdict {
  if (entry.expectedAdmit.includes(cardId)) return "admit";
  if (entry.expectedDefer.includes(cardId)) return "defer";
  return "reject";
}

function queryVerdict(admitted: number, deferred: number): SelectionVerdict {
  if (admitted > 0) return "admit";
  if (deferred > 0) return "defer";
  return "reject";
}

function macroF1(
  expected: readonly SelectionVerdict[],
  actual: readonly SelectionVerdict[],
  labels: readonly SelectionVerdict[],
): number {
  return labels.reduce((sum, label) => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (let index = 0; index < expected.length; index += 1) {
      if (expected[index] === label && actual[index] === label) tp += 1;
      else if (expected[index] !== label && actual[index] === label) fp += 1;
      else if (expected[index] === label && actual[index] !== label) fn += 1;
    }
    return sum + (tp === 0 ? 0 : (2 * tp) / (2 * tp + fp + fn));
  }, 0) / labels.length;
}

function sourceKindsOf(card: ApprovedCard | undefined): readonly SelectionEvalSourceKind[] {
  return card?.scopes.map((scope) => scope.kind) ?? [];
}

function countBy<K extends "split" | "category" | "language">(
  key: K,
  value: SelectionEvalCase[K],
): number {
  return SELECTION_EVAL_CASES.filter((entry) => entry[key] === value).length;
}

function assertPresentInBothSplits(
  problems: string[],
  name: string,
  predicate: (entry: SelectionEvalCase) => boolean,
): void {
  for (const split of ["calibration", "holdout"] as const) {
    if (!SELECTION_EVAL_CASES.some((entry) => entry.split === split && predicate(entry))) {
      problems.push(`${name} is absent from ${split}`);
    }
  }
}

function assertCount(problems: string[], name: string, actual: number, expected: number): void {
  if (actual !== expected) problems.push(`${name} count ${actual}, expected ${expected}`);
}

function minimum(failures: string[], name: string, actual: number, threshold: number): void {
  if (actual < threshold) failures.push(`${name} ${actual}, expected at least ${threshold}`);
}

function maximum(failures: string[], name: string, actual: number, threshold: number): void {
  if (actual > threshold) failures.push(`${name} ${actual}, expected at most ${threshold}`);
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function percentile95(sorted: readonly number[]): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.ceil(sorted.length * 0.95) - 1] as number;
}
