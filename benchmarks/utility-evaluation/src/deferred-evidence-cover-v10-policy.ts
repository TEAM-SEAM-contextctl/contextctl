import {
  canonicalDigest,
  type ApprovedCard,
  type ScoreSignal,
} from "@contextctl/selection-delivery";

export const DEFERRED_EVIDENCE_CANDIDATE_BOUNDS = Object.freeze({
  topKPerCardSignal: 12,
  maximumCandidateCards: 16,
  maximumCandidateScopes: 16,
  probeChunksPerScope: 3,
  maximumProbeChunks: 48,
});

export const DEFERRED_EVIDENCE_COVER_POLICY_VERSION =
  "selection-deferred-evidence-cover-candidate-v10" as const;

export const DEFERRED_EVIDENCE_COVER_CONFIGURATION = Object.freeze({
  candidateBounds: DEFERRED_EVIDENCE_CANDIDATE_BOUNDS,
  minimumRoutingSupport: 0.82,
  minimumSupplementSupport: 0.86,
  minimumExecutionSupport: 0.89,
  wholeQueryWeights: Object.freeze({ sentence: 0.8, card: 0.2 }),
  lexicalWeights: Object.freeze({ exact: 0.75, characterNgram: 0.25 }),
  coverageTolerance: 0.025,
  minimumMarginalCoverage: 0.01,
  maximumSelectedCards: 4,
});

export interface CardSignalInput {
  readonly card: ApprovedCard;
  readonly lexical: number;
  readonly semantic: number;
  readonly hybrid: number;
  readonly lexicalSignals: readonly ScoreSignal[];
}

export interface ScopeProbeCandidate extends CardSignalInput {
  readonly lexicalRankSupport: number;
  readonly semanticRankSupport: number;
  readonly routingSupport: number;
  readonly cardSupport: number;
}

export interface ProbeChunk {
  readonly chunkRevisionId: string;
  readonly text: string;
  readonly rank: number;
  readonly similarity: number;
  readonly sentenceSimilarity: number;
}

export interface ProbedCardInput {
  readonly candidate: ScopeProbeCandidate;
  readonly scopes: readonly {
    readonly scopeId: string;
    readonly scopeVersion: string;
    readonly chunks: readonly ProbeChunk[];
  }[];
}

export function buildScopeProbeCandidates(
  inputs: readonly CardSignalInput[],
): readonly ScopeProbeCandidate[] {
  const topK = DEFERRED_EVIDENCE_CANDIDATE_BOUNDS.topKPerCardSignal;
  const lexical = ranked(inputs, "lexical").slice(0, topK);
  const semantic = ranked(inputs, "semantic").slice(0, topK);
  const lexicalRanks = rankSupports(lexical);
  const semanticRanks = rankSupports(semantic);
  const union = new Map<string, CardSignalInput>();
  for (const input of [...lexical, ...semantic]) union.set(input.card.versionId, input);
  return [...union.values()]
    .map((input) => {
      const lexicalRankSupport = lexicalRanks.get(input.card.versionId) ?? 0;
      const semanticRankSupport = semanticRanks.get(input.card.versionId) ?? 0;
      return {
        ...input,
        lexicalRankSupport,
        semanticRankSupport,
        routingSupport:
          0.8 * Math.max(lexicalRankSupport, semanticRankSupport) +
          0.2 * Math.min(lexicalRankSupport, semanticRankSupport),
        cardSupport: input.hybrid,
      };
    })
    .sort(
      (left, right) =>
        right.routingSupport - left.routingSupport ||
        right.cardSupport - left.cardSupport ||
        compareText(left.card.versionId, right.card.versionId),
    )
    .slice(0, DEFERRED_EVIDENCE_CANDIDATE_BOUNDS.maximumCandidateCards);
}

export const DEFERRED_EVIDENCE_COVER_POLICY_DIGEST = canonicalDigest({
  version: DEFERRED_EVIDENCE_COVER_POLICY_VERSION,
  configuration: DEFERRED_EVIDENCE_COVER_CONFIGURATION,
  algorithm:
    "bounded-card-union+continuous-reject-defer-admit+unicode-word-idf-cover+specific-scope-dominance-v10",
});

interface Evidence {
  readonly cardId: string;
  readonly versionId: string;
  readonly description: string;
  readonly cardSupport: number;
  readonly cardSemanticSimilarity: number;
  readonly cardLexicalSupport: number;
  readonly cardLexicalSignals: ScopeProbeCandidate["lexicalSignals"];
  readonly routingSupport: number;
  readonly sentenceSimilarity: number;
  readonly wholeQuerySupport: number;
  readonly tokenSupports: readonly number[];
  readonly evidenceChunkRevisionId: string | undefined;
  readonly scopeCount: number;
  readonly chunkCount: number;
}

interface LexicalChunk {
  readonly chunkRevisionId: string;
  readonly words: readonly string[];
}

export function planDeferredEvidenceCover(input: {
  readonly query: string;
  readonly cards: readonly ProbedCardInput[];
}): {
  readonly executable: boolean;
  readonly selectedCards: readonly ApprovedCard[];
  readonly routedCards: readonly ApprovedCard[];
  readonly disposition: "admit" | "defer" | "reject";
  readonly audit: {
    readonly policyVersion: typeof DEFERRED_EVIDENCE_COVER_POLICY_VERSION;
    readonly policyDigest: string;
    readonly queryTokens: readonly string[];
    readonly tokenWeights: readonly number[];
    readonly candidateVersionIds: readonly string[];
    readonly selectedVersionIds: readonly string[];
    readonly routedVersionIds: readonly string[];
    readonly disposition: "admit" | "defer" | "reject";
    readonly targetCoverage: readonly number[];
    readonly selectedCoverage: readonly number[];
    readonly evidence: readonly Evidence[];
    readonly executable: boolean;
    readonly auditDigest: string;
  };
} {
  const queryTokens = words(input.query);
  if (queryTokens.length === 0) throw new TypeError("query has no words");
  assertBounds(input.cards);
  const allChunks = distinctChunks(input.cards);
  const wordsByChunk = new Map(
    allChunks.map((chunk) => [chunk.chunkRevisionId, chunk.words]),
  );
  const tokenWeights = inverseDocumentWeights(queryTokens, allChunks);
  const byVersionId = new Map<string, ApprovedCard>();
  const evidence = input.cards.map((entry): Evidence => {
    const card = entry.candidate.card;
    if (byVersionId.has(card.versionId)) {
      throw new TypeError(`duplicate probed Card Version: ${card.versionId}`);
    }
    byVersionId.set(card.versionId, card);
    const chunks = entry.scopes.flatMap((scope) => scope.chunks);
    const best = [...chunks].sort(
      (left, right) =>
        right.sentenceSimilarity - left.sentenceSimilarity ||
        compareText(left.chunkRevisionId, right.chunkRevisionId),
    )[0];
    const sentenceSimilarity = best?.sentenceSimilarity ?? -1;
    return {
      cardId: card.cardId,
      versionId: card.versionId,
      description: card.meaning.description,
      cardSupport: entry.candidate.cardSupport,
      cardSemanticSimilarity: entry.candidate.semantic,
      cardLexicalSupport: entry.candidate.lexical,
      cardLexicalSignals: entry.candidate.lexicalSignals,
      routingSupport: strongestBm25(entry.candidate.lexicalSignals),
      sentenceSimilarity,
      wholeQuerySupport: combinedWholeSupport(
        sentenceSimilarity,
        entry.candidate.cardSupport,
      ),
      tokenSupports: queryTokens.map((token) =>
        chunks.reduce(
          (maximum, chunk) =>
            Math.max(
              maximum,
              wordSupport(token, wordsByChunk.get(chunk.chunkRevisionId) ?? []),
            ),
          0,
        ),
      ),
      evidenceChunkRevisionId: best?.chunkRevisionId,
      scopeCount: entry.scopes.length,
      chunkCount: new Set(chunks.map((chunk) => chunk.chunkRevisionId)).size,
    };
  });
  const routed = evidence.filter(
    (entry) =>
      entry.wholeQuerySupport >=
      DEFERRED_EVIDENCE_COVER_CONFIGURATION.minimumRoutingSupport,
  );
  const supplements = routed.filter(
    (entry) =>
      entry.wholeQuerySupport >=
      DEFERRED_EVIDENCE_COVER_CONFIGURATION.minimumSupplementSupport,
  );
  const specific = supplements.filter(
    (entry) =>
      !supplements.some(
        (other) =>
          other.versionId !== entry.versionId &&
          other.evidenceChunkRevisionId !== undefined &&
          other.evidenceChunkRevisionId === entry.evidenceChunkRevisionId &&
          evidenceCost(other) < evidenceCost(entry),
      ),
  );
  const admissionLeader = [...specific]
    .filter(
      (entry) =>
        entry.wholeQuerySupport >=
        DEFERRED_EVIDENCE_COVER_CONFIGURATION.minimumExecutionSupport,
    )
    .sort(
      (left, right) =>
        right.wholeQuerySupport - left.wholeQuerySupport ||
        compareText(left.versionId, right.versionId),
    )[0];
  const targetCoverage = aggregateCoverage(specific, queryTokens.length);
  const selectedEvidence =
    admissionLeader === undefined
      ? []
      : selectMinimumSet(
          specific,
          targetCoverage,
          tokenWeights,
          admissionLeader,
        );
  const selectedCoverage = aggregateCoverage(
    selectedEvidence,
    queryTokens.length,
  );
  const selectedCards = selectedEvidence.map((entry) => {
    const card = byVersionId.get(entry.versionId);
    if (card === undefined) throw new TypeError(`missing Card ${entry.versionId}`);
    return card;
  });
  const routedEvidence =
    selectedEvidence.length > 0
      ? selectedEvidence
      : routed
          .sort(
            (left, right) =>
              right.routingSupport - left.routingSupport ||
              right.wholeQuerySupport - left.wholeQuerySupport ||
              compareText(left.versionId, right.versionId),
          )
          .slice(0, 1);
  const routedCards = routedEvidence.map((entry) => {
    const card = byVersionId.get(entry.versionId);
    if (card === undefined) {
      throw new TypeError(`missing routed Card ${entry.versionId}`);
    }
    return card;
  });
  const disposition: "admit" | "defer" | "reject" =
    selectedCards.length > 0 ? "admit" : routedCards.length > 0 ? "defer" : "reject";
  const auditBody = {
    policyVersion: DEFERRED_EVIDENCE_COVER_POLICY_VERSION,
    policyDigest: DEFERRED_EVIDENCE_COVER_POLICY_DIGEST,
    queryTokens,
    tokenWeights,
    candidateVersionIds: evidence.map((entry) => entry.versionId).sort(compareText),
    selectedVersionIds: selectedCards.map((card) => card.versionId).sort(compareText),
    routedVersionIds: routedCards.map((card) => card.versionId).sort(compareText),
    disposition,
    targetCoverage,
    selectedCoverage,
    evidence: [...evidence].sort(
      (left, right) =>
        right.wholeQuerySupport - left.wholeQuerySupport ||
        compareText(left.versionId, right.versionId),
    ),
    executable: selectedCards.length > 0,
  };
  return {
    executable: selectedCards.length > 0,
    selectedCards,
    routedCards,
    disposition,
    audit: { ...auditBody, auditDigest: canonicalDigest(auditBody) },
  };
}

function strongestBm25(
  signals: ScopeProbeCandidate["lexicalSignals"],
): number {
  return signals.reduce(
    (maximum, signal) =>
      signal.field === "bm25"
        ? Math.max(maximum, signal.contribution)
        : maximum,
    0,
  );
}

function selectMinimumSet(
  evidence: readonly Evidence[],
  target: readonly number[],
  weights: readonly number[],
  leader: Evidence,
): readonly Evidence[] {
  const selected: Evidence[] = [leader];
  let coverage: readonly number[] = [...leader.tokenSupports];
  while (
    selected.length < DEFERRED_EVIDENCE_COVER_CONFIGURATION.maximumSelectedCards &&
    !preservesTarget(coverage, target)
  ) {
    const choices = evidence
      .filter((entry) => !selected.includes(entry))
      .map((entry) => {
        const next = mergeCoverage(coverage, entry.tokenSupports);
        const marginal = weighted(next, weights) - weighted(coverage, weights);
        return {
          entry,
          next,
          marginal,
          utility: marginal / Math.max(1, evidenceCost(entry)),
        };
      })
      .filter(
        (choice) =>
          choice.marginal >=
          DEFERRED_EVIDENCE_COVER_CONFIGURATION.minimumMarginalCoverage,
      )
      .sort(
        (left, right) =>
          right.utility - left.utility ||
          right.entry.wholeQuerySupport - left.entry.wholeQuerySupport ||
          compareText(left.entry.versionId, right.entry.versionId),
      );
    const chosen = choices[0];
    if (chosen === undefined) break;
    selected.push(chosen.entry);
    coverage = chosen.next;
  }
  return preservesTarget(coverage, target)
    ? selected.sort((left, right) =>
        compareText(left.versionId, right.versionId),
      )
    : [];
}

function words(value: string): readonly string[] {
  return [...new Intl.Segmenter("und", { granularity: "word" }).segment(value)]
    .filter((entry) => entry.isWordLike)
    .map((entry) => entry.segment.normalize("NFKC").toLocaleLowerCase("und"));
}

function wordSupport(query: string, candidates: readonly string[]): number {
  const fuzzy = candidates.reduce(
    (maximum, candidate) => Math.max(maximum, ngramSimilarity(query, candidate)),
    0,
  );
  const exact = candidates.includes(query) ? 1 : 0;
  const weights = DEFERRED_EVIDENCE_COVER_CONFIGURATION.lexicalWeights;
  return Math.min(1, weights.exact * exact + weights.characterNgram * fuzzy);
}

function inverseDocumentWeights(
  tokens: readonly string[],
  chunks: readonly LexicalChunk[],
): readonly number[] {
  const raw = tokens.map((token) => {
    const matching = chunks.filter(
      (chunk) => wordSupport(token, chunk.words) >= 0.75,
    ).length;
    return Math.log(1 + (chunks.length - matching + 0.5) / (matching + 0.5));
  });
  const total = raw.reduce((sum, value) => sum + value, 0);
  return raw.map((value) => value / total);
}

function ngramSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  const a = ngrams(left);
  const b = ngrams(right);
  if (a.size === 0 || b.size === 0) return 0;
  let common = 0;
  for (const value of a) if (b.has(value)) common += 1;
  return (2 * common) / (a.size + b.size);
}

function ngrams(value: string): ReadonlySet<string> {
  const points = [...value];
  const result = new Set<string>();
  for (const width of [2, 3]) {
    for (let index = 0; index + width <= points.length; index += 1) {
      result.add(points.slice(index, index + width).join(""));
    }
  }
  return result;
}

function distinctChunks(cards: readonly ProbedCardInput[]): readonly LexicalChunk[] {
  const chunks = new Map<string, LexicalChunk>();
  for (const card of cards) {
    for (const scope of card.scopes) {
      for (const chunk of scope.chunks) {
        chunks.set(chunk.chunkRevisionId, {
          chunkRevisionId: chunk.chunkRevisionId,
          words: words(chunk.text),
        });
      }
    }
  }
  return [...chunks.values()];
}

function aggregateCoverage(
  evidence: readonly Evidence[],
  width: number,
): readonly number[] {
  return Array.from({ length: width }, (_, index) =>
    evidence.reduce(
      (maximum, entry) => Math.max(maximum, entry.tokenSupports[index] ?? 0),
      0,
    ),
  );
}

function mergeCoverage(
  left: readonly number[],
  right: readonly number[],
): readonly number[] {
  return left.map((value, index) => Math.max(value, right[index] ?? 0));
}

function preservesTarget(actual: readonly number[], target: readonly number[]): boolean {
  return target.every(
    (value, index) =>
      (actual[index] ?? 0) +
        DEFERRED_EVIDENCE_COVER_CONFIGURATION.coverageTolerance >=
      value,
  );
}

function weighted(values: readonly number[], weights: readonly number[]): number {
  return values.reduce(
    (sum, value, index) => sum + value * (weights[index] ?? 0),
    0,
  );
}

function combinedWholeSupport(sentence: number, card: number): number {
  const weights = DEFERRED_EVIDENCE_COVER_CONFIGURATION.wholeQueryWeights;
  return Math.max(0, Math.min(1, weights.sentence * sentence + weights.card * card));
}

function evidenceCost(value: Evidence): number {
  return value.scopeCount + value.chunkCount;
}

function assertBounds(cards: readonly ProbedCardInput[]): void {
  const bounds = DEFERRED_EVIDENCE_COVER_CONFIGURATION.candidateBounds;
  if (cards.length > bounds.maximumCandidateCards) {
    throw new TypeError("cover Card limit exceeded");
  }
  const scopes = new Set<string>();
  const chunks = new Set<string>();
  const observations = new Map<
    string,
    Pick<ProbeChunk, "text" | "similarity" | "sentenceSimilarity">
  >();
  for (const card of cards) {
    if (
      !Number.isFinite(card.candidate.routingSupport) ||
      !Number.isFinite(card.candidate.cardSupport)
    ) {
      throw new TypeError("probed Card support must be finite");
    }
    for (const scope of card.scopes) {
      scopes.add(`${scope.scopeId}\0${scope.scopeVersion}`);
      if (scope.chunks.length > bounds.probeChunksPerScope) {
        throw new TypeError("cover Scope Chunk limit exceeded");
      }
      for (const chunk of scope.chunks) {
        if (
          !Number.isInteger(chunk.rank) ||
          chunk.rank < 1 ||
          !Number.isFinite(chunk.similarity) ||
          !Number.isFinite(chunk.sentenceSimilarity)
        ) {
          throw new TypeError("probe Chunk observation is invalid");
        }
        const previous = observations.get(chunk.chunkRevisionId);
        if (
          previous !== undefined &&
          (previous.text !== chunk.text ||
            previous.similarity !== chunk.similarity ||
            previous.sentenceSimilarity !== chunk.sentenceSimilarity)
        ) {
          throw new TypeError("probe Chunk observation is inconsistent");
        }
        observations.set(chunk.chunkRevisionId, chunk);
        chunks.add(chunk.chunkRevisionId);
      }
    }
  }
  if (
    scopes.size > bounds.maximumCandidateScopes ||
    chunks.size > bounds.maximumProbeChunks
  ) {
    throw new TypeError("cover probe bound exceeded");
  }
}

function ranked(
  inputs: readonly CardSignalInput[],
  signal: "lexical" | "semantic",
): readonly CardSignalInput[] {
  const seen = new Set<string>();
  for (const input of inputs) {
    if (seen.has(input.card.versionId)) {
      throw new TypeError(`duplicate Card Version: ${input.card.versionId}`);
    }
    seen.add(input.card.versionId);
    if (
      !Number.isFinite(input.lexical) ||
      !Number.isFinite(input.semantic) ||
      !Number.isFinite(input.hybrid)
    ) {
      throw new TypeError("Card signals must be finite");
    }
  }
  return [...inputs].sort(
    (left, right) =>
      right[signal] - left[signal] ||
      compareText(left.card.versionId, right.card.versionId),
  );
}

function rankSupports(
  inputs: readonly CardSignalInput[],
): ReadonlyMap<string, number> {
  const denominator = Math.max(1, inputs.length - 1);
  return new Map(
    inputs.map((entry, index) => [
      entry.card.versionId,
      1 - index / denominator,
    ]),
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
