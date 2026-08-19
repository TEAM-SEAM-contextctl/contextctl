import type { ApprovedCard, ApprovedCardMeaning } from "./card-catalog.js";

/**
 * Identifies the scoring rules a candidate score was produced under.
 *
 * `lexical`, and the name is a claim about what this file does rather than a
 * label. Everything below compares normalized text and character bigrams; no
 * Card embedding exists, so nothing here can contribute a vector signal. The
 * previous `selection-scoring-v1` said only "version one of whatever scoring
 * is", which a consumer could not compare against a later hybrid run — and the
 * response's `selection.mode` is paired with exactly this value, so a name that
 * did not state the family would have made the pairing unverifiable.
 */
export const QUERY_SCORING_POLICY_VERSION = "selection-lexical-v1" as const;

/**
 * A direct match always lands at or above this floor, which is above the admit
 * threshold in `selection-verdict.ts`. That is the whole point of the split
 * between direct and indirect signals: a Card that literally declares the words
 * of the query is admitted, and a Card that merely reads similarly is not. The
 * threshold band therefore stays a single number the repository already agreed
 * on, instead of gaining a second, scoring-specific one.
 */
const DIRECT_MATCH_FLOOR = 0.9;

/** How much of [0.9, 1] the declared-term coverage ratio is allowed to move. */
const DIRECT_MATCH_RANGE = 0.1;

/**
 * A description is prose about the Card, not a phrasing a user would type, so
 * its similarity is halved. Even a perfect description overlap stays at 0.5,
 * safely inside the defer band: prose alone never admits.
 */
const DESCRIPTION_DAMPING = 0.5;

/** Which part of a Card's meaning produced a score, and by how much. */
export interface ScoreSignal {
  readonly field:
    | "keyword"
    | "alias"
    | "representative_question"
    | "description";
  readonly matched: string;
  readonly contribution: number;
}

/**
 * One Card scored against a query.
 *
 * A structural superset of `ScoredCandidate` in `selection-verdict.ts`, so the
 * result feeds `judgeCandidates` unchanged. Scoring stays separate from
 * judgement on purpose: ranking may only compare numbers, and the explanation
 * of where a number came from travels alongside it rather than inside it.
 */
export interface CandidateScore {
  readonly cardId: string;
  readonly versionId: string;
  readonly score: number;
  readonly signals: readonly ScoreSignal[];
}

/**
 * Scores every Card against one query, in the caller's order.
 *
 * Ordering is left alone because ranking belongs to `judgeCandidates`; this
 * function only observes. No LLM, no clock, no randomness, no locale-sensitive
 * operation is involved, so the same query and the same Cards always produce
 * the same numbers on any machine.
 */
export function scoreCardsAgainstQuery(
  queryText: string,
  cards: readonly ApprovedCard[],
): readonly CandidateScore[] {
  const query = normalizeText(queryText);
  const queryBigrams = toBigrams(query);

  return cards.map((card) => scoreCard(query, queryBigrams, card));
}

function scoreCard(
  query: string,
  queryBigrams: ReadonlySet<string>,
  card: ApprovedCard,
): CandidateScore {
  const directSignals = collectDirectSignals(query, card.meaning);
  const indirectSignal = findBestIndirectSignal(queryBigrams, card.meaning);

  const direct = directSignals[0]?.contribution ?? 0;
  const indirect = indirectSignal?.contribution ?? 0;

  return {
    cardId: card.cardId,
    versionId: card.versionId,
    score: clampToUnitInterval(Math.max(direct, indirect)),
    signals:
      indirectSignal === undefined
        ? directSignals
        : [...directSignals, indirectSignal],
  };
}

/**
 * Substring containment, not token equality: Korean attaches particles to the
 * noun, so the keyword "재고" appears inside "재고를" and a tokenizing match
 * would miss it. The cost is that a short keyword can match inside an unrelated
 * word, which is accepted here because Card keywords are curated, not mined.
 *
 * Every matched term shares one contribution, because the score is a property
 * of the Card's overall coverage of its own declared vocabulary rather than of
 * any single term.
 */
function collectDirectSignals(
  query: string,
  meaning: ApprovedCardMeaning,
): readonly ScoreSignal[] {
  // Guards the ratio below: a Card that declares nothing would otherwise divide
  // zero by zero and carry a NaN all the way into the verdict.
  const declaredCount = meaning.keywords.length + meaning.aliases.length;
  if (declaredCount === 0) {
    return [];
  }

  const matched: { readonly field: "keyword" | "alias"; readonly term: string }[] =
    [];

  for (const keyword of meaning.keywords) {
    if (containsTerm(query, keyword)) {
      matched.push({ field: "keyword", term: keyword });
    }
  }
  for (const alias of meaning.aliases) {
    if (containsTerm(query, alias)) {
      matched.push({ field: "alias", term: alias });
    }
  }

  if (matched.length === 0) {
    return [];
  }

  const contribution =
    DIRECT_MATCH_FLOOR + DIRECT_MATCH_RANGE * (matched.length / declaredCount);

  return matched.map(({ field, term }) => ({
    field,
    matched: term,
    contribution,
  }));
}

function containsTerm(query: string, term: string): boolean {
  const normalized = normalizeText(term);

  // An empty declared term is contained in every string, so it would admit
  // every query. It is treated as "declared but unusable" instead.
  if (normalized.length === 0) {
    return false;
  }
  return query.includes(normalized);
}

/**
 * The strongest resemblance between the query and the Card's prose, if any.
 *
 * Ties keep the first candidate in declaration order — representative questions
 * before the description — so the reported signal is reproducible.
 */
function findBestIndirectSignal(
  queryBigrams: ReadonlySet<string>,
  meaning: ApprovedCardMeaning,
): ScoreSignal | undefined {
  let best: ScoreSignal | undefined;

  for (const question of meaning.representativeQuestions) {
    const contribution = bigramJaccard(
      queryBigrams,
      toBigrams(normalizeText(question)),
    );
    if (contribution > 0 && contribution > (best?.contribution ?? 0)) {
      best = {
        field: "representative_question",
        matched: question,
        contribution,
      };
    }
  }

  const description =
    bigramJaccard(queryBigrams, toBigrams(normalizeText(meaning.description))) *
    DESCRIPTION_DAMPING;
  if (description > 0 && description > (best?.contribution ?? 0)) {
    best = {
      field: "description",
      matched: meaning.description,
      contribution: description,
    };
  }

  return best;
}

/**
 * The one text shape everything downstream compares.
 *
 * NFKC first, so the same Hangul syllable written composed or decomposed is one
 * string and full-width Latin folds onto ASCII. `toLowerCase` rather than
 * `toLocaleLowerCase`, and no `localeCompare` anywhere: a locale-sensitive
 * operation resolves against the runtime's locale, which would make the same
 * query score differently on two machines. `selection-verdict.ts` avoids
 * `localeCompare` in its tie-break for exactly this reason.
 */
function normalizeText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

/**
 * The set of adjacent character pairs.
 *
 * Character bigrams rather than word tokens because Korean is not
 * whitespace-delimited at the morpheme level, so word splitting would need a
 * tokenizer this domain deliberately does not depend on. A string shorter than
 * two characters has no pair and yields the empty set.
 */
function toBigrams(text: string): ReadonlySet<string> {
  const bigrams = new Set<string>();

  for (let index = 0; index + 2 <= text.length; index += 1) {
    bigrams.add(text.slice(index, index + 2));
  }
  return bigrams;
}

function bigramJaccard(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): number {
  // An empty set on either side makes the union zero or the overlap
  // meaningless, so similarity is defined as absent rather than divided.
  if (left.size === 0 || right.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const bigram of left) {
    if (right.has(bigram)) {
      intersection += 1;
    }
  }

  return intersection / (left.size + right.size - intersection);
}

/**
 * Keeps the score inside the [0, 1] range `DEFAULT_SELECTION_THRESHOLDS` is
 * tuned for, and turns a non-finite value into 0 rather than letting it reach
 * the verdict, where every comparison against it would be false.
 */
function clampToUnitInterval(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(Math.max(value, 0), 1);
}
