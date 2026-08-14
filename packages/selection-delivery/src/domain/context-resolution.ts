import type {
  ApprovedDocumentSelection,
  ApprovedScope,
  ApprovedScopeReference,
} from "./card-catalog.js";
import { SelectionScopeInvariantError } from "./errors.js";
import type {
  EvidenceBudget,
  EvidenceChunk,
  EvidenceOmission,
} from "./evidence-assembly.js";
import type { CandidateScore } from "./query-scoring.js";
import type { SelectionResult } from "./selection-verdict.js";
import type { DocumentRetrievalFaultCode } from "../ports/managed-document-retriever.js";

/**
 * What one query resolved to: every selected Scope as one item, whatever kind of
 * source it points at.
 *
 * This is the serialized shape a consumer receives. The three Scope kinds used
 * to leave this domain through separate channels — managed documents as a single
 * merged evidence record, SQL and HTTP as a contract list, failures as a third
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
  readonly items: readonly ResolutionItem[];
  /**
   * Every Card that was considered, in catalog order, with the signals that
   * produced each score.
   *
   * Present alongside `selection` because the two answer different questions —
   * "what was looked at" and "what was decided" — and a consumer that receives
   * only the second cannot tell a narrow catalog from a strict threshold. ADR
   * 0006 deferred moving both here; this is where they land.
   */
  readonly candidates: readonly CandidateScore[];
  /**
   * The ranked verdicts and the provenance of the ranking.
   *
   * `selection.provenance.policyVersion` repeats `policy.ranking`. The
   * duplication is intended: `policy` is the summary block a consumer reads to
   * decide whether two responses are comparable, while `provenance` is the
   * record of the run that produced these outcomes, and a consumer reading
   * either one alone must not have to look elsewhere.
   */
  readonly selection: SelectionResult;
}

/**
 * Everything a consumer needs to decide whether two responses are comparable.
 *
 * The four versions sit in one block rather than beside the data they describe
 * for three reasons. Evidence now hangs off each item, so a per-record
 * `policyVersion` would repeat one identical string once per item. A consumer
 * asking "may I compare this answer with yesterday's?" needs all four at once,
 * and today they are scattered across the root, two levels down inside
 * `selection.provenance`, and the evidence record. And `payloadSchemaVersion`
 * only describes itself when it sits with the policies it travels with.
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
   * `DeliveryResult`; `2` is this one. A literal type, not `number`: a consumer
   * narrowing on it gets an exhaustiveness error when the shape moves again,
   * rather than a value it silently fails to recognise.
   */
  readonly payloadSchemaVersion: 2;
  /** `QUERY_SCORING_POLICY_VERSION`. */
  readonly scoring: string;
  /** `SELECTION_RANKING_POLICY_VERSION`. */
  readonly ranking: string;
  /** `EVIDENCE_ASSEMBLY_POLICY_VERSION`. */
  readonly evidence: string;
  /** The ceiling every fulfilled item's context was assembled under, together. */
  readonly budget: EvidenceBudget;
}

/**
 * One selected Scope, and what became of it.
 *
 * `fulfillment` is a state, not a pair of booleans, and each state carries
 * exactly the payload that state can have. Four things are unrepresentable as a
 * result, all at compile time rather than by review:
 *
 * 1. `fulfilled` without retrieved context — `context` is required on it.
 * 2. `delegated` carrying a failure code — `code` exists on no other member.
 * 3. a SQL or HTTP Scope reported as `failed` — `failed` only guides documents.
 * 4. a managed document reported as `delegated` — `delegated` never guides one.
 *
 * (2) and (4) are the same fact from two sides, and it is the one worth stating:
 * we have not run the consumer's database or endpoint, so we are in no position
 * to say whether it would have succeeded. `delegated` means the work moved, not
 * that it went well.
 *
 * A `fulfilled` item with no chunks is a real and different outcome from a
 * `failed` one, and both occur: the index answered and had nothing to say, or
 * everything it said lost the budget to a higher-ranked Scope. Neither is a
 * failure, and reporting them as one would tell a consumer the source is broken
 * when it is merely quiet. `failed` means the read did not happen or cannot be
 * trusted, and nothing else.
 */
export type ResolutionItem =
  | {
      readonly fulfillment: "fulfilled";
      readonly cardId: string;
      readonly versionId: string;
      readonly guide: ManagedDocumentGuide;
      readonly context: RetrievedDocumentContext;
    }
  | {
      readonly fulfillment: "delegated";
      readonly cardId: string;
      readonly versionId: string;
      readonly guide: SqlRetrievalGuide | HttpRetrievalGuide;
    }
  | {
      readonly fulfillment: "failed";
      readonly cardId: string;
      readonly versionId: string;
      readonly guide: ManagedDocumentGuide;
      readonly code: ResolutionFaultCode;
    };

/**
 * Why one managed document Scope could not be read.
 *
 * The three declared codes are the retriever port's own vocabulary: this domain
 * does not invent a reason an adapter cannot state. `retriever_error` is the
 * fourth case and not a reason at all — it says the adapter threw something
 * outside its declared vocabulary, a transport library's own error, and that we
 * therefore do not know why. Collapsing it into one of the three would claim a
 * diagnosis nobody made, and dropping it would leave the total `catch` in
 * `resolveContext` with nothing to report.
 *
 * The exception itself never travels with the code. A fault message is written
 * for an operator reading logs, and forwarding it would put adapter-internal
 * detail — a host, a path, a store's own wording — in front of a consumer.
 */
export type ResolutionFaultCode =
  | DocumentRetrievalFaultCode
  | "retriever_error";

/**
 * What a Scope authorises, in the words a consumer may read.
 *
 * `RetrievalGuide` renames what used to be `RetrievalContract` and widens it to
 * cover managed documents. "Contract" claimed too much once documents joined:
 * for a document we do the retrieval ourselves and the record is a citation of
 * where the evidence came from, not an instruction to execute. "Guide" is true
 * of all three.
 *
 * Every field is transcribed from an already approved Scope, so a guide can
 * never widen what was approved.
 */
export type RetrievalGuide =
  | ManagedDocumentGuide
  | SqlRetrievalGuide
  | HttpRetrievalGuide;

/**
 * Where a document's evidence came from, in citable terms.
 *
 * Deliberately not `ApprovedDocumentIndexRef`: `connectorId` and `accessHandle`
 * are our own infrastructure coordinates — which store, which handle inside it —
 * and a consumer neither needs them to read a citation nor may act on them. They
 * live on `ManagedDocumentFulfillmentTarget`, which nothing on
 * `ContextResolution` can reach.
 *
 * `documentIndexId`, `sourceId` and `indexVersion` do stay: they are what makes
 * a citation checkable against the registry, which is the same standard ADR 0001
 * holds SQL and HTTP coordinates to.
 */
export interface ManagedDocumentGuide {
  readonly kind: "managed_document";
  readonly scopeRef: ApprovedScopeReference;
  readonly sourceId: string;
  readonly documentId: string;
  readonly documentIndexId: string;
  readonly indexVersion: string;
  readonly selection: ApprovedDocumentSelection;
}

/**
 * A verifiable coordinate into a consumer's table.
 *
 * `connector` names the consumer's own datasource — `postgres.main` — and is not
 * our infrastructure the way `connectorId` on a document index is. A consumer
 * cannot run the query without it, so it stays.
 *
 * `allowedOperations` is the "허용 연산" ADR 0001 requires to be stated rather
 * than assumed. A fixed `["select"]` tuple, not a configurable list.
 */
export interface SqlRetrievalGuide {
  readonly kind: "sql";
  readonly scopeRef: ApprovedScopeReference;
  readonly connector: string;
  readonly table: string;
  readonly columns: readonly string[];
  readonly allowedOperations: readonly ["select"];
}

/** A verifiable coordinate into a consumer's HTTP endpoint. Never called here. */
export interface HttpRetrievalGuide {
  readonly kind: "http";
  readonly scopeRef: ApprovedScopeReference;
  readonly connector: string;
  readonly method: string;
  readonly path: string;
}

/**
 * The evidence one managed document Scope contributed, and what it cost.
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
 * every chunk carries the Scope it came from, so every omission belongs to
 * exactly one item, and a consumer wanting the response-wide answer takes the
 * OR across items rather than reading a second field that could contradict them.
 *
 * They travel with the chunks rather than in a side channel because a consumer
 * that sees only the surviving chunks cannot tell an exhaustive answer from a
 * clipped one, and that difference changes how the answer may be used.
 */
export interface RetrievedDocumentContext {
  readonly chunks: readonly EvidenceChunk[];
  readonly omitted: readonly EvidenceOmission[];
  readonly truncated: boolean;
}

/**
 * Transcribes one approved Scope into the guide it authorises.
 *
 * Total over `ApprovedScope`: every kind produces a guide, and there is no
 * branch that returns nothing. That is the point of this function, and the
 * reason it replaced `buildRetrievalContracts`: that one answered `undefined`
 * for a managed document and let the Scope fall out of the result without a
 * trace — and a selected Scope that vanishes between selection and delivery
 * cannot be told apart, downstream, from one that was never selected at all.
 *
 * A guide is all this returns. The physical binding a managed document needs in
 * order to actually be read comes from `buildFulfillmentTarget` instead, so no
 * caller can obtain the two together by accident.
 */
export function buildRetrievalGuide(scope: ApprovedScope): RetrievalGuide {
  switch (scope.kind) {
    case "managed_document":
      return {
        kind: "managed_document",
        scopeRef: scope.reference,
        sourceId: scope.documentIndex.sourceId,
        documentId: scope.documentIndex.documentId,
        documentIndexId: scope.documentIndex.documentIndexId,
        indexVersion: scope.documentIndex.indexVersion,
        selection: copySelection(scope.selection),
      };
    case "sql_source":
      return {
        kind: "sql",
        scopeRef: scope.reference,
        connector: scope.connector,
        table: scope.table,
        // Copied rather than aliased: the guide is handed to a consumer, and it
        // must not be a live window onto the catalog's own array.
        columns: [...scope.columns],
        allowedOperations: ["select"],
      };
    case "http_source":
      return {
        kind: "http",
        scopeRef: scope.reference,
        connector: scope.connector,
        method: scope.method,
        path: scope.path,
      };
    default:
      return refuseUnknownScope(scope);
  }
}

/** Copied for the same reason `columns` is: a guide never aliases catalog state. */
function copySelection(
  selection: ApprovedDocumentSelection,
): ApprovedDocumentSelection {
  if (selection.kind === "semantic_units") {
    return {
      kind: "semantic_units",
      semanticUnitIds: [...selection.semanticUnitIds],
    };
  }
  return { kind: "document" };
}

/**
 * Unreachable for any `ApprovedScope`, which is what the `never` binding
 * asserts: adding a fourth Scope kind breaks the build here instead of silently
 * dropping that kind from every resolution. At runtime it is reachable only
 * through an adapter that produced data outside the declared union, and that is
 * a corrupted read model, not an unsupported feature.
 */
function refuseUnknownScope(scope: never): never {
  const { kind } = scope as { readonly kind: unknown };

  throw new SelectionScopeInvariantError(
    `scope kind ${String(kind)} cannot be resolved into a retrieval guide`,
  );
}
