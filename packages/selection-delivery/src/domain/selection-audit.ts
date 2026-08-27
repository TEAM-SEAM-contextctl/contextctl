import { canonicalDigest } from "./canonical-digest.js";
import { scoringPolicyVersionFor } from "./hybrid-ranking.js";
import type { PlanCost } from "./minimum-set-plan-cost.js";
import type { CardPlanningDecisionReason } from "./minimum-sufficient-set.js";
import type { SourceIntent } from "./query-scoring.js";
import {
  SELECTION_PLANNING_POLICY_VERSION,
  verifySelectionPlan,
  type SelectionPlan,
} from "./selection-plan.js";
import { utf8ByteLength } from "./transport-policy.js";

export const SELECTION_AUDIT_SCHEMA_VERSION = 1 as const;
export const SELECTION_AUDIT_DETAIL_LIMIT = 128;
export const SELECTION_AUDIT_RETENTION_POLICY = Object.freeze({
  version: "selection-audit-retention-v1",
  maximumAgeMs: 30 * 24 * 60 * 60 * 1_000,
  maximumRecords: 10_000,
  maximumBytes: 256 * 1024 * 1024,
  maximumRecordBytes: 2 * 1024 * 1024,
} as const);

export interface SelectionAuditSignal {
  readonly field:
    | "keyword"
    | "alias"
    | "representative_question"
    | "description"
    | "bm25"
    | "scope";
  readonly contribution: number;
}

export interface SelectionAuditCandidate {
  readonly cardId: string;
  readonly versionId: string;
  readonly score: number;
  /** Signal kind and weight only. The matched query/Card text is never stored. */
  readonly signals: readonly SelectionAuditSignal[];
}

export interface SelectionAuditDecision {
  readonly cardId: string;
  readonly versionId: string;
  readonly score: number;
  readonly verdict: "admit" | "defer" | "reject";
  /** Stable rule identifiers only. Human messages may contain future detail. */
  readonly findingRules: readonly SelectionAuditFindingRule[];
}

export type SelectionAuditFindingRule =
  | "plan.covered_by_selected_set"
  | "score.not.finite"
  | "score.at.or.below.reject"
  | "score.below.admit";

export interface SelectionAuditPolicyExclusion {
  readonly cardId: string;
  readonly versionId: string;
  readonly reason: "usage_not_allowed" | "sensitive_denied";
}

export interface SelectionAuditFacet {
  /** Per-record ordinal. It cannot be reversed into the query text. */
  readonly facetRef: string;
  readonly explicitSourceKinds: readonly SourceIntent[];
  readonly extraction: "whole_query" | "explicit_boundary";
}

export interface SelectionAuditCoverage {
  readonly facetRef: string;
  readonly bestLexicalScore: number;
  readonly supportedSourceKinds: readonly SourceIntent[];
}

export interface SelectionAuditPlanningDecision {
  readonly cardId: string;
  readonly versionId: string;
  readonly decision: "selected" | "not_planned" | "protected";
  readonly reason: CardPlanningDecisionReason;
  readonly coveredFacetRefs: readonly string[];
  readonly replacementCardVersionIds: readonly string[];
}

export interface SelectionAuditRecord {
  readonly schemaVersion: typeof SELECTION_AUDIT_SCHEMA_VERSION;
  readonly auditId: string;
  readonly recordedAt: string;
  readonly queryUtf8Bytes: number;
  readonly mode: "hybrid" | "lexical_degraded";
  readonly policies: {
    readonly scoring: string;
    readonly ranking: string;
    readonly planning: string;
    readonly setPlanning: string;
    readonly queryFacet: string;
  };
  readonly thresholds: { readonly admit: number; readonly reject: number };
  readonly catalog: {
    readonly evaluatedCount: number;
    readonly detailedCount: number;
    readonly omittedCount: number;
    readonly policyExcludedCount: number;
    readonly policyExclusionDetailedCount: number;
    readonly policyExclusionOmittedCount: number;
    readonly candidateSetDigest: string;
  };
  readonly verdictCounts: {
    readonly admit: number;
    readonly defer: number;
    readonly reject: number;
  };
  readonly candidates: readonly SelectionAuditCandidate[];
  readonly decisions: readonly SelectionAuditDecision[];
  readonly policyExclusions: readonly SelectionAuditPolicyExclusion[];
  readonly planning: {
    readonly ambiguous: boolean;
    readonly facets: readonly SelectionAuditFacet[];
    readonly decisions: readonly SelectionAuditPlanningDecision[];
    readonly baselineCoverage: readonly SelectionAuditCoverage[];
    readonly selectedCoverage: readonly SelectionAuditCoverage[];
    readonly costBefore: PlanCost;
    readonly costAfter: PlanCost;
    readonly removalCount: number;
  };
  /** Integrity over every field above; not a digest of the query. */
  readonly recordDigest: string;
}

/**
 * Projects a private SelectionPlan into the bounded operator audit contract.
 * Raw query text, normalized facets, tokens, matched values and finding
 * messages deliberately have no field in this type.
 */
export function createSelectionAuditRecord(input: {
  readonly plan: SelectionPlan;
  readonly auditId: string;
  readonly recordedAt: string;
}): SelectionAuditRecord {
  verifySelectionPlan(input.plan, { query: input.plan.query });
  assertAuditIdentity(input.auditId, input.recordedAt);
  const summary = input.plan.summary;
  const facetReferences = new Map(
    summary.planning.facets.map((facet, index) => [
      facet.facetId,
      `facet_${String(index + 1)}`,
    ]),
  );
  const facetRef = (facetId: string): string => {
    const reference = facetReferences.get(facetId);
    if (reference === undefined) {
      throw new TypeError(
        `selection audit references an unknown facet: ${facetId}`,
      );
    }
    return reference;
  };
  const candidateByVersion = new Map(
    summary.candidates.map((candidate) => [candidate.versionId, candidate]),
  );
  const detailedVersionIds = selectDetailedVersionIds(input.plan);
  const candidates = summary.selection.outcomes
    .filter((outcome) => detailedVersionIds.has(outcome.versionId))
    .map((outcome) => candidateByVersion.get(outcome.versionId))
    .filter((candidate) => candidate !== undefined)
    .map((candidate) => ({
      cardId: candidate.cardId,
      versionId: candidate.versionId,
      score: candidate.score,
      signals: candidate.signals.map((signal) => ({
        field: signal.field,
        contribution: signal.contribution,
      })),
    }));
  const policyExclusions = summary.policy.excluded
    .slice(0, SELECTION_AUDIT_DETAIL_LIMIT)
    .map((excluded) => ({
      cardId: excluded.cardId,
      versionId: excluded.versionId,
      reason: excluded.reason,
    }));
  const decisions = summary.selection.outcomes
    .filter((outcome) => detailedVersionIds.has(outcome.versionId))
    .map((outcome) => ({
      cardId: outcome.cardId,
      versionId: outcome.versionId,
      score: outcome.score,
      verdict: outcome.verdict,
      findingRules:
        outcome.verdict === "admit"
          ? []
          : outcome.findings.map((finding) =>
              assertSelectionAuditFindingRule(finding.rule),
            ),
    }));
  const verdictCounts = { admit: 0, defer: 0, reject: 0 };
  for (const outcome of summary.selection.outcomes) {
    verdictCounts[outcome.verdict] += 1;
  }
  const coverage = (
    entries: typeof summary.planning.baselineCoverage,
  ): readonly SelectionAuditCoverage[] =>
    entries.map((entry) => ({
      facetRef: facetRef(entry.facetId),
      bestLexicalScore: entry.bestLexicalScore,
      supportedSourceKinds: entry.supportedSourceKinds,
    }));
  const body = {
    schemaVersion: SELECTION_AUDIT_SCHEMA_VERSION,
    auditId: input.auditId,
    recordedAt: input.recordedAt,
    queryUtf8Bytes: utf8ByteLength(input.plan.query),
    mode: summary.mode,
    policies: {
      scoring: scoringPolicyVersionFor(summary.mode),
      ranking: summary.selection.provenance.policyVersion,
      planning: SELECTION_PLANNING_POLICY_VERSION,
      setPlanning: summary.planning.policyVersion,
      queryFacet: summary.planning.queryFacetPolicyVersion,
    },
    thresholds: summary.selection.provenance.thresholds,
    catalog: {
      evaluatedCount: summary.selection.provenance.consideredCount,
      detailedCount: candidates.length,
      omittedCount:
        summary.selection.provenance.consideredCount - candidates.length,
      policyExcludedCount: summary.policy.excluded.length,
      policyExclusionDetailedCount: policyExclusions.length,
      policyExclusionOmittedCount:
        summary.policy.excluded.length - policyExclusions.length,
      candidateSetDigest: canonicalDigest({
        candidates: summary.candidates.map(({ cardId, versionId, score }) => ({
          cardId,
          versionId,
          score,
        })),
        policyExclusions: summary.policy.excluded.map(
          ({ cardId, versionId, reason }) => ({ cardId, versionId, reason }),
        ),
      }),
    },
    verdictCounts,
    candidates,
    decisions,
    policyExclusions,
    planning: {
      ambiguous: summary.planning.ambiguous,
      facets: summary.planning.facets.map((facet) => ({
        facetRef: facetRef(facet.facetId),
        explicitSourceKinds: facet.explicitSourceKinds,
        extraction: facet.extraction,
      })),
      decisions: summary.planning.decisions.map((decision) => ({
        cardId: decision.cardId,
        versionId: decision.versionId,
        decision: decision.decision,
        reason: decision.reason,
        coveredFacetRefs: decision.coveredFacetIds.map(facetRef),
        replacementCardVersionIds: decision.replacementCardVersionIds,
      })),
      baselineCoverage: coverage(summary.planning.baselineCoverage),
      selectedCoverage: coverage(summary.planning.selectedCoverage),
      costBefore: summary.planning.costBefore,
      costAfter: summary.planning.costAfter,
      removalCount: summary.planning.removalCount,
    },
  } satisfies Omit<SelectionAuditRecord, "recordDigest">;
  const record = { ...body, recordDigest: canonicalDigest(body) };
  assertSelectionAuditRecord(record);
  return record;
}

/** Refuses corrupted or oversized records at either side of a store. */
export function assertSelectionAuditRecord(record: SelectionAuditRecord): void {
  if (record.schemaVersion !== SELECTION_AUDIT_SCHEMA_VERSION) {
    throw new TypeError("selection audit schema version is unsupported");
  }
  assertAuditIdentity(record.auditId, record.recordedAt);
  if (!/^sha256:[a-f0-9]{64}$/u.test(record.recordDigest)) {
    throw new TypeError("selection audit digest is invalid");
  }
  if (
    ![
      record.queryUtf8Bytes,
      record.catalog.evaluatedCount,
      record.catalog.detailedCount,
      record.catalog.omittedCount,
      record.catalog.policyExcludedCount,
      record.catalog.policyExclusionDetailedCount,
      record.catalog.policyExclusionOmittedCount,
      record.verdictCounts.admit,
      record.verdictCounts.defer,
      record.verdictCounts.reject,
    ].every(isNonNegativeSafeInteger) ||
    record.catalog.detailedCount !== record.candidates.length ||
    record.catalog.omittedCount !==
      record.catalog.evaluatedCount - record.catalog.detailedCount ||
    record.catalog.policyExclusionDetailedCount !==
      record.policyExclusions.length ||
    record.catalog.policyExclusionOmittedCount !==
      record.catalog.policyExcludedCount -
        record.catalog.policyExclusionDetailedCount ||
    record.catalog.detailedCount > SELECTION_AUDIT_DETAIL_LIMIT ||
    record.catalog.policyExclusionDetailedCount > SELECTION_AUDIT_DETAIL_LIMIT ||
    record.decisions.length !== record.candidates.length ||
    record.verdictCounts.admit +
        record.verdictCounts.defer +
        record.verdictCounts.reject !==
      record.catalog.evaluatedCount
  ) {
    throw new TypeError("selection audit counts are invalid");
  }
  const candidateByVersion = new Map(
    record.candidates.map((candidate) => [candidate.versionId, candidate]),
  );
  if (
    (record.mode !== "hybrid" && record.mode !== "lexical_degraded") ||
    !Number.isFinite(record.thresholds.admit) ||
    !Number.isFinite(record.thresholds.reject) ||
    record.thresholds.reject > record.thresholds.admit ||
    !Number.isSafeInteger(record.planning.removalCount) ||
    record.planning.removalCount < 0 ||
    !record.candidates.every(
      (candidate) =>
        candidate.cardId.length > 0 &&
        candidate.versionId.length > 0 &&
        Number.isFinite(candidate.score) &&
        candidate.signals.every((signal) => isSelectionAuditSignal(signal)) &&
        candidateByVersion.get(candidate.versionId) === candidate,
    ) ||
    !record.decisions.every(
      (decision) =>
        decision.cardId.length > 0 &&
        decision.versionId.length > 0 &&
        Number.isFinite(decision.score) &&
        (decision.verdict === "admit" ||
          decision.verdict === "defer" ||
          decision.verdict === "reject") &&
        candidateByVersion.get(decision.versionId)?.cardId === decision.cardId &&
        candidateByVersion.get(decision.versionId)?.score === decision.score &&
        decision.findingRules.every(isSelectionAuditFindingRule),
    ) ||
    !record.policyExclusions.every(
      (excluded) =>
        excluded.cardId.length > 0 &&
        excluded.versionId.length > 0 &&
        (excluded.reason === "usage_not_allowed" ||
          excluded.reason === "sensitive_denied"),
    )
  ) {
    throw new TypeError("selection audit decision values are invalid");
  }
  const { recordDigest, ...body } = record;
  if (canonicalDigest(body) !== recordDigest) {
    throw new TypeError("selection audit digest does not match its record");
  }
  if (
    utf8ByteLength(JSON.stringify(record)) >
    SELECTION_AUDIT_RETENTION_POLICY.maximumRecordBytes
  ) {
    throw new TypeError("selection audit record exceeds its byte limit");
  }
}

function isSelectionAuditSignal(signal: SelectionAuditSignal): boolean {
  return (
    (signal.field === "keyword" ||
      signal.field === "alias" ||
      signal.field === "representative_question" ||
      signal.field === "description" ||
      signal.field === "bm25" ||
      signal.field === "scope") &&
    Number.isFinite(signal.contribution)
  );
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function selectDetailedVersionIds(plan: SelectionPlan): ReadonlySet<string> {
  const selected = new Set<string>();
  const add = (versionId: string): void => {
    if (selected.size < SELECTION_AUDIT_DETAIL_LIMIT) selected.add(versionId);
  };
  for (const decision of plan.summary.planning.decisions) {
    if (decision.decision !== "not_planned") add(decision.versionId);
  }
  for (const verdict of ["admit", "defer", "reject"] as const) {
    for (const outcome of plan.summary.selection.outcomes) {
      if (outcome.verdict === verdict) add(outcome.versionId);
    }
  }
  return selected;
}

function assertSelectionAuditFindingRule(
  rule: string,
): SelectionAuditFindingRule {
  if (!isSelectionAuditFindingRule(rule)) {
    throw new TypeError(`selection audit finding rule is unsupported: ${rule}`);
  }
  return rule;
}

function isSelectionAuditFindingRule(
  rule: string,
): rule is SelectionAuditFindingRule {
  return (
    rule === "plan.covered_by_selected_set" ||
    rule === "score.not.finite" ||
    rule === "score.at.or.below.reject" ||
    rule === "score.below.admit"
  );
}

function assertAuditIdentity(auditId: string, recordedAt: string): void {
  if (!/^sa_[a-f0-9]{32}$/u.test(auditId)) {
    throw new TypeError("selection audit id is invalid");
  }
  const timestamp = Date.parse(recordedAt);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== recordedAt
  ) {
    throw new TypeError("selection audit timestamp is invalid");
  }
}
