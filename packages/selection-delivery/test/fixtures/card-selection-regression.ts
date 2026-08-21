import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { ApprovedCard } from "../../src/domain/card-catalog.js";
import { scoreCardsAgainstQuery } from "../../src/domain/query-scoring.js";
import {
  DEFAULT_SELECTION_THRESHOLDS,
  judgeCandidates,
  type SelectionThresholds,
} from "../../src/domain/selection-verdict.js";

/**
 * The regression set behind SEAM-100, and the four measurements SEAM-106 §6.2
 * asks to be held together: top-1 accuracy, the share of admits that were
 * wrong, the gap between first and second place, and how much of the verdict
 * space is defer and reject.
 *
 * A test fixture rather than domain code, on the pattern of Ingestion's
 * `document-retrieval-eval.ts`: nothing at runtime consumes these numbers, and
 * exporting an evaluator from `src/` would widen the package's surface for a
 * consumer that does not exist. Everything here is computed through the
 * domain's public functions — `scoreCardsAgainstQuery` and `judgeCandidates` —
 * so the report describes exactly what a lexical selection would have done.
 */

const DATASET_DIRECTORY = new URL("./card-selection-regression-v1/", import.meta.url);

export type RegressionGenerator = "llm" | "deterministic";

export type RegressionCategory =
  | "body_vocabulary"
  | "adjacent_wrong_section"
  | "similar_term_other_document"
  | "no_answer_or_low_confidence"
  | "multiple_cards_required";

export const REGRESSION_CATEGORIES: readonly RegressionCategory[] = [
  "body_vocabulary",
  "adjacent_wrong_section",
  "similar_term_other_document",
  "no_answer_or_low_confidence",
  "multiple_cards_required",
];

export interface RegressionCard {
  /** Human-readable `document/§section` name the queries refer to. */
  readonly label: string;
  readonly cardId: string;
  readonly versionId: string;
  readonly meaning: ApprovedCard["meaning"];
  readonly policy: ApprovedCard["policy"];
  readonly scope: { readonly documentId: string; readonly semanticUnitId: string };
}

export interface RegressionCardSet {
  readonly datasetId: string;
  readonly version: string;
  readonly generator: RegressionGenerator;
  readonly generatorDetail: string;
  readonly sourceCommit: string;
  readonly generatedAt: string;
  readonly documents: readonly { readonly path: string; readonly sha256: string }[];
  readonly cards: readonly RegressionCard[];
  /** sha256 of the file bytes, so a report names the input it measured. */
  readonly digest: string;
}

export interface RegressionQuery {
  readonly id: string;
  readonly category: RegressionCategory;
  readonly text: string;
  /** Every one of these must be admitted. Empty for a query with no answer. */
  readonly required: readonly string[];
  /** Admitting one of these is not counted as wrong. */
  readonly optional: readonly string[];
  /** Admitting one of these is a forbidden admit: another section of the same document. */
  readonly forbidden: readonly string[];
  /** Only in the no-answer category: `none` must admit nothing; `low` has an answer the lexical path cannot reach. */
  readonly confidence?: "none" | "low";
  readonly note: string;
}

export interface RegressionQuerySet {
  readonly datasetId: string;
  readonly version: string;
  readonly queries: readonly RegressionQuery[];
  readonly digest: string;
}

export async function loadRegressionCards(
  generator: RegressionGenerator,
): Promise<RegressionCardSet> {
  const file = fileURLToPath(new URL(`./cards.${generator}.json`, DATASET_DIRECTORY));
  const bytes = await readFile(file);
  const parsed = JSON.parse(bytes.toString("utf8")) as Omit<RegressionCardSet, "digest">;
  return { ...parsed, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
}

export async function loadRegressionQueries(): Promise<RegressionQuerySet> {
  const file = fileURLToPath(new URL("./queries.json", DATASET_DIRECTORY));
  const bytes = await readFile(file);
  const parsed = JSON.parse(bytes.toString("utf8")) as Omit<RegressionQuerySet, "digest">;
  return { ...parsed, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
}

export interface RegressionBaseline {
  readonly datasetId: string;
  readonly version: string;
  readonly measuredAt: string;
  readonly scoringPolicyVersion: string;
  readonly rankingPolicyVersion: string;
  readonly thresholds: SelectionThresholds;
  readonly snapshots: Readonly<Record<RegressionGenerator, RegressionBaselineSnapshot>>;
}

export interface RegressionBaselineSnapshot {
  readonly cardsDigest: string;
  readonly queriesDigest: string;
  readonly metrics: RegressionMetrics;
  readonly byCategory: Readonly<Record<RegressionCategory, RegressionMetrics>>;
}

export async function loadRegressionBaseline(): Promise<RegressionBaseline> {
  const file = fileURLToPath(new URL("./baseline.json", DATASET_DIRECTORY));
  return JSON.parse((await readFile(file)).toString("utf8")) as RegressionBaseline;
}

/**
 * Refuses a dataset that could pass a gate without measuring anything.
 *
 * Fewer than 25 queries, a category with no query in it, a query naming a Card
 * that is not in the set, a Card listed on two sides of one query, or a
 * duplicated identifier would each make a reported number smaller or larger
 * rather than wrong — which is worse, because nothing would say so.
 */
export function assertUsableDataset(
  cards: RegressionCardSet,
  queries: RegressionQuerySet,
): void {
  const problems: string[] = [];
  const labels = new Set(cards.cards.map((card) => card.label));
  if (labels.size !== cards.cards.length) problems.push("duplicate Card label");
  if (new Set(cards.cards.map((card) => card.versionId)).size !== cards.cards.length) {
    problems.push("duplicate Card versionId");
  }
  if (queries.queries.length < 25) {
    problems.push(`${queries.queries.length} queries, fewer than 25`);
  }
  if (new Set(queries.queries.map((query) => query.id)).size !== queries.queries.length) {
    problems.push("duplicate query id");
  }
  for (const category of REGRESSION_CATEGORIES) {
    if (!queries.queries.some((query) => query.category === category)) {
      problems.push(`category ${category} has no query`);
    }
  }
  for (const query of queries.queries) {
    if (!REGRESSION_CATEGORIES.includes(query.category)) {
      problems.push(`${query.id}: unknown category ${query.category}`);
    }
    const seen = new Set<string>();
    for (const [side, list] of [
      ["required", query.required],
      ["optional", query.optional],
      ["forbidden", query.forbidden],
    ] as const) {
      for (const label of list) {
        if (!labels.has(label)) problems.push(`${query.id}: ${side} names unknown Card ${label}`);
        if (seen.has(label)) problems.push(`${query.id}: ${label} appears on two sides`);
        seen.add(label);
      }
    }
    if (query.category === "no_answer_or_low_confidence" && query.confidence === undefined) {
      problems.push(`${query.id}: no-answer query without a confidence`);
    }
    if (query.confidence === "none" && query.required.length > 0) {
      problems.push(`${query.id}: confidence none but required is not empty`);
    }
    if (query.category === "multiple_cards_required" && query.required.length < 2) {
      problems.push(`${query.id}: multiple_cards_required with fewer than two required`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `card-selection-regression-v1 is not a usable regression set: ${problems.join("; ")}`,
    );
  }
}

/** The dataset's Cards as the domain reads them. Scoring looks at `meaning` only. */
export function toApprovedCards(cards: RegressionCardSet): readonly ApprovedCard[] {
  return cards.cards.map((card) => ({
    cardId: card.label,
    versionId: card.versionId,
    meaning: card.meaning,
    policy: card.policy,
    scopes: [
      {
        kind: "managed_document",
        reference: { scopeId: `scope_${card.scope.semanticUnitId}`, scopeVersion: "1" },
        documentIndex: {
          documentIndexId: `didx_${card.scope.documentId}`,
          sourceId: `src_${card.scope.documentId}`,
          documentId: card.scope.documentId,
          indexVersion: "1",
        },
        selection: { kind: "semantic_units", semanticUnitIds: [card.scope.semanticUnitId] },
      },
    ],
  }));
}

/** What one query did, kept so a failing gate can name the query. */
export interface RegressionQueryResult {
  readonly id: string;
  readonly category: RegressionCategory;
  readonly text: string;
  readonly top1: string | undefined;
  readonly top1Score: number | undefined;
  readonly top1Correct: boolean;
  /** Whether the query has at least one required Card. Margins are read only where it does. */
  readonly expectsAnswer: boolean;
  /** First minus second score; `undefined` with fewer than two candidates. */
  readonly margin: number | undefined;
  readonly admitted: readonly string[];
  readonly wrongAdmits: readonly string[];
  readonly forbiddenAdmits: readonly string[];
  readonly missingRequired: readonly string[];
  /** Only for queries with two or more required Cards. */
  readonly fullSet: boolean | undefined;
  readonly deferCount: number;
  readonly rejectCount: number;
}

/** The four measurements of §6.2, plus the counts they are built from. */
export interface RegressionMetrics {
  readonly queryCount: number;
  /** Share of queries whose first-ranked Card is required, or that admitted nothing when nothing was expected. */
  readonly top1Accuracy: number;
  readonly top1Correct: number;
  /** Share of admits that were neither required nor optional. `null` when nothing was admitted. */
  readonly wrongAdmitRatio: number | null;
  readonly wrongAdmits: number;
  readonly totalAdmits: number;
  readonly forbiddenAdmits: number;
  /** Over queries with an expected answer and at least two candidates. */
  readonly marginMedian: number | null;
  readonly marginMin: number | null;
  readonly marginMax: number | null;
  /** Share of multi-Card queries whose every required Card was admitted. `null` with none. */
  readonly fullSetRecall: number | null;
  readonly multiQueryCount: number;
  /** Over every (Card, query) pair. */
  readonly admitRatio: number;
  readonly deferRatio: number;
  readonly rejectRatio: number;
  readonly pairCount: number;
}

export interface RegressionReport {
  readonly thresholds: SelectionThresholds;
  readonly metrics: RegressionMetrics;
  readonly byCategory: Readonly<Record<RegressionCategory, RegressionMetrics>>;
  readonly queries: readonly RegressionQueryResult[];
}

/**
 * Scores every query against every Card under the lexical policy and judges
 * the result, then folds the verdicts into the §6.2 measurements.
 *
 * Pure: the same cards, queries and thresholds always give the same report, and
 * nothing is read from the environment. `top1Correct` for a no-answer query
 * means "admitted nothing"; for every other query it means the first-ranked
 * Card is one of the required ones.
 */
export function scoreRegression(
  cards: readonly ApprovedCard[],
  queries: readonly RegressionQuery[],
  thresholds: SelectionThresholds = DEFAULT_SELECTION_THRESHOLDS,
): RegressionReport {
  const results = queries.map((query) => scoreOne(cards, query, thresholds));
  const byCategory = Object.fromEntries(
    REGRESSION_CATEGORIES.map((category) => [
      category,
      summarize(results.filter((result) => result.category === category)),
    ]),
  ) as Record<RegressionCategory, RegressionMetrics>;
  return { thresholds, metrics: summarize(results), byCategory, queries: results };
}

function scoreOne(
  cards: readonly ApprovedCard[],
  query: RegressionQuery,
  thresholds: SelectionThresholds,
): RegressionQueryResult {
  const judged = judgeCandidates(scoreCardsAgainstQuery(query.text, cards), thresholds);
  const ranked = judged.provenance.ranked;
  const admitted = judged.outcomes
    .filter((outcome) => outcome.verdict === "admit")
    .map((outcome) => outcome.cardId);
  const allowed = new Set([...query.required, ...query.optional]);
  const forbidden = new Set(query.forbidden);
  const top1 = ranked[0];
  const second = ranked[1];
  const expectsAnswer = query.required.length > 0;
  return {
    id: query.id,
    category: query.category,
    text: query.text,
    top1: top1?.cardId,
    top1Score: top1?.score,
    top1Correct: expectsAnswer
      ? top1 !== undefined && query.required.includes(top1.cardId)
      : admitted.length === 0,
    expectsAnswer,
    margin: top1 !== undefined && second !== undefined ? top1.score - second.score : undefined,
    admitted,
    wrongAdmits: admitted.filter((cardId) => !allowed.has(cardId)),
    forbiddenAdmits: admitted.filter((cardId) => forbidden.has(cardId)),
    missingRequired: query.required.filter((label) => !admitted.includes(label)),
    fullSet:
      query.required.length >= 2
        ? query.required.every((label) => admitted.includes(label))
        : undefined,
    deferCount: judged.outcomes.filter((outcome) => outcome.verdict === "defer").length,
    rejectCount: judged.outcomes.filter((outcome) => outcome.verdict === "reject").length,
  };
}

function summarize(results: readonly RegressionQueryResult[]): RegressionMetrics {
  const totalAdmits = sum(results.map((result) => result.admitted.length));
  const wrongAdmits = sum(results.map((result) => result.wrongAdmits.length));
  const forbiddenAdmits = sum(results.map((result) => result.forbiddenAdmits.length));
  const deferCount = sum(results.map((result) => result.deferCount));
  const rejectCount = sum(results.map((result) => result.rejectCount));
  const pairCount = totalAdmits + deferCount + rejectCount;
  // Margins only where an answer was expected: the gap between two scores
  // that should both be rejections says nothing about separation.
  const margins = results
    .filter((result) => result.expectsAnswer && result.margin !== undefined)
    .map((result) => result.margin as number);
  const multi = results.filter((result) => result.fullSet !== undefined);
  const top1Correct = results.filter((result) => result.top1Correct).length;
  return {
    queryCount: results.length,
    top1Accuracy: results.length === 0 ? 0 : top1Correct / results.length,
    top1Correct,
    wrongAdmitRatio: totalAdmits === 0 ? null : wrongAdmits / totalAdmits,
    wrongAdmits,
    totalAdmits,
    forbiddenAdmits,
    marginMedian: margins.length === 0 ? null : median(margins),
    marginMin: margins.length === 0 ? null : Math.min(...margins),
    marginMax: margins.length === 0 ? null : Math.max(...margins),
    fullSetRecall:
      multi.length === 0 ? null : multi.filter((result) => result.fullSet).length / multi.length,
    multiQueryCount: multi.length,
    admitRatio: pairCount === 0 ? 0 : totalAdmits / pairCount,
    deferRatio: pairCount === 0 ? 0 : deferCount / pairCount,
    rejectRatio: pairCount === 0 ? 0 : rejectCount / pairCount,
    pairCount,
  };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}
