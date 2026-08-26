import type {
  ApprovedCard,
  ApprovedScope,
} from "./card-catalog.js";
import { SelectionCandidateInvariantError } from "./errors.js";

/** Identifies the lexical rules that produced a candidate score. */
export const QUERY_SCORING_POLICY_VERSION = "selection-lexical-v4" as const;

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const BM25_WEIGHT = 0.75;
const NGRAM_WEIGHT = 0.25;
/** Fuzzy evidence alone must remain on the rejecting side of the band. */
const MAX_INDIRECT_SCORE = 0.34;
/** Smaller character overlap may rank rejects but is not auditable evidence. */
const MIN_AUDITABLE_INDIRECT_SCORE = 0.05;
/** A declared but non-distinctive term may defer, but never admit by itself. */
const MAX_WEAK_DIRECT_SCORE = 0.84;

const NO_SCORE_SIGNALS: readonly ScoreSignal[] = Object.freeze([]);

const FIELD_WEIGHTS = {
  keyword: 3,
  alias: 2.5,
  representative_question: 1.5,
  description: 0.75,
  scope: 2,
} as const;

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "for", "how", "is", "of", "or", "the", "to",
  "what", "when", "where", "which", "with", "궁금해", "되나요", "어떻게",
  "알려줘", "알려주세요", "하나요",
]);

export type SourceIntent = ApprovedScope["kind"];

const SOURCE_INTENT_TOKENS: Readonly<Record<SourceIntent, ReadonlySet<string>>> = {
  managed_document: new Set(["document", "guide", "policy", "규정", "문서", "안내", "절차"]),
  sql_source: new Set(["data", "log", "record", "records", "table", "데이터", "로그", "테이블"]),
  http_source: new Set(["api", "endpoint", "live", "실시간", "추적", "호출"]),
};

export interface ScoreSignal {
  readonly field:
    | "keyword"
    | "alias"
    | "representative_question"
    | "description"
    | "bm25"
    | "scope";
  readonly matched: string;
  readonly contribution: number;
}

export interface CandidateScore {
  readonly cardId: string;
  readonly versionId: string;
  readonly score: number;
  readonly signals: readonly ScoreSignal[];
}

interface WeightedField {
  readonly field: Exclude<ScoreSignal["field"], "bm25">;
  readonly text: string;
  readonly weight: number;
  readonly tokens: readonly string[];
  /** Sorted ids into the catalog generation's one n-gram dictionary. */
  readonly ngramIds: Uint32Array;
}

interface IndexedCard {
  readonly card: ApprovedCard;
  readonly fields: readonly WeightedField[];
  readonly termFrequency: ReadonlyMap<string, number>;
  readonly declaredVocabularySize: number;
  readonly humanAliasCount: number;
  readonly broadGenerated: boolean;
  readonly weightedLength: number;
  /** Shared immutable rejection record for queries with no usable evidence. */
  readonly noScore: CandidateScore;
  /**
   * Last negligible indirect candidate. It retains no query material and
   * avoids allocating the same reject-band record on repeated scoring runs.
   */
  weakIndirect: CandidateScore | undefined;
}

interface CatalogIndex {
  readonly cards: readonly IndexedCard[];
  /** Each distinct 2/3-character string is retained once per generation. */
  readonly ngramIds: ReadonlyMap<string, number>;
}

interface QueryStatistics {
  /** Query-relevant population used by relative lexical statistics. */
  readonly scoringCardCount: number;
  readonly documentFrequency: ReadonlyMap<string, number>;
  readonly declaredTermFrequency: ReadonlyMap<string, number>;
  /** Keeps a unique heading distinctive when its word also appears in body keywords. */
  readonly aliasTermFrequency: ReadonlyMap<string, number>;
  readonly averageWeightedLength: number;
}

interface QueryNgrams {
  /** Only ids known by this catalog, sorted for a linear intersection. */
  readonly knownIds: Uint32Array;
  /** Includes unknown query n-grams because they still belong in Dice's denominator. */
  readonly size: number;
}

interface QueryAnalysis {
  readonly tokens: readonly string[];
  /** First occurrence of each token, retained in query order. */
  readonly uniqueTokens: readonly string[];
  readonly ngrams: QueryNgrams;
  readonly sourceIntents: ReadonlySet<SourceIntent>;
}

interface DirectEvidenceCompetition {
  /** The only broad generated Card with the most declared query matches. */
  readonly strongLeaderVersionId: string | undefined;
}

/**
 * Lexical Card indexes belong to an immutable approved-catalog generation.
 * Query-relative statistics stay ephemeral, and a weak key releases the
 * reusable indexes when that generation is retired.
 */
const catalogIndexCache = new WeakMap<
  readonly ApprovedCard[],
  CatalogIndex
>();

/**
 * Scores every approved Card against one query.
 *
 * v4 computes immutable catalog indexes once, then derives relative statistics
 * from only the Cards that share query vocabulary. Appending an unrelated Card
 * therefore cannot change existing scores. It still requires BM25 or
 * multi-token context
 * before a declaration can cross the admit threshold. A term shared by many
 * Cards is weak evidence; a distinctive, corroborated declaration is strong
 * evidence. This prevents one generic derived keyword from admitting a Card.
 */
export function scoreCardsAgainstQuery(
  queryText: string,
  cards: readonly ApprovedCard[],
): readonly CandidateScore[] {
  const catalog = catalogIndex(cards);
  return scoreIndexedCardsAgainstQuery(queryText, catalog, catalog.cards);
}

/**
 * Scores a small candidate subset under the complete catalog's v4 statistics.
 *
 * Set planning needs facet scores only for independently admitted Cards. Calling
 * `scoreCardsAgainstQuery` for every facet would rescore all 10,000 eligible
 * Cards even though the planning ceiling admits at most 32. Query-relevant
 * statistics and direct-evidence competition still use the complete immutable
 * catalog, so the subset produces exactly the scores from a complete pass.
 */
export function scoreCardSubsetAgainstQuery(
  queryText: string,
  catalogCards: readonly ApprovedCard[],
  candidateCards: readonly ApprovedCard[],
): readonly CandidateScore[] {
  const catalog = catalogIndex(catalogCards);
  const indexed = indexedCandidateCards(catalog, candidateCards);
  return scoreIndexedCardsAgainstQuery(queryText, catalog, indexed);
}

function indexedCandidateCards(
  catalog: CatalogIndex,
  candidateCards: readonly ApprovedCard[],
): readonly IndexedCard[] {
  const requested = new Map(
    candidateCards.map((card) => [card.versionId, card]),
  );
  if (requested.size !== candidateCards.length) {
    throw new SelectionCandidateInvariantError(
      "candidate subset repeats a Card Version",
    );
  }
  const found = new Map<string, IndexedCard>();
  for (const indexed of catalog.cards) {
    if (requested.has(indexed.card.versionId)) {
      found.set(indexed.card.versionId, indexed);
    }
  }
  return candidateCards.map((card) => {
    const known = found.get(card.versionId);
    if (known === undefined || known.card.cardId !== card.cardId) {
      throw new SelectionCandidateInvariantError(
        `card version ${card.versionId} is not part of the eligible scoring snapshot`,
      );
    }
    return known;
  });
}

function scoreIndexedCardsAgainstQuery(
  queryText: string,
  catalog: CatalogIndex,
  cards: readonly IndexedCard[],
): readonly CandidateScore[] {
  const query = normalizeLexicalText(queryText);
  const tokens = tokenizeLexicalText(query);
  const analysis: QueryAnalysis = {
    tokens,
    uniqueTokens: uniqueInOrder(tokens),
    ngrams: queryNgrams(query, catalog.ngramIds),
    sourceIntents: inferSourceIntents(tokens),
  };
  const statistics = queryRelevantStatistics(analysis.uniqueTokens, catalog);
  const competition = directEvidenceCompetition(analysis, catalog.cards);

  return cards.map((indexed) =>
    scoreCard(analysis, indexed, statistics, competition),
  );
}

function directEvidenceCompetition(
  query: QueryAnalysis,
  cards: readonly IndexedCard[],
): DirectEvidenceCompetition {
  let maximum = 0;
  let leaderVersionId: string | undefined;
  let tied = false;
  for (const indexed of cards) {
    if (!indexed.broadGenerated) continue;
    const count = matchedDeclaredFieldCount(query, indexed.fields);
    if (count > maximum) {
      maximum = count;
      leaderVersionId = indexed.card.versionId;
      tied = false;
    } else if (count === maximum && count > 0) {
      tied = true;
    }
  }
  return {
    strongLeaderVersionId:
      maximum >= 3 && !tied ? leaderVersionId : undefined,
  };
}

function matchedDeclaredFieldCount(
  query: QueryAnalysis,
  fields: readonly WeightedField[],
): number {
  const matchedTokens = new Set<string>();
  for (const field of fields) {
    if (field.field !== "keyword" && field.field !== "alias") continue;
    if (isOpaqueDeclaredIdentifier(field.text)) continue;
    if (!field.tokens.every((token) => queryContainsDeclaredToken(query.tokens, token))) {
      continue;
    }
    for (const token of field.tokens) matchedTokens.add(token);
  }
  return matchedTokens.size;
}

function catalogIndex(cards: readonly ApprovedCard[]): CatalogIndex {
  const cached = catalogIndexCache.get(cards);
  if (cached !== undefined) return cached;
  const index = buildCatalogIndex(cards);
  catalogIndexCache.set(cards, index);
  return index;
}

function buildCatalogIndex(
  cards: readonly ApprovedCard[],
): CatalogIndex {
  const ngramIds = new Map<string, number>();
  const indexedCards = cards.map((card) => indexCard(card, ngramIds));
  return {
    cards: indexedCards,
    ngramIds,
  };
}

/**
 * Keeps relative lexical statistics invariant when Cards that share no query
 * vocabulary are appended to the catalog. Such Cards cannot contribute
 * evidence for this query and therefore must not change existing evidence.
 */
function queryRelevantStatistics(
  queryTokens: readonly string[],
  catalog: CatalogIndex,
): QueryStatistics {
  const documentFrequency = new Map<string, number>();
  const declaredTermFrequency = new Map<string, number>();
  const aliasTermFrequency = new Map<string, number>();
  const declaredTokensSeen = new Set<string>();
  const aliasTokensSeen = new Set<string>();
  let scoringCardCount = 0;
  let totalLength = 0;
  for (const indexed of catalog.cards) {
    if (!indexedCardContainsAnyQueryToken(indexed, queryTokens)) {
      continue;
    }
    scoringCardCount += 1;
    totalLength += indexed.weightedLength;
    for (const token of queryTokens) {
      if (indexed.termFrequency.has(token)) {
        documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
      }
    }
    declaredTokensSeen.clear();
    aliasTokensSeen.clear();
    for (const field of indexed.fields) {
      if (field.field !== "keyword" && field.field !== "alias") continue;
      for (const token of field.tokens) {
        if (!queryContainsDeclaredToken(queryTokens, token)) continue;
        declaredTokensSeen.add(token);
        if (field.field === "alias") aliasTokensSeen.add(token);
      }
    }
    for (const token of declaredTokensSeen) {
      declaredTermFrequency.set(
        token,
        (declaredTermFrequency.get(token) ?? 0) + 1,
      );
    }
    for (const token of aliasTokensSeen) {
      aliasTermFrequency.set(token, (aliasTermFrequency.get(token) ?? 0) + 1);
    }
  }

  return {
    scoringCardCount,
    documentFrequency,
    declaredTermFrequency,
    aliasTermFrequency,
    averageWeightedLength:
      scoringCardCount === 0 ? 0 : totalLength / scoringCardCount,
  };
}

function indexCard(
  card: ApprovedCard,
  ngramIds: Map<string, number>,
): IndexedCard {
  const fields: WeightedField[] = [];
  appendFields(fields, "keyword", card.meaning.keywords, FIELD_WEIGHTS.keyword, ngramIds);
  appendFields(fields, "alias", card.meaning.aliases, FIELD_WEIGHTS.alias, ngramIds);
  appendFields(
    fields,
    "representative_question",
    card.meaning.representativeQuestions,
    FIELD_WEIGHTS.representative_question,
    ngramIds,
  );
  appendFields(
    fields,
    "description",
    [card.meaning.description],
    FIELD_WEIGHTS.description,
    ngramIds,
  );
  appendFields(
    fields,
    "scope",
    card.scopes.flatMap(scopeSearchValues),
    FIELD_WEIGHTS.scope,
    ngramIds,
  );

  const termFrequency = new Map<string, number>();
  let weightedLength = 0;
  for (const field of fields) {
    weightedLength += field.tokens.length * field.weight;
    for (const token of field.tokens) {
      termFrequency.set(token, (termFrequency.get(token) ?? 0) + field.weight);
    }
  }
  const humanAliases = card.meaning.aliases.filter(
    (value) => !isOpaqueDeclaredIdentifier(value),
  );
  const humanKeywords = card.meaning.keywords.filter(
    (value) => !isOpaqueDeclaredIdentifier(value),
  );
  const humanDeclaredTokens: string[] = [];
  for (const token of [...humanKeywords, ...humanAliases].flatMap((term) =>
    tokenizeLexicalText(normalizeLexicalText(term)),
  )) {
    if (!humanDeclaredTokens.includes(token)) humanDeclaredTokens.push(token);
  }
  return {
    card,
    fields,
    termFrequency,
    declaredVocabularySize: humanDeclaredTokens.length,
    humanAliasCount: humanAliases.length,
    broadGenerated:
      humanDeclaredTokens.length > 24 && humanAliases.length >= 2,
    weightedLength,
    noScore: Object.freeze({
      cardId: card.cardId,
      versionId: card.versionId,
      score: 0,
      signals: NO_SCORE_SIGNALS,
    }),
    weakIndirect: undefined,
  };
}

function appendFields(
  target: WeightedField[],
  field: WeightedField["field"],
  values: readonly string[],
  weight: number,
  ngramIds: Map<string, number>,
): void {
  for (const text of values) {
    const normalized = normalizeLexicalText(text);
    const tokens = tokenizeLexicalText(normalized);
    if (tokens.length > 0) {
      target.push({
        field,
        text,
        weight,
        tokens,
        ngramIds: catalogNgramIds(normalized, ngramIds),
      });
    }
  }
}

function scoreCard(
  query: QueryAnalysis,
  indexed: IndexedCard,
  statistics: QueryStatistics,
  competition: DirectEvidenceCompetition,
): CandidateScore {
  if (query.tokens.length === 0) return indexed.noScore;

  const bm25 = bm25Score(query.uniqueTokens, indexed, statistics);
  const normalizedBm25 = normalizeBm25(bm25);
  const directSignals = collectDirectSignals(
    query,
    indexed,
    statistics,
    normalizedBm25,
    competition,
  );
  const direct = directSignals.reduce(
    (maximum, signal) => Math.max(maximum, signal.contribution),
    0,
  );
  const ngramContribution = bestNgramContribution(query.ngrams, indexed.fields);
  const rawIndirect = Math.min(
    MAX_INDIRECT_SCORE,
    BM25_WEIGHT * normalizedBm25 + NGRAM_WEIGHT * ngramContribution,
  );
  const indirect = rawIndirect;
  if (direct === 0 && indirect === 0) {
    return indexed.noScore;
  }
  if (
    direct === 0 &&
    bm25 === 0 &&
    indirect < MIN_AUDITABLE_INDIRECT_SCORE
  ) {
    return weakIndirectCandidate(indexed, indirect);
  }
  const ngram = bestNgramScore(query.ngrams, indexed.fields);
  const signals: ScoreSignal[] = [...directSignals];
  if (bm25 > 0) {
    signals.push({
      field: "bm25",
      matched: "catalog",
      contribution: normalizedBm25,
    });
  }
  if (
    ngram.contribution > 0 &&
    !signals.some(
      (signal) => signal.field === ngram.field && signal.matched === ngram.matched,
    )
  ) {
    signals.push(ngram);
  }

  return {
    cardId: indexed.card.cardId,
    versionId: indexed.card.versionId,
    score: clampToUnitInterval(Math.max(direct, indirect)),
    signals,
  };
}

function weakIndirectCandidate(
  indexed: IndexedCard,
  score: number,
): CandidateScore {
  if (indexed.weakIndirect?.score === score) return indexed.weakIndirect;
  const candidate = Object.freeze({
    cardId: indexed.card.cardId,
    versionId: indexed.card.versionId,
    score,
    signals: NO_SCORE_SIGNALS,
  });
  indexed.weakIndirect = candidate;
  return candidate;
}

function collectDirectSignals(
  query: QueryAnalysis,
  indexed: IndexedCard,
  statistics: QueryStatistics,
  normalizedBm25: number,
  competition: DirectEvidenceCompetition,
): readonly ScoreSignal[] {
  let matched: {
    readonly field: "keyword" | "alias" | "scope";
    readonly text: string;
    readonly tokens: readonly string[];
    readonly specificity: number;
  }[] | undefined;
  let matchedDeclarations: Set<string> | undefined;

  for (const field of indexed.fields) {
    if (field.field === "scope") {
      const exactCoordinate =
        field.tokens.length === query.tokens.length &&
        field.tokens.every((token, index) => token === query.tokens[index]);
      if (exactCoordinate) {
        const declarationKey = `scope-coordinate:${field.tokens.join(" ")}`;
        if (!matchedDeclarations?.has(declarationKey)) {
          (matchedDeclarations ??= new Set()).add(declarationKey);
          (matched ??= []).push({
            field: "scope",
            text: field.text,
            tokens: field.tokens,
            specificity: 1,
          });
        }
        continue;
      }
      for (let index = 0; index < field.tokens.length; index += 1) {
        const token = field.tokens[index]!;
        if (field.tokens.indexOf(token) !== index) continue;
        if (!query.uniqueTokens.includes(token)) continue;
        const declarationKey = `scope:${token}`;
        if (matchedDeclarations?.has(declarationKey)) continue;
        (matchedDeclarations ??= new Set()).add(declarationKey);
        (matched ??= []).push({
          field: "scope",
          text: token,
          tokens: [token],
          specificity: declaredSpecificity(
            statistics.scoringCardCount,
            statistics.documentFrequency.get(token) ?? statistics.scoringCardCount,
          ),
        });
      }
      continue;
    }
    if (field.field !== "keyword" && field.field !== "alias") continue;
    if (!field.tokens.every((token) => queryContainsDeclaredToken(query.tokens, token))) {
      continue;
    }
    const declarationKey = `${field.field}:${field.tokens.join(" ")}`;
    if (matchedDeclarations?.has(declarationKey)) continue;
    (matchedDeclarations ??= new Set()).add(declarationKey);
    const specificity = Math.max(
      ...field.tokens.map((token) =>
        declaredSpecificity(
          statistics.scoringCardCount,
          (field.field === "alias"
            ? statistics.aliasTermFrequency
            : statistics.declaredTermFrequency
          ).get(token) ?? statistics.scoringCardCount,
        ),
      ),
    );
    (matched ??= []).push({
      field: field.field,
      text: field.text,
      tokens: field.tokens,
      specificity,
    });
  }

  if (matched === undefined) return NO_SCORE_SIGNALS;
  const strongest = Math.max(...matched.map((entry) => entry.specificity));
  let contextualOverlap = 0;
  for (const queryToken of query.uniqueTokens) {
    if (indexedCardContainsQueryToken(indexed, queryToken)) {
      contextualOverlap += 1;
    }
  }
  const strongContextPhrase = indexed.fields.some((field) =>
    hasContiguousTokenMatch(query.tokens, field.tokens, 3),
  );
  const rawContribution =
    0.42 +
    0.4 * strongest +
    0.18 * Math.min(matched.length / 2, 1);
  const onlyTerm = matched.length === 1 ? matched[0]!.tokens : [];
  const weakSingleTerm =
    onlyTerm.length === 1 &&
    [...(onlyTerm[0] ?? "")].length <= 2 &&
    contextualOverlap < 3 &&
    !strongContextPhrase &&
    !isLeadingAliasToken(onlyTerm[0] ?? "", indexed.fields);
  const exactMultiTokenAlias = matched.some(
    (entry) => entry.field === "alias" && entry.tokens.length >= 2,
  );
  const conciseSpecificDeclaration =
    indexed.declaredVocabularySize <= 24 && indexed.humanAliasCount >= 2;
  const supportedCommonPhrase =
    matched.length >= 2 &&
    (normalizedBm25 >= 0.6 ||
      (conciseSpecificDeclaration &&
        contextualOverlap >= 2 &&
        normalizedBm25 >= 0.54) ||
      (conciseSpecificDeclaration &&
        matched.length >= 3 &&
        contextualOverlap >= 3));
  const distinctiveAliasWithContext =
    matched.some(
      (entry) => entry.field === "alias" && entry.specificity >= 0.9,
    ) &&
    supportedCommonPhrase &&
    contextualOverlap >= 3;
  const sourceIntentConflict =
    query.sourceIntents.size > 0 &&
    !indexed.card.scopes.some((scope) => query.sourceIntents.has(scope.kind));
  const commonTermsWithoutContext =
    strongest < 0.85 &&
    contextualOverlap < 3 &&
    !strongContextPhrase &&
    !exactMultiTokenAlias &&
    !supportedCommonPhrase;
  const wellCorroboratedDirect =
    competition.strongLeaderVersionId === indexed.card.versionId ||
    exactMultiTokenAlias ||
    (conciseSpecificDeclaration && strongest >= 0.9) ||
    (conciseSpecificDeclaration && supportedCommonPhrase) ||
    distinctiveAliasWithContext ||
    strongContextPhrase ||
    (statistics.scoringCardCount === 1 && strongest >= 0.9) ||
    normalizedBm25 >= 0.86 ||
    (strongest >= 0.9 && normalizedBm25 >= 0.84);
  const strongDirectFloor =
    strongContextPhrase ||
    competition.strongLeaderVersionId === indexed.card.versionId
      ? 0.91
      : 0;
  const contribution = clampToUnitInterval(
    weakSingleTerm ||
    commonTermsWithoutContext ||
    !wellCorroboratedDirect ||
    (sourceIntentConflict && strongest < 0.85)
      ? Math.min(rawContribution, MAX_WEAK_DIRECT_SCORE)
      : Math.max(rawContribution, strongDirectFloor),
  );
  return matched.map((entry) => ({
    field: entry.field,
    matched: entry.text,
    contribution,
  }));
}

/**
 * Legacy generated Cards may still carry opaque coordinates as aliases.
 * They are retained for backward-compatible catalog reads, but they are not
 * vocabulary a person can query and must not make a concise Card look broad.
 */
function isOpaqueDeclaredIdentifier(value: string): boolean {
  return /^(?:doc|unit|src|scope|didx)_[a-z0-9_-]{20,}$/iu.test(value);
}

function indexedCardContainsQueryToken(
  indexed: IndexedCard,
  queryToken: string,
): boolean {
  if (indexed.termFrequency.has(queryToken)) return true;
  if (!/[가-힣]/u.test(queryToken)) return false;
  for (const declaredToken of indexed.termFrequency.keys()) {
    if (
      /[가-힣]/u.test(declaredToken) &&
      [...declaredToken].length >= 2 &&
      queryToken.startsWith(declaredToken)
    ) {
      return true;
    }
  }
  return false;
}

function indexedCardContainsAnyQueryToken(
  indexed: IndexedCard,
  queryTokens: readonly string[],
): boolean {
  for (const token of queryTokens) {
    if (indexedCardContainsQueryToken(indexed, token)) return true;
  }
  return false;
}

function inferSourceIntents(tokens: readonly string[]): ReadonlySet<SourceIntent> {
  const intents = new Set<SourceIntent>();
  for (const [kind, markers] of Object.entries(SOURCE_INTENT_TOKENS) as readonly (
    readonly [SourceIntent, ReadonlySet<string>]
  )[]) {
    if (tokens.some((token) => markers.has(token))) intents.add(kind);
  }
  return intents;
}

function hasContiguousTokenMatch(
  queryTokens: readonly string[],
  fieldTokens: readonly string[],
  minimumLength: number,
): boolean {
  if (queryTokens.length < minimumLength || fieldTokens.length < minimumLength) {
    return false;
  }
  for (let queryStart = 0; queryStart <= queryTokens.length - minimumLength; queryStart += 1) {
    for (let fieldStart = 0; fieldStart <= fieldTokens.length - minimumLength; fieldStart += 1) {
      let matched = 0;
      while (
        queryStart + matched < queryTokens.length &&
        fieldStart + matched < fieldTokens.length &&
        queryTokens[queryStart + matched] === fieldTokens[fieldStart + matched]
      ) {
        matched += 1;
        if (matched >= minimumLength) return true;
      }
    }
  }
  return false;
}

function isLeadingAliasToken(
  token: string,
  fields: readonly WeightedField[],
): boolean {
  return fields.some(
    (field) =>
      field.field === "alias" &&
      field.tokens.length >= 2 &&
      field.tokens[0] === token,
  );
}

function queryContainsDeclaredToken(
  queryTokens: readonly string[],
  declaredToken: string,
): boolean {
  return queryTokens.some((queryToken) => {
    if (queryToken === declaredToken) return true;
    return (
      /[가-힣]/u.test(declaredToken) &&
      [...declaredToken].length >= 2 &&
      queryToken.startsWith(declaredToken)
    );
  });
}

function declaredSpecificity(cardCount: number, frequency: number): number {
  if (cardCount <= 1) return 1;
  return Math.log1p(cardCount / Math.max(frequency, 1)) / Math.log1p(cardCount);
}

function bm25Score(
  uniqueQueryTokens: readonly string[],
  indexed: IndexedCard,
  statistics: QueryStatistics,
): number {
  if (statistics.scoringCardCount === 0 || statistics.averageWeightedLength === 0) return 0;
  let score = 0;
  for (const token of uniqueQueryTokens) {
    const frequency = indexed.termFrequency.get(token) ?? 0;
    if (frequency === 0) continue;
    const documentFrequency = statistics.documentFrequency.get(token) ?? 0;
    const idf = Math.log(
      1 +
        (statistics.scoringCardCount - documentFrequency + 0.5) /
          (documentFrequency + 0.5),
    );
    const denominator =
      frequency +
      BM25_K1 *
        (1 - BM25_B + BM25_B * (indexed.weightedLength / statistics.averageWeightedLength));
    score += idf * ((frequency * (BM25_K1 + 1)) / denominator);
  }
  return score;
}

function normalizeBm25(value: number): number {
  return value <= 0 ? 0 : value / (value + 2);
}

function bestNgramScore(
  queryNgrams: QueryNgrams,
  fields: readonly WeightedField[],
): ScoreSignal & { readonly field: Exclude<ScoreSignal["field"], "bm25"> } {
  let best: ScoreSignal & { field: Exclude<ScoreSignal["field"], "bm25"> } = {
    field: "description",
    matched: "",
    contribution: 0,
  };
  for (const field of fields) {
    const similarity = ngramDice(queryNgrams, field.ngramIds);
    const contribution = similarity * Math.min(field.weight / FIELD_WEIGHTS.keyword, 1);
    if (contribution > best.contribution) {
      best = { field: field.field, matched: field.text, contribution };
    }
  }
  return best;
}

function bestNgramContribution(
  queryNgrams: QueryNgrams,
  fields: readonly WeightedField[],
): number {
  let best = 0;
  for (const field of fields) {
    const similarity = ngramDice(queryNgrams, field.ngramIds);
    const contribution = similarity * Math.min(field.weight / FIELD_WEIGHTS.keyword, 1);
    if (contribution > best) best = contribution;
  }
  return best;
}

export function scopeSearchValues(scope: ApprovedScope): readonly string[] {
  switch (scope.kind) {
    case "managed_document":
      return [
        scope.reference.scopeId,
        scope.reference.scopeVersion,
        scope.documentIndex.documentId,
        scope.documentIndex.documentIndexId,
        ...(scope.selection.kind === "semantic_units"
          ? scope.selection.semanticUnitIds
          : ["document"]),
      ];
    case "sql_source":
      return [
        scope.reference.scopeId,
        scope.reference.scopeVersion,
        scope.connector,
        scope.schema,
        scope.table,
        ...scope.columns,
      ];
    case "http_source":
      return [
        scope.reference.scopeId,
        scope.reference.scopeVersion,
        scope.connector,
        scope.method,
        scope.path,
        scope.operationId ?? "",
        ...scope.parameters.flatMap((parameter) => [
          parameter.location,
          parameter.name,
        ]),
      ];
  }
}

export function normalizeLexicalText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

export function tokenizeLexicalText(text: string): readonly string[] {
  const raw = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  const tokens: string[] = [];
  for (const value of raw) {
    const token = normalizeKoreanSuffix(value);
    if (token.length > 0 && !STOP_WORDS.has(token)) tokens.push(token);
  }
  return tokens;
}

function uniqueInOrder(values: readonly string[]): readonly string[] {
  if (values.length < 2) return values;
  const unique: string[] = [];
  for (const value of values) {
    if (!unique.includes(value)) unique.push(value);
  }
  return unique;
}

function normalizeKoreanSuffix(value: string): string {
  if (!/[가-힣]/u.test(value) || value.length < 3) return value;
  // A derived keyword keeps the source inflection, while a user naturally
  // asks with another inflection. Normalize only the passive `되다` forms we
  // can strip without a morphological dictionary; this is deliberately not a
  // general Korean stemmer.
  for (const suffix of ["되어", "되는", "되면", "되고", "되지", "된"]) {
    if (value.endsWith(suffix) && value.length > suffix.length + 1) {
      return value.slice(0, -suffix.length);
    }
  }
  for (const suffix of [
    "에서는", "으로는", "에게는", "부터는", "까지는", "이라는", "라고는",
    "으로", "에서", "에게", "까지", "부터", "처럼", "보다", "이나", "거나",
    "은", "는", "이", "가", "을", "를", "에", "의", "도", "로", "와", "과", "랑",
  ]) {
    if (value.endsWith(suffix) && value.length > suffix.length + 1) {
      return value.slice(0, -suffix.length);
    }
  }
  return value;
}

function characterNgrams(text: string): ReadonlySet<string> {
  const compact = text.replace(/\s+/gu, "");
  const ngrams = new Set<string>();
  for (const size of [2, 3]) {
    for (let index = 0; index + size <= compact.length; index += 1) {
      ngrams.add(compact.slice(index, index + size));
    }
  }
  return ngrams;
}

function catalogNgramIds(
  text: string,
  dictionary: Map<string, number>,
): Uint32Array {
  const ids: number[] = [];
  for (const ngram of characterNgrams(text)) {
    let id = dictionary.get(ngram);
    if (id === undefined) {
      id = dictionary.size;
      dictionary.set(ngram, id);
    }
    ids.push(id);
  }
  ids.sort((left, right) => left - right);
  return Uint32Array.from(ids);
}

function queryNgrams(
  text: string,
  dictionary: ReadonlyMap<string, number>,
): QueryNgrams {
  const ngrams = characterNgrams(text);
  const knownIds: number[] = [];
  for (const ngram of ngrams) {
    const id = dictionary.get(ngram);
    if (id !== undefined) knownIds.push(id);
  }
  knownIds.sort((left, right) => left - right);
  return { knownIds: Uint32Array.from(knownIds), size: ngrams.size };
}

function ngramDice(left: QueryNgrams, right: Uint32Array): number {
  if (left.size === 0 || right.length === 0) return 0;
  let intersection = 0;
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.knownIds.length && rightIndex < right.length) {
    const leftId = left.knownIds[leftIndex]!;
    const rightId = right[rightIndex]!;
    if (leftId === rightId) {
      intersection += 1;
      leftIndex += 1;
      rightIndex += 1;
    } else if (leftId < rightId) {
      leftIndex += 1;
    } else {
      rightIndex += 1;
    }
  }
  return (2 * intersection) / (left.size + right.length);
}

function clampToUnitInterval(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}
