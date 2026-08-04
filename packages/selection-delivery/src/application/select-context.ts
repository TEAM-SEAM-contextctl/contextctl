import type {
  ApprovedCard,
  ApprovedManagedDocumentScope,
  ApprovedScopeReference,
} from "../domain/card-catalog.js";
import {
  assembleDocumentEvidence,
  type EvidenceBudget,
  type EvidenceChunk,
  type ManagedDocumentEvidence,
} from "../domain/evidence-assembly.js";
import {
  QUERY_SCORING_POLICY_VERSION,
  scoreCardsAgainstQuery,
  type CandidateScore,
} from "../domain/query-scoring.js";
import {
  buildRetrievalContracts,
  type RetrievalContract,
} from "../domain/retrieval-contract.js";
import {
  judgeCandidates,
  type SelectionResult,
  type SelectionThresholds,
} from "../domain/selection-verdict.js";
import { EmptyQueryError } from "./errors.js";
import type { ApprovedCardCatalog } from "../ports/approved-card-catalog.js";
import {
  DocumentRetrievalFault,
  type DocumentRetrievalFaultCode,
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
export interface SelectContextPorts {
  readonly catalog: ApprovedCardCatalog;
  readonly retriever: ManagedDocumentRetriever;
}

export interface SelectContextOptions {
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
 * One Scope whose retrieval could not be attempted or trusted.
 *
 * The adapter's exception never travels with it. A fault message is written for
 * an operator reading logs, and forwarding it into a delivery result would put
 * adapter-internal detail — a host, a path, a store's own wording — in front of
 * a consumer. Only the port's own failure vocabulary crosses, which is also
 * what ingestion-indexing does with `SourceAdapterFault`.
 */
export interface ScopeRetrievalFailure {
  readonly cardId: string;
  readonly versionId: string;
  readonly scopeRef: ApprovedScopeReference;
  readonly code: DocumentRetrievalFaultCode | "retriever_error";
}

/**
 * What one query produced: the judgement, its evidence, and its audit trail.
 *
 * `candidates` carries every Card that was considered, in catalog order and
 * with the signals that produced each score, while `selection` carries the
 * ranked verdicts. Both are present because they answer different questions —
 * "what was looked at" and "what was decided" — and a consumer that only
 * receives the second cannot tell a narrow catalog from a strict threshold.
 */
export interface DeliveryResult {
  readonly query: string;
  readonly scoringPolicyVersion: string;
  readonly candidates: readonly CandidateScore[];
  readonly selection: SelectionResult;
  readonly evidence: ManagedDocumentEvidence;
  readonly contracts: readonly RetrievalContract[];
  readonly retrievalFailures: readonly ScopeRetrievalFailure[];
}

/**
 * Selects the approved Cards a query may be answered from, and delivers what
 * each admitted Card authorises.
 *
 * The order of the steps is the contract. Judgement runs to completion before
 * any retrieval starts, so only admitted Cards ever reach the retriever: a
 * deferred or rejected Card must not cause a read against an index, because the
 * read itself is an access, not just a fact about the answer. Retrieval then
 * runs per Scope and a failing Scope is isolated rather than fatal — a
 * partially retrievable answer with the gap recorded is worth more to a
 * consumer than no answer at all.
 *
 * `query` is echoed back exactly as received, before normalization, so a caller
 * can pair the result with the request it sent.
 */
export async function selectContext(
  ports: SelectContextPorts,
  queryText: string,
  options: SelectContextOptions = {},
): Promise<DeliveryResult> {
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
  const { chunks, failures } = await retrieveEvidenceChunks(
    ports.retriever,
    queryText,
    admitted,
    options.chunkLimitPerScope ?? DEFAULT_CHUNK_LIMIT_PER_SCOPE,
  );

  return {
    query: queryText,
    scoringPolicyVersion: QUERY_SCORING_POLICY_VERSION,
    candidates,
    selection,
    evidence: assembleDocumentEvidence(chunks, options.budget),
    contracts: buildRetrievalContracts(admitted),
    retrievalFailures: failures,
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
    // delivery over.
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

type ScopeSearchResult =
  | { readonly kind: "retrieved"; readonly chunks: readonly EvidenceChunk[] }
  | { readonly kind: "failed"; readonly failure: ScopeRetrievalFailure };

/**
 * Searches every managed document Scope of every admitted Card, concurrently.
 *
 * Concurrency does not cost determinism: `Promise.all` resolves in call order,
 * and the call order is fixed by the ranked Card order and each Card's own
 * Scope order. Non-document Scopes are skipped here and answered by
 * `buildRetrievalContracts` instead — ADR 0002 gives us the index we published,
 * ADR 0001 gives the consumer everything else.
 */
async function retrieveEvidenceChunks(
  retriever: ManagedDocumentRetriever,
  queryText: string,
  admitted: readonly ApprovedCard[],
  limit: number,
): Promise<{
  readonly chunks: readonly EvidenceChunk[];
  readonly failures: readonly ScopeRetrievalFailure[];
}> {
  const searches: ScopeSearch[] = [];
  for (const card of admitted) {
    for (const scope of card.scopes) {
      if (scope.kind === "managed_document") {
        searches.push({ card, scope });
      }
    }
  }

  const results = await Promise.all(
    searches.map((search) => runScopeSearch(retriever, queryText, search, limit)),
  );

  const chunks: EvidenceChunk[] = [];
  const failed: ScopeSearchResult[] = [];
  for (const result of results) {
    if (result.kind === "retrieved") {
      chunks.push(...result.chunks);
    } else {
      failed.push(result);
    }
  }

  return { chunks, failures: orderFailures(failed) };
}

/**
 * Runs one Scope's search and reduces any failure to the port's vocabulary.
 *
 * The catch is deliberately total. An adapter is expected to raise
 * `DocumentRetrievalFault`, but a transport library throwing its own error is
 * an ordinary occurrence, and letting it escape would abort the entire delivery
 * over one unreachable index.
 */
async function runScopeSearch(
  retriever: ManagedDocumentRetriever,
  queryText: string,
  { card, scope }: ScopeSearch,
  limit: number,
): Promise<ScopeSearchResult> {
  try {
    const retrieved = await retriever.searchChunks({
      queryText,
      documentIndex: scope.documentIndex,
      selection: scope.selection,
      limit,
    });

    return {
      kind: "retrieved",
      // The Scope coordinates are stamped on here because the retriever answers
      // per document index and cannot know which Card selected it.
      chunks: retrieved.map((chunk) => ({
        ...chunk,
        cardId: card.cardId,
        versionId: card.versionId,
        scopeRef: scope.reference,
      })),
    };
  } catch (cause: unknown) {
    return {
      kind: "failed",
      failure: {
        cardId: card.cardId,
        versionId: card.versionId,
        scopeRef: scope.reference,
        code:
          cause instanceof DocumentRetrievalFault ? cause.code : "retriever_error",
      },
    };
  }
}

/**
 * versionId ascending, then scopeId ascending.
 *
 * Failures arrive in ranked order, which depends on the query's scores, so two
 * runs over the same catalog can report the same gaps in a different sequence.
 * Ordering them by identity instead makes the failure list comparable across
 * queries. `<` / `>` rather than `localeCompare`, matching every other ordering
 * in this domain: `localeCompare` resolves against the runtime locale.
 */
function orderFailures(
  failed: readonly ScopeSearchResult[],
): readonly ScopeRetrievalFailure[] {
  const records = failed.flatMap((result) =>
    result.kind === "failed" ? [result.failure] : [],
  );

  records.sort((left, right) => {
    if (left.versionId !== right.versionId) {
      return left.versionId < right.versionId ? -1 : 1;
    }
    const leftScope = left.scopeRef.scopeId;
    const rightScope = right.scopeRef.scopeId;
    if (leftScope !== rightScope) {
      return leftScope < rightScope ? -1 : 1;
    }
    return 0;
  });

  return records;
}
