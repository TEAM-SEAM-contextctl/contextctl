import {
  assertSelectionAuditRecord,
  SELECTION_AUDIT_RETENTION_POLICY,
  type SelectionAuditRecord,
} from "../domain/selection-audit.js";
import type { SelectionAuditStore } from "../ports/selection-audit-store.js";
import {
  summarizeSelectionAuditRecord,
  type SelectionAuditSummary,
} from "../ports/selection-audit-store.js";

/** Bounded process-local adapter for embedded and focused test compositions. */
export class InMemorySelectionAuditStore implements SelectionAuditStore {
  readonly #records: SelectionAuditRecord[] = [];

  constructor(readonly now: () => number = Date.now) {}

  async append(record: SelectionAuditRecord): Promise<void> {
    assertSelectionAuditRecord(record);
    if (this.#records.some((candidate) => candidate.auditId === record.auditId)) {
      throw new TypeError(`selection audit already exists: ${record.auditId}`);
    }
    this.#records.push(record);
    this.#records.sort(
      (left, right) =>
        Date.parse(right.recordedAt) - Date.parse(left.recordedAt) ||
        right.auditId.localeCompare(left.auditId),
    );
    this.#prune(this.now());
  }

  async list(limit: number): Promise<readonly SelectionAuditSummary[]> {
    assertSelectionAuditListLimit(limit);
    this.#prune(this.now());
    return this.#records.slice(0, limit).map(summarizeSelectionAuditRecord);
  }

  async find(auditId: string): Promise<SelectionAuditRecord | undefined> {
    this.#prune(this.now());
    return this.#records.find((record) => record.auditId === auditId);
  }

  #prune(now: number): void {
    const oldest = now - SELECTION_AUDIT_RETENTION_POLICY.maximumAgeMs;
    while (
      this.#records.length > 0 &&
      Date.parse(this.#records.at(-1)!.recordedAt) < oldest
    ) {
      this.#records.pop();
    }
    this.#records.splice(SELECTION_AUDIT_RETENTION_POLICY.maximumRecords);
    let bytes = 0;
    let keep = 0;
    for (const record of this.#records) {
      const next = Buffer.byteLength(JSON.stringify(record), "utf8");
      if (bytes + next > SELECTION_AUDIT_RETENTION_POLICY.maximumBytes) break;
      bytes += next;
      keep += 1;
    }
    this.#records.splice(keep);
  }
}

export function assertSelectionAuditListLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError("selection audit list limit must be between 1 and 100");
  }
}
