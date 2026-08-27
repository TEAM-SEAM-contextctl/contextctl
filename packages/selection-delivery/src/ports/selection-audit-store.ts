import type { SelectionAuditRecord } from "../domain/selection-audit.js";
import { canonicalDigest } from "../domain/canonical-digest.js";

/** Fixed-size projection used by list surfaces; full evidence requires find. */
export interface SelectionAuditSummary {
  readonly auditId: string;
  readonly recordedAt: string;
  readonly mode: SelectionAuditRecord["mode"];
  readonly queryUtf8Bytes: number;
  readonly catalog: SelectionAuditRecord["catalog"];
  readonly verdictCounts: SelectionAuditRecord["verdictCounts"];
  readonly planning: {
    readonly ambiguous: boolean;
    readonly removalCount: number;
  };
  readonly recordDigest: string;
  readonly summaryDigest: string;
}

/** Selection-owned durable boundary for operator-only decision audits. */
export interface SelectionAuditStore {
  append(record: SelectionAuditRecord): Promise<void>;
  list(limit: number): Promise<readonly SelectionAuditSummary[]>;
  find(auditId: string): Promise<SelectionAuditRecord | undefined>;
}

export function summarizeSelectionAuditRecord(
  record: SelectionAuditRecord,
): SelectionAuditSummary {
  const body = {
    auditId: record.auditId,
    recordedAt: record.recordedAt,
    mode: record.mode,
    queryUtf8Bytes: record.queryUtf8Bytes,
    catalog: record.catalog,
    verdictCounts: record.verdictCounts,
    planning: {
      ambiguous: record.planning.ambiguous,
      removalCount: record.planning.removalCount,
    },
    recordDigest: record.recordDigest,
  };
  return { ...body, summaryDigest: canonicalDigest(body) };
}

export function assertSelectionAuditSummary(
  summary: SelectionAuditSummary,
): void {
  const { summaryDigest, ...body } = summary;
  const timestamp = Date.parse(summary.recordedAt);
  if (
    !/^sa_[a-f0-9]{32}$/u.test(summary.auditId) ||
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== summary.recordedAt ||
    (summary.mode !== "hybrid" && summary.mode !== "lexical_degraded") ||
    ![
      summary.queryUtf8Bytes,
      summary.catalog.evaluatedCount,
      summary.catalog.detailedCount,
      summary.catalog.omittedCount,
      summary.catalog.policyExcludedCount,
      summary.catalog.policyExclusionDetailedCount,
      summary.catalog.policyExclusionOmittedCount,
      summary.verdictCounts.admit,
      summary.verdictCounts.defer,
      summary.verdictCounts.reject,
      summary.planning.removalCount,
    ].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    summary.catalog.detailedCount + summary.catalog.omittedCount !==
      summary.catalog.evaluatedCount ||
    summary.catalog.policyExclusionDetailedCount +
        summary.catalog.policyExclusionOmittedCount !==
      summary.catalog.policyExcludedCount ||
    summary.verdictCounts.admit +
        summary.verdictCounts.defer +
        summary.verdictCounts.reject !==
      summary.catalog.evaluatedCount ||
    !/^sha256:[a-f0-9]{64}$/u.test(summary.recordDigest) ||
    !/^sha256:[a-f0-9]{64}$/u.test(summary.summaryDigest) ||
    canonicalDigest(body) !== summaryDigest
  ) {
    throw new TypeError("selection audit summary is invalid");
  }
}
