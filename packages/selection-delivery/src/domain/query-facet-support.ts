import type { ApprovedCard } from "./card-catalog.js";
import { canonicalJson } from "./canonical-digest.js";
import type { SelectionMode } from "./hybrid-ranking.js";
import type { QueryFacet, QueryFacetResult } from "./query-facet.js";
import {
  normalizeLexicalText,
  scoreCardSubsetAgainstQuery,
  scopeSearchValues,
  tokenizeLexicalText,
  type SourceIntent,
} from "./query-scoring.js";
import { planSelectedScopes } from "./selection-plan.js";
import type { SelectionResult } from "./selection-verdict.js";

export interface FacetCoverage {
  readonly facetId: string;
  readonly bestLexicalScore: number;
  readonly supportedTokens: readonly string[];
  readonly supportedSourceKinds: readonly SourceIntent[];
}

export interface FacetSupport {
  readonly facetId: string;
  readonly lexicalScore: number;
  readonly supportedTokens: readonly string[];
  readonly supportedSourceKinds: readonly SourceIntent[];
}

export interface CardSupport {
  readonly supports: readonly FacetSupport[];
}

export type ProtectedCardReason =
  | "semantic_only_evidence"
  | "ambiguous_query"
  | "complementarity_unknown";

export function buildFacetSupports(
  strongCards: readonly ApprovedCard[],
  eligibleCards: readonly ApprovedCard[],
  facets: readonly QueryFacet[],
): ReadonlyMap<string, CardSupport> {
  const scoresByFacet = new Map(
    facets.map((facet) => [
      facet.facetId,
      new Map(
        scoreCardSubsetAgainstQuery(
          facet.normalizedText,
          eligibleCards,
          strongCards,
        ).map(
          (score) => [score.versionId, score.score],
        ),
      ),
    ]),
  );

  return new Map(
    strongCards.map((card) => [
      card.versionId,
      {
        supports: facets.map((facet) => ({
          facetId: facet.facetId,
          lexicalScore:
            scoresByFacet.get(facet.facetId)?.get(card.versionId) ?? 0,
          supportedTokens: supportedTokens(card, facet.contentTokens),
          supportedSourceKinds: facet.explicitSourceKinds.filter((kind) =>
            card.scopes.some((scope) => scope.kind === kind),
          ),
        })),
      },
    ]),
  );
}

export function protectedCandidateReasons(input: {
  readonly strongCards: readonly ApprovedCard[];
  readonly lexicalByVersionId: ReadonlyMap<string, number>;
  readonly selection: SelectionResult;
  readonly mode: SelectionMode;
  readonly facets: QueryFacetResult;
  readonly supports: ReadonlyMap<string, CardSupport>;
  readonly chunkLimitPerScope: number;
}): ReadonlyMap<string, ProtectedCardReason> {
  const reasons = new Map<string, ProtectedCardReason>();
  if (input.facets.ambiguous) {
    for (const card of input.strongCards) {
      reasons.set(card.versionId, "ambiguous_query");
    }
    return reasons;
  }
  if (input.mode === "hybrid") {
    const admitThreshold = input.selection.provenance.thresholds.admit;
    for (const card of input.strongCards) {
      if ((input.lexicalByVersionId.get(card.versionId) ?? 0) < admitThreshold) {
        reasons.set(card.versionId, "semantic_only_evidence");
      }
    }
  }
  protectUnknownComplements(input, reasons);
  return reasons;
}

export function coverageForCards(
  cards: readonly ApprovedCard[],
  supports: ReadonlyMap<string, CardSupport>,
  facets: readonly QueryFacet[],
): readonly FacetCoverage[] {
  return facets.map((facet) => {
    let bestLexicalScore = 0;
    const tokens = new Set<string>();
    const sourceKinds = new Set<SourceIntent>();
    for (const card of cards) {
      const support = supports
        .get(card.versionId)
        ?.supports.find((entry) => entry.facetId === facet.facetId);
      if (support === undefined) continue;
      bestLexicalScore = Math.max(bestLexicalScore, support.lexicalScore);
      for (const token of support.supportedTokens) tokens.add(token);
      for (const kind of support.supportedSourceKinds) sourceKinds.add(kind);
    }
    return {
      facetId: facet.facetId,
      bestLexicalScore,
      supportedTokens: [...tokens].sort(compareText),
      supportedSourceKinds: [...sourceKinds].sort(compareText),
    };
  });
}

export function preservesFacetCoverage(
  cards: readonly ApprovedCard[],
  supports: ReadonlyMap<string, CardSupport>,
  facets: readonly QueryFacet[],
  baseline: readonly FacetCoverage[],
): boolean {
  const next = coverageForCards(cards, supports, facets);
  return baseline.every((expected) => {
    const actual = next.find((entry) => entry.facetId === expected.facetId);
    return (
      actual !== undefined &&
      actual.bestLexicalScore >= expected.bestLexicalScore &&
      isSuperset(actual.supportedTokens, expected.supportedTokens) &&
      isSuperset(actual.supportedSourceKinds, expected.supportedSourceKinds)
    );
  });
}

export function isSuperset<T>(
  actual: readonly T[],
  expected: readonly T[],
): boolean {
  const values = new Set(actual);
  return expected.every((value) => values.has(value));
}

function protectUnknownComplements(
  input: {
    readonly strongCards: readonly ApprovedCard[];
    readonly supports: ReadonlyMap<string, CardSupport>;
    readonly chunkLimitPerScope: number;
  },
  reasons: Map<string, ProtectedCardReason>,
): void {
  const evidenceByVersionId = new Map(
    input.strongCards.map((card) => [
      card.versionId,
      supportEvidenceKey(input.supports.get(card.versionId)),
    ]),
  );
  const readsByVersionId = new Map(
    input.strongCards.map((card) => [
      card.versionId,
      planSelectedScopes([card], input.chunkLimitPerScope).items
        .map((item) => item.itemKey)
        .sort(compareText),
    ]),
  );
  const kindsByVersionId = new Map(
    input.strongCards.map((card) => [
      card.versionId,
      [...new Set(card.scopes.map((scope) => scope.kind))].sort(compareText),
    ]),
  );

  for (let leftIndex = 0; leftIndex < input.strongCards.length; leftIndex += 1) {
    const left = input.strongCards[leftIndex];
    if (left === undefined) continue;
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < input.strongCards.length;
      rightIndex += 1
    ) {
      const right = input.strongCards[rightIndex];
      if (right === undefined) continue;
      const sameEvidence =
        evidenceByVersionId.get(left.versionId) ===
        evidenceByVersionId.get(right.versionId);
      const differentKinds = !arraysEqual(
        kindsByVersionId.get(left.versionId) ?? [],
        kindsByVersionId.get(right.versionId) ?? [],
      );
      if (
        !sameEvidence &&
        !(differentKinds && supportsOverlap(left, right, input.supports))
      ) {
        continue;
      }
      if (
        arraysEqual(
          readsByVersionId.get(left.versionId) ?? [],
          readsByVersionId.get(right.versionId) ?? [],
        )
      ) {
        continue;
      }
      reasons.set(left.versionId, "complementarity_unknown");
      reasons.set(right.versionId, "complementarity_unknown");
    }
  }
}

function supportsOverlap(
  left: ApprovedCard,
  right: ApprovedCard,
  supports: ReadonlyMap<string, CardSupport>,
): boolean {
  const leftSupport = supports.get(left.versionId);
  const rightSupport = supports.get(right.versionId);
  if (leftSupport === undefined || rightSupport === undefined) return false;
  return leftSupport.supports.some((entry) => {
    const other = rightSupport.supports.find(
      (candidate) => candidate.facetId === entry.facetId,
    );
    if (other === undefined) return false;
    const otherTokens = new Set(other.supportedTokens);
    return entry.supportedTokens.some((token) => otherTokens.has(token));
  });
}

function supportEvidenceKey(support: CardSupport | undefined): string {
  return canonicalJson(
    support?.supports.map((entry) => ({
      facetId: entry.facetId,
      supportedTokens: entry.supportedTokens,
    })) ?? [],
  );
}

function supportedTokens(
  card: ApprovedCard,
  queryTokens: readonly string[],
): readonly string[] {
  const cardTokens = new Set(
    [
      card.meaning.description,
      ...card.meaning.representativeQuestions,
      ...card.meaning.aliases,
      ...card.meaning.keywords,
      ...card.scopes.flatMap(scopeSearchValues),
    ].flatMap((value) =>
      tokenizeLexicalText(normalizeLexicalText(value)),
    ),
  );
  return queryTokens
    .filter((queryToken) =>
      [...cardTokens].some((cardToken) => tokensMatch(queryToken, cardToken)),
    )
    .filter((token, index, values) => values.indexOf(token) === index)
    .sort(compareText);
}

function tokensMatch(queryToken: string, cardToken: string): boolean {
  if (queryToken === cardToken) return true;
  return (
    /[가-힣]/u.test(cardToken) &&
    [...cardToken].length >= 2 &&
    queryToken.startsWith(cardToken)
  );
}

function arraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
