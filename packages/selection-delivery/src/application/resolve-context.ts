import type {
  ApprovedCard,
  ApprovedManagedDocumentScope,
  ApprovedScope,
  ApprovedScopeReference,
} from "../domain/card-catalog.js";
import {
  buildRetrievalGuide,
  type ContextResolution,
  type ResolutionFaultCode,
  type ResolutionItem,
  type RetrievedDocumentContext,
} from "../domain/context-resolution.js";
import {
  assembleDocumentEvidence,
  DEFAULT_EVIDENCE_BUDGET,
  EVIDENCE_ASSEMBLY_POLICY_VERSION,
  toEvidenceOmission,
  type EvidenceBudget,
  type EvidenceChunk,
  type EvidenceOmission,
} from "../domain/evidence-assembly.js";
import { QUERY_SCORING_POLICY_VERSION, scoreCardsAgainstQuery } from "../domain/query-scoring.js";
import {
  judgeCandidates,
  SELECTION_RANKING_POLICY_VERSION,
  type SelectionResult,
  type SelectionThresholds,
} from "../domain/selection-verdict.js";
import { EmptyQueryError } from "./errors.js";
import type { ApprovedCardCatalog } from "../ports/approved-card-catalog.js";
import {
  DocumentRetrievalFault,
  type ManagedDocumentRetriever,
} from "../ports/managed-document-retriever.js";

/**
 * How many chunks one managed document Scope may contribute before the evidence
 * budget is even consulted.
 *
 * It exists so that a Card pointing at a large index cannot flood assembly on
 * its own: the budget in `evidence-assembly.ts` caps the answer as a whole,
 * while this caps each Scope's share of the ranking that feeds it. The value is
 * deliberately above `DEFAULT_EVIDENCE_BUDGET.maxChunks / 2`, so two Scopes can
 * still fill the budget between them.
 */
const DEFAULT_CHUNK_LIMIT_PER_SCOPE = 8;

/**
 * Everything this use case reaches outside itself for. Both ports belong to
 * this domain; the daemon is the only place that decides what implements them.
 */
export interface ResolveContextPorts {
  readonly catalog: ApprovedCardCatalog;
  readonly retriever: ManagedDocumentRetriever;
}

export interface ResolveContextOptions {
  readonly thresholds?: SelectionThresholds;
  readonly budget?: EvidenceBudget;
  /**
   * Chunks requested per managed document Scope. Defaults to
   * `DEFAULT_CHUNK_LIMIT_PER_SCOPE`.
   *
   * Not validated here: the port already defines what a non-positive limit
   * means — no chunks — so a caller-supplied value is forwarded to the adapter
   * exactly as given rather than being re-judged against an invariant this
   * domain does not own.
   */
  readonly chunkLimitPerScope?: number;
}

/**
 * Selects the approved Cards a query may be answered from, and resolves every
 * Scope each admitted Card authorises into one item.
 *
 * The order of the steps is the contract. Judgement runs to completion before
 * any retrieval starts, so only admitted Cards ever reach the retriever: a
 * deferred or rejected Card must not cause a read against an index, because the
 * read itself is an access, not just a fact about the answer. Retrieval then
 * runs per Scope and a failing Scope is isolated rather than fatal — a
 * partially resolved answer with the gap recorded is worth more to a consumer
 * than no answer at all.
 *
 * `query` is echoed back exactly as received, before normalization, so a caller
 * can pair the result with the request it sent.
 */
export async function resolveContext(
  ports: ResolveContextPorts,
  queryText: string,
  options: ResolveContextOptions = {},
): Promise<ContextResolution> {
  // Checked before the catalog is touched: an empty query cannot select
  // anything, so reading the catalog would be an access with no possible use.
  if (queryText.trim() === "") {
    throw new EmptyQueryError();
  }

  const cards = await ports.catalog.listApprovedCards();
  const candidates = scoreCardsAgainstQuery(queryText, cards);
  // `undefined` rather than a local default: the threshold band is
  // `judgeCandidates`' own decision and must not be restated here, or the two
  // defaults would drift apart silently.
  const selection = judgeCandidates(candidates, options.thresholds);

  const admitted = collectAdmittedCards(selection, cards);
  const budget = options.budget ?? DEFAULT_EVIDENCE_BUDGET;
  const outcomes = await retrieveScopes(
    ports.retriever,
    queryText,
    admitted,
    options.chunkLimitPerScope ?? DEFAULT_CHUNK_LIMIT_PER_SCOPE,
  );

  return {
    query: queryText,
    policy: {
      payloadSchemaVersion: 2,
      scoring: QUERY_SCORING_POLICY_VERSION,
      ranking: SELECTION_RANKING_POLICY_VERSION,
      evidence: EVIDENCE_ASSEMBLY_POLICY_VERSION,
      // Copied field by field rather than aliased, for the reason
      // `buildRetrievalGuide` copies `columns` and `semanticUnitIds`: a value
      // handed to a consumer must not be a live window onto someone else's
      // object — here either the caller's own options or, when none were given,
      // the shared `DEFAULT_EVIDENCE_BUDGET` constant. Named fields rather than
      // a spread, so a field added to `EvidenceBudget` has to be considered
      // here instead of being carried across unnoticed.
      budget: {
        maxTotalCharacters: budget.maxTotalCharacters,
        maxChunks: budget.maxChunks,
      },
    },
    items: buildItems(admitted, outcomes, budget),
    candidates,
    selection,
  };
}

/**
 * The admitted Cards, in the order the ranking put them.
 *
 * Walking the outcomes rather than the catalog keeps one ordering across the
 * whole result: the Scope traversal below, and therefore the retriever call
 * sequence, follows the same ranked order the audit trail records.
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
    // resolution over.
    if (card !== undefined) {
      admitted.push(card);
    }
  }

  return admitted;
}

/** One managed document Scope of one admitted Card, ready to be searched. */
interface ScopeSearch {
  readonly card: ApprovedCard;
  readonly scope: ApprovedManagedDocumentScope;
}

/**
 * What one managed document Scope's read produced.
 *
 * A read that returned nothing is `retrieved` with an empty list, not `faulted`.
 * The index answered; it had nothing to say. Only a raised fault is a fault.
 */
type ScopeOutcome =
  | {
      readonly kind: "retrieved";
      readonly key: string;
      readonly chunks: readonly EvidenceChunk[];
    }
  | {
      readonly kind: "faulted";
      readonly key: string;
      readonly code: ResolutionFaultCode;
    };

/**
 * Identifies one Scope of one Card Version.
 *
 * A Scope appears at most once inside a Card Version, so the pair is unique
 * across the whole resolution and can carry a chunk back to the item it belongs
 * to. `\u0000` separates the halves because no identifier may contain it, so no
 * pair of distinct coordinates can collide into one key.
 */
function scopeKey(versionId: string, scopeRef: ApprovedScopeReference): string {
  return `${versionId}\u0000${scopeRef.scopeId}`;
}

/**
 * Searches every managed document Scope of every admitted Card, concurrently.
 *
 * Concurrency does not cost determinism: `Promise.all` resolves in call order,
 * and the call order is fixed by the ranked Card order and each Card's own
 * Scope order. Non-document Scopes are never read here — ADR 0002 gives us the
 * index we published, ADR 0001 gives the consumer everything else — and become
 * delegated items instead.
 */
async function retrieveScopes(
  retriever: ManagedDocumentRetriever,
  queryText: string,
  admitted: readonly ApprovedCard[],
  limit: number,
): Promise<ReadonlyMap<string, ScopeOutcome>> {
  const searches: ScopeSearch[] = [];
  for (const card of admitted) {
    for (const scope of card.scopes) {
      if (scope.kind === "managed_document") {
        searches.push({ card, scope });
      }
    }
  }

  const outcomes = await Promise.all(
    searches.map((search) => runScopeSearch(retriever, queryText, search, limit)),
  );

  return new Map(outcomes.map((outcome) => [outcome.key, outcome]));
}

/**
 * Runs one Scope's search and reduces any failure to a reportable code.
 *
 * The catch is deliberately total. An adapter is expected to raise
 * `DocumentRetrievalFault`, but a transport library throwing its own error is
 * an ordinary occurrence, and letting it escape would abort the entire
 * resolution over one unreachable index.
 */
async function runScopeSearch(
  retriever: ManagedDocumentRetriever,
  queryText: string,
  { card, scope }: ScopeSearch,
  limit: number,
): Promise<ScopeOutcome> {
  const key = scopeKey(card.versionId, scope.reference);

  try {
    const retrieved = await retriever.searchChunks({
      queryText,
      documentIndex: scope.documentIndex,
      selection: scope.selection,
      limit,
    });

    return {
      kind: "retrieved",
      key,
      // The Scope coordinates are stamped on here because the retriever answers
      // per document index and cannot know which Card selected it. Assembly and
      // the split back into items both depend on them.
      chunks: retrieved.map((chunk) => ({
        ...chunk,
        cardId: card.cardId,
        versionId: card.versionId,
        scopeRef: scope.reference,
      })),
    };
  } catch (cause: unknown) {
    return {
      kind: "faulted",
      key,
      code:
        cause instanceof DocumentRetrievalFault ? cause.code : "retriever_error",
    };
  }
}

/**
 * Assembles every retrieved chunk once, then splits the result back into items.
 *
 * Assembly runs over all admitted Scopes at once rather than per Scope with a
 * divided budget, and the difference is not a tuning choice:
 *
 * 1. Whatever a query returned before this type existed, it returns now. No new
 *    policy surface appears that would have to be tuned before the first demo.
 * 2. Deduplication keeps working across Scopes. Two Scopes that produce the
 *    same `contentDigest` are caught here; assembling each Scope separately
 *    would either miss the repeat entirely or catch it in whichever Scope
 *    happened to be processed second, making the answer depend on Scope order.
 * 3. There is no allocation cliff. Splitting `maxChunks: 12` evenly across
 *    thirteen Scopes gives every Scope nothing.
 * 4. "The response does not grow with the number of Scopes" holds structurally
 *    rather than by arithmetic — there is one ceiling, and it is the ceiling.
 *
 * The cost, stated plainly: a high-scoring Scope can spend the budget a
 * lower-scoring one would have used, and that Scope's item then reports
 * `truncated` with no chunks. That is the ranking doing its job, and the item
 * says so rather than disappearing.
 */
function buildItems(
  admitted: readonly ApprovedCard[],
  outcomes: ReadonlyMap<string, ScopeOutcome>,
  budget: EvidenceBudget,
): readonly ResolutionItem[] {
  const retrieved: EvidenceChunk[] = [];
  for (const outcome of outcomes.values()) {
    if (outcome.kind === "retrieved") {
      retrieved.push(...outcome.chunks);
    }
  }

  const evidence = assembleDocumentEvidence(retrieved, budget);
  const chunksByScope = groupBy(evidence.chunks, (chunk) =>
    scopeKey(chunk.versionId, chunk.scopeRef),
  );
  const omissionsByScope = groupBy(
    evidence.omitted.map((omitted) => ({
      key: scopeKey(omitted.chunk.versionId, omitted.chunk.scopeRef),
      omission: toEvidenceOmission(omitted),
    })),
    (entry) => entry.key,
  );

  const items: ResolutionItem[] = [];
  for (const card of admitted) {
    for (const scope of card.scopes) {
      items.push(
        buildItem(card, scope, outcomes, chunksByScope, omissionsByScope),
      );
    }
  }

  return items.sort(compareItems);
}

function buildItem(
  card: ApprovedCard,
  scope: ApprovedScope,
  outcomes: ReadonlyMap<string, ScopeOutcome>,
  chunksByScope: ReadonlyMap<string, readonly EvidenceChunk[]>,
  omissionsByScope: ReadonlyMap<
    string,
    readonly { readonly omission: EvidenceOmission }[]
  >,
): ResolutionItem {
  const guide = buildRetrievalGuide(scope);

  if (guide.kind !== "managed_document") {
    return {
      fulfillment: "delegated",
      cardId: card.cardId,
      versionId: card.versionId,
      guide,
    };
  }

  const key = scopeKey(card.versionId, guide.scopeRef);
  const outcome = outcomes.get(key);

  if (outcome?.kind === "faulted") {
    return {
      fulfillment: "failed",
      cardId: card.cardId,
      versionId: card.versionId,
      guide,
      code: outcome.code,
    };
  }

  // A Scope with no outcome at all is unreachable: `retrieveScopes` walks the
  // same admitted Cards and the same Scopes this loop does. It resolves to an
  // empty context rather than throwing, because a missing entry would mean our
  // own bookkeeping slipped, and dropping the whole answer over it would be a
  // worse outcome than an item that honestly reports nothing.
  return {
    fulfillment: "fulfilled",
    cardId: card.cardId,
    versionId: card.versionId,
    guide,
    context: contextFor(
      chunksByScope.get(key) ?? [],
      (omissionsByScope.get(key) ?? []).map((entry) => entry.omission),
    ),
  };
}

/**
 * `truncated` is derived from this Scope's own omissions, not from the response
 * as a whole: an item that kept everything it retrieved must not be marked
 * clipped because a different Scope ran out of budget.
 */
function contextFor(
  chunks: readonly EvidenceChunk[],
  omitted: readonly EvidenceOmission[],
): RetrievedDocumentContext {
  return {
    chunks,
    omitted,
    truncated: omitted.some(
      (omission) => omission.reason === "budget_exhausted",
    ),
  };
}

function groupBy<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
): ReadonlyMap<string, readonly T[]> {
  const grouped = new Map<string, T[]>();

  for (const value of values) {
    const key = keyOf(value);
    const bucket = grouped.get(key);
    if (bucket === undefined) {
      grouped.set(key, [value]);
    } else {
      bucket.push(value);
    }
  }

  return grouped;
}

/**
 * versionId ascending, then scopeId ascending.
 *
 * Items are built in ranked order, which depends on the query's scores, so two
 * runs over the same catalog can list the same Scopes in a different sequence.
 * Ordering them by identity instead makes two responses directly comparable.
 * `<` / `>` rather than `localeCompare`, matching every other ordering in this
 * domain: `localeCompare` resolves against the runtime locale, and the same
 * resolution has to serialize identically on every machine.
 */
function compareItems(left: ResolutionItem, right: ResolutionItem): number {
  if (left.versionId !== right.versionId) {
    return left.versionId < right.versionId ? -1 : 1;
  }
  const leftScope = left.guide.scopeRef.scopeId;
  const rightScope = right.guide.scopeRef.scopeId;
  if (leftScope !== rightScope) {
    return leftScope < rightScope ? -1 : 1;
  }
  return 0;
}
