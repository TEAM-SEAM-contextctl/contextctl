import { catalogSnapshotVersion } from "../domain/card-candidate-index.js";
import type { ApprovedCard } from "../domain/card-catalog.js";
import {
  assertValidCardSelectionProfile,
  type CardSelectionProfile,
} from "../domain/card-selection-profile.js";
import {
  buildCardSelectionEntry,
  normalizeSelectionText,
  type CardSelectionEntry,
} from "../domain/card-selection-text.js";
import {
  CardCandidateIndexInvariantError,
  CardSelectionInputLimitError,
  CardSelectionProfileInvariantError,
} from "../domain/errors.js";
import {
  HYBRID_SCORING_POLICY_VERSION,
  rankHybridCandidateScores,
  type SelectionMode,
} from "../domain/hybrid-ranking.js";
import { planMinimumSufficientCardSet } from "../domain/minimum-sufficient-set.js";
import {
  QUERY_SCORING_POLICY_VERSION,
  scoreCardsAgainstQuery,
  type CandidateScore,
} from "../domain/query-scoring.js";
import {
  applyPolicyContext,
  DEFAULT_POLICY_CONTEXT,
  type PolicyApplication,
  type PolicyContext,
} from "../domain/policy-context.js";
import {
  planningLimitViolations,
  planSelectedScopes,
  SELECTION_PLANNING_LIMITS,
  verifySelectionPlan,
  type SelectionPlan,
} from "../domain/selection-plan.js";
import {
  applySetPlanningDecision,
  judgeCandidates,
  SELECTION_RANKING_POLICY_VERSION,
  type SelectionResult,
  type SelectionThresholds,
} from "../domain/selection-verdict.js";
import { measureTextUnits } from "../domain/text-measure.js";
import type { ApprovedCardCatalog } from "../ports/approved-card-catalog.js";
import type { CardCandidateIndexStore } from "../ports/card-candidate-index-store.js";
import type { CardEmbeddingPort } from "../ports/card-embedding.js";
import { CardEmbeddingFault } from "../ports/card-embedding.js";
import {
  CardEmbeddingUnavailableError,
  EmptyQueryError,
  QueryInputLimitExceededError,
  ResolveContextFailure,
  SelectionPlanLimitExceededError,
} from "./errors.js";

export {
  HYBRID_SCORING_POLICY_VERSION,
  QUERY_SCORING_POLICY_VERSION,
  SELECTION_RANKING_POLICY_VERSION,
};

/**
 * How many chunks one managed document Scope may contribute before the evidence
 * budget is even consulted.
 *
 * It exists so that a Card pointing at a large index cannot flood assembly on
 * its own: the budget in `context-assembly.ts` caps the answer as a whole,
 * while this caps each Scope's share of the ranking that feeds it. The value is
 * deliberately above `DEFAULT_CONTEXT_BUDGET.maxChunks / 2`, so two Scopes can
 * still fill the budget between them.
 *
 * Not a number of its own: it *is* the `selection-planning-v2` ceiling on
 * chunks per target. The default is the maximum the policy allows, and a
 * deployment may set `chunkLimitPerScope` lower but never higher — a higher
 * value is refused at planning as `selection_plan_limit_exceeded`.
 */
export const DEFAULT_CHUNK_LIMIT_PER_SCOPE =
  SELECTION_PLANNING_LIMITS.chunksPerTarget;

/**
 * How many Cards each path contributes to the union that is ranked on both
 * signals.
 *
 * Two separate bounds rather than one shared cut, because the two paths are
 * bounded for different reasons. The lexical bound keeps a Card that matched one
 * incidental keyword out of a ranking it cannot win. The semantic bound keeps a
 * catalog-sized scan of near-zero cosines out of the union, where every entry
 * would be indistinguishable noise.
 *
 * Both are generous relative to the catalog this is written for. That is
 * deliberate: the bound exists to stop a pathological catalog from filling a
 * ranking, not to tune recall, and a demo-sized catalog should be fully
 * considered by both paths.
 */
export const DEFAULT_LEXICAL_TOP_K = 32;
export const DEFAULT_SEMANTIC_TOP_K = 32;

/**
 * The three things the semantic path needs, bound together.
 *
 * All three or none, and that is a type-level statement rather than a
 * convention: a port without a profile cannot say which space its vectors live
 * in, and an index store without a port has nothing to prepare an index from.
 * Three independent optional fields would make five of the eight combinations
 * meaningless and each one a runtime check.
 */
export interface SemanticSelectionPorts {
  readonly embedding: CardEmbeddingPort;
  readonly index: CardCandidateIndexStore;
  readonly profile: CardSelectionProfile;
}

/**
 * Everything selection reaches outside itself for.
 *
 * There is no retrieval port here and there must not be one. Selection decides
 * what may be read and stops; whoever performs the read is the party entitled
 * to bind a store, and putting that binding within reach of this function would
 * make "which Cards match" and "which index is touched" one decision.
 *
 * `semantic` is optional because a deployment without Card vectors is a real
 * deployment rather than a broken one — it answers under `lexical_degraded` and
 * says so. What is *not* optional is that the response state which of the two it
 * was: see `SelectionPlanSummary.mode`.
 */
export interface SelectContextPorts {
  readonly catalog: ApprovedCardCatalog;
  readonly semantic?: SemanticSelectionPorts;
}

/**
 * What a deployment decides about the semantic path. Never a request parameter.
 *
 * A caller may not state any of this, for the reason `ResolveContextRequest`
 * gives: whether a query is allowed to be answered from a degraded ranking is a
 * property of the deployment's catalog, not of the question being asked.
 */
export interface SemanticSelectionPolicy {
  /**
   * Whether a query may still be answered when the semantic path is unusable.
   *
   * `true` by default, which is the answer for a catalog whose Cards declare
   * real keywords: a lexical ranking is worse than a hybrid one and far better
   * than no answer. A deployment whose Cards are written for meaning rather than
   * for terms sets it to `false` and gets `selection_embedding_unavailable`
   * instead of a ranking its catalog cannot support.
   */
  readonly allowLexicalDegraded?: boolean;
  readonly lexicalTopK?: number;
  readonly semanticTopK?: number;
}

export interface SelectContextOptions {
  readonly thresholds?: SelectionThresholds;
  /**
   * Chunks requested per managed document Scope. Defaults to
   * `DEFAULT_CHUNK_LIMIT_PER_SCOPE`, which is also the most the policy allows.
   *
   * A value above `SELECTION_PLANNING_LIMITS.chunksPerTarget` is refused at
   * planning as `selection_plan_limit_exceeded`; a non-positive value is
   * transcribed onto the guide as given, because the executor already defines
   * what such a bound means. It does affect identity — the bound is part of
   * both `itemKey` and `targetKey` — so two runs under different limits produce
   * different plans by construction.
   */
  readonly chunkLimitPerScope?: number;
  readonly semantic?: SemanticSelectionPolicy;
  /**
   * What this deployment permits a query to reach. Defaults to
   * `DEFAULT_POLICY_CONTEXT` — retrieval only, sensitive Cards denied.
   *
   * Configuration injected by the Composition Root, like `thresholds` and
   * `semantic` beside it, and for the same reason stated more sharply: a
   * request type that could carry this field would be a caller granting itself
   * access. `ResolveContextRequest` has no such field, and must not gain one
   * (the v1 access model: not the query, not an MCP argument, not a CLI flag).
   */
  readonly policy?: PolicyContext;
}

/**
 * Selects the approved Cards a query may be answered from and plans the reads
 * that answering it requires.
 *
 * The order of the steps is the contract. Scoring runs to completion — both
 * signals, merged into one number per Card — before anything is judged, and
 * judgement runs to completion before anything is planned, so only admitted
 * Cards ever produce a target: a deferred or rejected Card must not cause a read
 * against an index, because the read itself is an access, not just a fact about
 * the answer.
 *
 * Nothing in the plan is executed. The one thing that *is* executed here is the
 * embedding of the query and, on a catalog snapshot this process has not indexed
 * yet, of the Cards — which is why this function is `async` and why it can fail.
 * Neither touches a document index, so the property that matters is unchanged:
 * no Scope is read before a verdict exists.
 *
 * `query` is echoed back exactly as received, before normalization, so a caller
 * can pair the result with the request it sent.
 */
export async function selectContext(
  ports: SelectContextPorts,
  queryText: string,
  options: SelectContextOptions = {},
): Promise<SelectionPlan> {
  // Checked before the catalog is touched: an empty query cannot select
  // anything, so reading the catalog would be an access with no possible use.
  if (queryText.trim() === "") {
    throw new EmptyQueryError();
  }

  const cards = await ports.catalog.listApprovedCards();
  // Before either candidate search and before any score exists. A Card the
  // policy keeps out is absent from the lexical set and from the semantic
  // search alike, so it can neither be ranked nor take a top-K place an
  // eligible Card should have had; and it is absent from the verdicts, so the
  // counts a consumer sees describe only what was evaluated (the v1 access
  // model and `SelectionSummary` contract). A catalog whose policies
  // cannot be read is refused here as a whole.
  const policy = applyPolicyContext(
    cards,
    options.policy ?? DEFAULT_POLICY_CONTEXT,
  );
  const lexical = scoreCardsAgainstQuery(queryText, policy.eligible);
  const scored = await scoreWithSemantics(
    ports,
    options,
    queryText,
    cards,
    policy,
    lexical,
  );
  // `undefined` rather than a local default: the threshold band is
  // `judgeCandidates`' own decision and must not be restated here, or the two
  // defaults would drift apart silently.
  const independentSelection = judgeCandidates(
    scored.candidates,
    options.thresholds,
  );
  const chunkLimit =
    options.chunkLimitPerScope ?? DEFAULT_CHUNK_LIMIT_PER_SCOPE;
  const setPlan = planMinimumSufficientCardSet({
    query: queryText,
    eligibleCards: policy.eligible,
    lexicalScores: lexical,
    rankedScores: scored.candidates,
    initialSelection: independentSelection,
    mode: scored.mode,
    chunkLimitPerScope: chunkLimit,
  });
  const selection = applySetPlanningDecision(
    independentSelection,
    new Set(setPlan.selectedCards.map((card) => card.versionId)),
  );
  const admitted = collectAdmittedCards(selection, cards);
  const planned = planSelectedScopes(admitted, chunkLimit);
  // After merging and before anything is executed: the plan's real size is
  // only known once same-Scope Cards have collapsed onto shared items, and a
  // plan over policy must not be trimmed to fit or read at all (the Retrieval
  // Guide limit invariant).
  const violations = planningLimitViolations(admitted.length, planned);
  if (violations.length > 0) {
    throw new SelectionPlanLimitExceededError(violations);
  }

  const plan: SelectionPlan = {
    query: queryText,
    summary: {
      candidates: scored.candidates,
      selection,
      mode: scored.mode,
      policy: { context: policy.context, excluded: policy.excluded },
      planning: setPlan.audit,
    },
    items: planned.items,
    managedTargets: planned.managedTargets,
  };
  // Re-derived before the plan leaves: the keys the executor will read by are
  // recomputed from the fields they are defined over, and the plan's Cards are
  // compared against the verdicts that were just handed down (the managed-
  // document retrieval invariant).
  verifySelectionPlan(plan, { query: queryText });
  return plan;
}

/** What the scoring step decided, and under which family it decided it. */
interface ScoredCandidates {
  readonly mode: SelectionMode;
  readonly candidates: readonly CandidateScore[];
}

interface PreparedSemanticCatalog {
  readonly entries: readonly CardSelectionEntry[];
  readonly snapshots: WeakMap<CardSelectionProfile, string>;
}

/**
 * Canonical Card text and its snapshot digest are generation assets. Keeping
 * them behind a weak catalog key avoids rebuilding 10,000 digests per request
 * without retaining a retired Registry generation.
 */
const preparedSemanticCatalogs = new WeakMap<
  readonly ApprovedCard[],
  PreparedSemanticCatalog
>();

const eligibleVersionIdsByCatalog = new WeakMap<
  readonly ApprovedCard[],
  ReadonlySet<string>
>();

/**
 * Adds the semantic signal to the lexical scores, or states why it could not.
 *
 * Every early return is a `lexical_degraded` with a stated reason, and the
 * reason is what the degradation policy is applied to. There is no path through
 * this function that admits a Card the lexical ranking would not have admitted:
 * degradation removes a signal, it never relaxes a threshold and never widens
 * what a query may reach. That is the difference between "we answered with less"
 * and "we answered with more than we should have".
 */
async function scoreWithSemantics(
  ports: SelectContextPorts,
  options: SelectContextOptions,
  queryText: string,
  catalog: readonly ApprovedCard[],
  policy: PolicyApplication,
  lexical: readonly CandidateScore[],
): Promise<ScoredCandidates> {
  const semantic = ports.semantic;
  const degradation = options.semantic ?? {};
  const degrade = (reason: string): ScoredCandidates => {
    if (degradation.allowLexicalDegraded ?? true) {
      return { mode: "lexical_degraded", candidates: lexical };
    }
    throw new CardEmbeddingUnavailableError(reason);
  };

  if (semantic === undefined) {
    return degrade("no Card embedding provider is bound to this deployment");
  }
  if (catalog.length === 0) {
    // An empty catalog has no candidate index to be accurate about, and
    // embedding a query no vector could be compared against would cost a model
    // call to produce a ranking over nothing. The degradation contract allows this case to
    // report as degraded when the policy permits it.
    return degrade("the catalog holds no approved Card to build an index from");
  }
  if (policy.eligible.length === 0) {
    // Every approved Card is kept out by policy. Not a degradation and not an
    // error: the hybrid policy applied in full and simply had nothing to rank,
    // which the `SelectionSummary` contract names as a `hybrid` run whose call
    // condition skipped the semantic call, while the same section defines an
    // ordinary empty answer. No query vector is
    // built, because there is no eligible vector to compare it against — and
    // the degradation policy is not consulted, because a deployment that
    // forbids lexical answers has not forbidden empty ones.
    return { mode: "hybrid", candidates: [] };
  }

  try {
    assertValidCardSelectionProfile(semantic.profile);
    // Over the whole approved catalog, not the eligible part. The index is a
    // derived artefact of the catalog and must stay one: keyed on the eligible
    // set it would be rebuilt — every Card re-embedded — each time the policy
    // changed, and `covers` could no longer say whether this snapshot is
    // current. The policy is applied at search time instead, below.
    const prepared = prepareSemanticCatalog(catalog);
    const entries = prepared.entries;
    let snapshotVersion = prepared.snapshots.get(semantic.profile);
    if (snapshotVersion === undefined) {
      snapshotVersion = catalogSnapshotVersion(entries, semantic.profile);
      prepared.snapshots.set(semantic.profile, snapshotVersion);
    }
    const index = await semantic.index.acquire({
      entries,
      catalogSnapshotVersion: snapshotVersion,
      profile: semantic.profile,
      embedding: semantic.embedding,
    });

    // The store promises an index for exactly this snapshot; this checks it
    // rather than trusting it, because an index that is merely *stale* produces
    // no error at all — the Cards it is missing simply never appear in a
    // ranking, which is indistinguishable from Cards that scored badly.
    let uncovered = 0;
    for (const entry of entries) {
      if (!index.covers(entry.cardVersionId, entry.selectionTextDigest)) {
        uncovered += 1;
      }
    }
    if (uncovered > 0) {
      return degrade(
        `the candidate index does not cover ${uncovered} approved Card version(s) of this snapshot`,
      );
    }

    const queryVector = await embedQuery(semantic, queryText);

    return {
      mode: "hybrid",
      candidates: rankHybridCandidateScores({
        lexical,
        // Pre-filtered inside the exact scan, before the cut: an ineligible
        // Card is never compared, so it cannot hold one of the `semanticTopK`
        // places. Filtering the returned list instead would be the post-filter
        // v1 access model forbids.
        semantic: index.topK(
          queryVector,
          degradation.semanticTopK ?? DEFAULT_SEMANTIC_TOP_K,
          {
            eligibleVersionIds: eligibleVersionIds(policy.eligible),
          },
        ),
        lexicalTopK: degradation.lexicalTopK ?? DEFAULT_LEXICAL_TOP_K,
      }),
    };
  } catch (cause: unknown) {
    // Four failures are never degraded away. A `ResolveContextFailure` is
    // already a decision about this request — including the caller's own
    // over-long query and a refusal this function itself raised. An over-long
    // Card is a catalog that has to be fixed. And the two invariant errors mean
    // a value this package produced broke a rule this package states, which is
    // a defect: answering anyway would ship the defect as a quieter ranking.
    if (
      cause instanceof ResolveContextFailure ||
      cause instanceof CardSelectionInputLimitError ||
      cause instanceof CardSelectionProfileInvariantError ||
      cause instanceof CardCandidateIndexInvariantError
    ) {
      throw cause;
    }
    return degrade(describeEmbeddingFailure(cause));
  }
}

function eligibleVersionIds(
  eligible: readonly ApprovedCard[],
): ReadonlySet<string> {
  const cached = eligibleVersionIdsByCatalog.get(eligible);
  if (cached !== undefined) return cached;
  const versionIds = new Set(eligible.map((card) => card.versionId));
  eligibleVersionIdsByCatalog.set(eligible, versionIds);
  return versionIds;
}

function prepareSemanticCatalog(
  catalog: readonly ApprovedCard[],
): PreparedSemanticCatalog {
  const cached = preparedSemanticCatalogs.get(catalog);
  if (cached !== undefined) return cached;
  const prepared: PreparedSemanticCatalog = {
    entries: catalog.map(buildCardSelectionEntry),
    snapshots: new WeakMap(),
  };
  preparedSemanticCatalogs.set(catalog, prepared);
  return prepared;
}

/**
 * The query's vector, built exactly once per resolution.
 *
 * Once, and never cached across requests. A query vector is derived from a
 * user's own text: keeping one would build, in a process that is otherwise
 * stateless about requests, a store of what people asked — and it would buy
 * nothing, because the same query arriving twice is not the common case that a
 * cache pays for. Card vectors are the opposite on both counts, which is why
 * they live in an index that outlives the request.
 *
 * Normalized the same way a Card's text is. Encoding a query under one transform
 * and the Cards under another puts them in two spaces that were meant to be one,
 * and the resulting cosine is not detectably wrong — merely worse.
 */
async function embedQuery(
  semantic: SemanticSelectionPorts,
  queryText: string,
): Promise<readonly number[]> {
  const text = normalizeSelectionText(queryText);
  const limits = semantic.profile.admissionLimits;
  const units = measureTextUnits(text);

  if (units > limits.maxQueryUnits) {
    throw new QueryInputLimitExceededError(
      `the query measures ${units} ${limits.textMeasureProfileVersion} units, above the ${limits.maxQueryUnits} profile ${semantic.profile.id} admits`,
    );
  }

  const outputs = await semantic.embedding.embed({
    profile: semantic.profile,
    inputs: [{ key: "query", text }],
  });
  const vector = outputs[0]?.vector;
  if (vector === undefined || vector.length !== semantic.profile.dimensions) {
    throw new CardEmbeddingFault("invalid_response", false);
  }
  return vector;
}

/**
 * What a degraded response was degraded by, as a sentence for an operator.
 *
 * A provider's own fault code when it stated one, because the codes are the
 * vocabulary an operator diagnoses with; the exception's message otherwise
 * never travels — it is written for a log, and this string reaches a
 * `selection_embedding_unavailable` a consumer can see.
 */
function describeEmbeddingFailure(cause: unknown): string {
  if (cause instanceof CardEmbeddingFault) {
    return `the Card embedding provider failed with ${cause.code}`;
  }
  return "the Card embedding provider failed";
}

/**
 * The admitted Cards, in the order the ranking put them.
 *
 * Walking the outcomes rather than the catalog is what makes `selectedBy` a
 * rank order: the merge in `planSelectedScopes` appends on first appearance, so
 * the sequence this returns is the sequence a merged item reports.
 */
function collectAdmittedCards(
  selection: SelectionResult,
  cards: readonly ApprovedCard[],
): readonly ApprovedCard[] {
  const byVersionId = new Map(cards.map((card) => [card.versionId, card]));
  const admitted: ApprovedCard[] = [];

  for (const outcome of selection.outcomes) {
    if (outcome.verdict !== "admit") {
      continue;
    }
    const card = byVersionId.get(outcome.versionId);
    // Every outcome originates from a scored Card, so a miss is impossible for
    // any input `judgeCandidates` accepted; the lookup is still guarded rather
    // than asserted, because a missing Card is not worth failing a whole
    // selection over.
    if (card !== undefined) {
      admitted.push(card);
    }
  }

  return admitted;
}

/** Re-exported so a caller can build the same entries the index is keyed on. */
export type { CardSelectionEntry };
