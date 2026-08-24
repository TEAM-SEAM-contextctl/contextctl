import type { ContextBudget, ContextOmission } from "./context-assembly.js";
import type {
  HttpRetrievalGuide,
  ManagedDocumentGuide,
  SqlRetrievalGuide,
} from "./retrieval-guide.js";
import type {
  ApprovedCardReference,
  SelectedByList,
} from "./selection-plan.js";

/**
 * What one query resolved to: every selected Scope as one item, whatever kind of
 * source it points at.
 *
 * This is the serialized shape a consumer receives. The three Scope kinds used
 * to leave this domain through separate channels — managed documents as a single
 * merged context record, SQL and HTTP as a contract list, failures as a third
 * list — and a consumer had to re-join them by `cardId`/`scopeRef` to answer the
 * only question it actually asks: "what did this query give me, and can I use
 * it?". One array answers that directly, and the join stops being the
 * consumer's problem.
 *
 * ADR 0006 records the decision. ADR 0001 still holds underneath it: nothing
 * here executes a consumer's source.
 */
export interface ContextResolution {
  /** Echoed back exactly as received, so a caller can pair result with request. */
  readonly query: string;
  readonly policy: ResolutionPolicy;
  readonly selection: SelectionSummary;
  readonly items: readonly ContextResolutionItem[];
}

/**
 * What the selection decided, reduced to what an agent may act on.
 *
 * The raw candidate scores and the per-Card verdicts used to travel at the root
 * as `candidates` and `selection`, and they are gone: a response that named
 * every Card it looked at, its score, and the finding that sank it published the
 * catalog's shape and the threshold band to anyone who asked a question. What
 * survives is the part a consumer can use — which Cards answered, and how many
 * were admitted, deferred and rejected.
 *
 * `counts.rejected` is an aggregate and stays. The identity of a rejected Card
 * does not: `selected` lists admitted Cards only, so no rejected Card is named
 * anywhere in a response.
 */
export interface SelectionSummary {
  /**
   * Which scoring family produced the ranking behind `selected`.
   *
   * Paired with `ResolutionPolicy.scoring` by invariant — `hybrid` requires
   * `selection-hybrid-v2`, `lexical_degraded` requires `selection-lexical-v2`,
   * and any other combination is refused before assembly. The field is explicit
   * rather than inferred from scores so a consumer can tell a full hybrid run
   * from an allowed lexical degradation without guessing.
   */
  readonly mode: "hybrid" | "lexical_degraded";
  /** The admitted Cards, in rank order. Deferred and rejected Cards are absent. */
  readonly selected: readonly ApprovedCardReference[];
  readonly counts: SelectionCounts;
}

/** How many Cards each verdict claimed. An aggregate; no Card is named here. */
export interface SelectionCounts {
  readonly admitted: number;
  readonly deferred: number;
  readonly rejected: number;
}

/**
 * Everything a consumer needs to decide whether two responses are comparable.
 *
 * The five policy versions sit in one block rather than beside the data they
 * describe for three reasons. Context now hangs off each item, so a per-record
 * `policyVersion` would repeat one identical string once per item. A consumer
 * asking "may I compare this answer with yesterday's?" needs all of them at
 * once, and they would otherwise be scattered across the root, the selection
 * summary and each item's context. And `payloadSchemaVersion` only describes
 * itself when it sits with the policies it travels with.
 *
 * `budget` joins them for the same reason, and for one more. It is a ceiling on
 * the response as a whole, so putting it on each item would repeat one identical
 * record per item exactly as `policyVersion` would — and worse, it would read as
 * "this item was allotted 8000 characters", which is false: every item spends
 * from the one ceiling. Two answers assembled under different budgets are not
 * comparable, which is precisely what this block exists to let a consumer judge.
 */
export interface ResolutionPolicy {
  /**
   * The serialized shape of this payload. `1` was the split-channel
   * `DeliveryResult`; `2` carried the raw candidate scores and the selection
   * audit trail at the root; `3` is this one. A literal type, not `number`: a
   * consumer narrowing on it gets an exhaustiveness error when the shape moves
   * again, rather than a value it silently fails to recognise.
   */
  readonly payloadSchemaVersion: 3;
  /**
   * `QUERY_SCORING_POLICY_VERSION`, and the other half of the invariant
   * `SelectionSummary.mode` states — see that field.
   */
  readonly scoring: "selection-hybrid-v2" | "selection-lexical-v2";
  /** `SELECTION_RANKING_POLICY_VERSION`. */
  readonly ranking: "selection-ranking-v2";
  /** `SELECTION_PLANNING_POLICY_VERSION`. */
  readonly planning: "selection-planning-v1";
  /** `CONTEXT_FUSION_POLICY_VERSION`. */
  readonly fusion: "rrf-v1";
  /** `CONTEXT_ASSEMBLY_POLICY_VERSION`. */
  readonly assembly: "context-assembly-v2";
  /** The ceiling every fulfilled item's context was assembled under, together. */
  readonly budget: ContextBudget;
}

/**
 * One selected Scope, and what became of it.
 *
 * `selectedBy` comes straight from the plan this was assembled from. One item is
 * one Scope under one bound, not one (Card, Scope) pair: several admitted Cards
 * can authorise the same read, and a consumer that received the same context
 * once per Card could not tell that apart from a document genuinely repeating
 * itself. `selectedBy` keeps the attribution the merge would otherwise lose, in
 * Card rank order.
 *
 * The plan's `itemKey` does not travel. It is the digest that merges two Cards
 * onto one read — our own bookkeeping — and a consumer correlates on
 * `guide.scopeRef`, which is the coordinate it was actually granted.
 *
 * `fulfillment` is a state, not a pair of booleans, and each state carries
 * exactly the payload that state can have. Four things are unrepresentable as a
 * result, all at compile time rather than by review:
 *
 * 1. `fulfilled` without retrieved context — `context` is required on it.
 * 2. `delegated` carrying a failure — `failure` exists on no other member.
 * 3. a SQL or HTTP Scope reported as `failed` — `failed` only guides documents.
 * 4. a managed document reported as `delegated` — `delegated` never guides one.
 *
 * (2) and (4) are the same fact from two sides, and it is the one worth stating:
 * we have not run the consumer's database or endpoint, so we are in no position
 * to say whether it would have succeeded. `delegated` means the work moved, not
 * that it went well. `executor` says the same thing in a field a consumer can
 * branch on without reading this comment: either `contextctl` performed the
 * read, or the consumer still has to.
 *
 * A `fulfilled` item with no chunks is a real and different outcome from a
 * `failed` one, and both occur: the index answered and had nothing to say, or
 * everything it said lost the budget to a higher-ranked Scope. Neither is a
 * failure, and reporting them as one would tell a consumer the source is broken
 * when it is merely quiet. `failed` means the read did not happen or cannot be
 * trusted, and nothing else.
 */
export type ContextResolutionItem =
  | {
      readonly selectedBy: SelectedByList;
      readonly guide: ManagedDocumentGuide;
      readonly fulfillment: ManagedFulfillment;
    }
  | {
      readonly selectedBy: SelectedByList;
      readonly guide: SqlRetrievalGuide | HttpRetrievalGuide;
      readonly fulfillment: DelegatedFulfillment;
    };

/**
 * Why a managed read produced no context, as a consumer receives it.
 *
 * Declared here rather than reusing `ManagedResolutionFailure` from
 * `managed-resolution.ts`, and the two are different things. That type is the
 * executor's report — two stages and an opaque code — and it is an *input* to
 * assembly. This type is assembly's *output*, and assembly can fail in a way no
 * executor reports: the read answered, and what it answered with does not hold
 * together (SOT §10 L1639, §11 L2453-2466). Letting the input DTO carry an
 * `assembly` stage would let an executor claim a failure it is in no position
 * to diagnose; declaring the third stage only on the output keeps it ours.
 *
 * `deadline` is pinned to one code and one flag by the SOT (L2370, L2463-2466):
 * a target the search-stage budget ran out on is always `deadline_exceeded` and
 * always worth retrying, so the type says so instead of every projection having
 * to. `managed_search` keeps an opaque code — the executor's vocabulary is the
 * executor's to version, see `assertOpaqueFailure`. `assembly` is the one code
 * this package owns.
 */
export type ManagedFulfillmentFailure =
  | {
      readonly stage: "managed_search";
      readonly code: string;
      readonly retriable: boolean;
    }
  | {
      readonly stage: "assembly";
      readonly code: "resolution_outcome_invalid";
      readonly retriable: false;
    }
  | {
      readonly stage: "deadline";
      readonly code: "deadline_exceeded";
      readonly retriable: true;
    };

/** What became of a read this process performed. */
export type ManagedFulfillment =
  | {
      readonly status: "fulfilled";
      readonly executor: "contextctl";
      readonly context: RetrievedDocumentContext;
    }
  | {
      readonly status: "failed";
      readonly executor: "contextctl";
      /**
       * Why the read did not happen, exactly as the executor stated it.
       *
       * The code is an opaque token this domain neither interprets nor
       * translates — see `assertOpaqueFailure`. Delivery once folded everything
       * it could not name into a `retriever_error` of its own, which told a
       * consumer "we do not know" for failures that had a perfectly good name
       * one layer down. The name travels now; the exception behind it never
       * does, because a fault message is written for an operator reading logs
       * and forwarding it would put adapter-internal detail — a host, a path, a
       * store's own wording — in front of a consumer.
       *
       * Never a `ResolveContextError`. That channel reports a query that could
       * not be planned or ran out of time as a whole; this one reports one
       * granted coordinate that could not be read — or whose answer could not
       * be trusted — while the rest of the answer stands.
       */
      readonly failure: ManagedFulfillmentFailure;
    };

/** One coordinate handed to the consumer. Nothing of ours executed it. */
export interface DelegatedFulfillment {
  readonly status: "delegated";
  readonly executor: "consumer";
}

/**
 * One chunk of retrieved document text, as a consumer receives it.
 *
 * Distinct from `ResolvedDocumentChunk`, which is what an executor hands back:
 * that one carries a per-target `rank`, and the fused `ContextChunk` inside
 * assembly carries a `score` on top of it. Neither reaches here. A per-target
 * position means nothing once several targets have been fused, and a fused score
 * is a number on a scale nobody outside this package can interpret — publishing
 * either would invite a consumer to re-sort an answer that was already ordered
 * for it.
 *
 * `contextRank` replaces both: a 1-based position that is unique and gap-free
 * across the whole response, so two chunks that landed in two different items
 * still have an order relative to one another.
 */
export interface RetrievedDocumentChunk {
  readonly contextRank: number;
  readonly chunkId: string;
  readonly chunkRevisionId: string;
  readonly semanticUnitId: string;
  readonly documentId: string;
  readonly text: string;
  readonly contentDigest: string;
}

/**
 * The context one managed document Scope contributed, and what it cost.
 *
 * `policyVersion` and `budget` both moved up to `ResolutionPolicy`: assembly
 * runs under one policy and one ceiling for the whole response, and repeating
 * either on every item would invite a payload where two items disagree about a
 * fact that cannot differ.
 *
 * `omitted` and `truncated` stay here rather than moving up with them, because
 * unlike the policy they really do differ per Scope: one Scope can lose every
 * chunk to a repeat while another loses none. `omitted` holds only this Scope's
 * losses and `truncated` says only whether this Scope lost something to the
 * budget. There is deliberately no response-wide `truncated` beside them —
 * every chunk carries the item it came from, so every omission belongs to
 * exactly one item, and a consumer wanting the response-wide answer takes the
 * OR across items rather than reading a second field that could contradict them.
 *
 * They travel with the chunks rather than in a side channel because a consumer
 * that sees only the surviving chunks cannot tell an exhaustive answer from a
 * clipped one, and that difference changes how the answer may be used.
 *
 * `contentTrust` is a constant, and the type says so. Retrieved document text is
 * data a document happened to contain, never instruction: a model reading this
 * field has been told once, in the payload itself, that nothing inside `chunks`
 * may be obeyed.
 */
export interface RetrievedDocumentContext {
  readonly contentTrust: "untrusted";
  readonly chunks: readonly RetrievedDocumentChunk[];
  readonly omitted: readonly ContextOmission[];
  readonly truncated: boolean;
}
