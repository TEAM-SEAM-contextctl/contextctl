import type {
  SelectionAuditRecord,
  SelectionAuditSummary,
} from "@contextctl/selection-delivery";

import { readDaemonStateIdentity } from "../main.js";
import {
  inspectSelectionAuditDatabase,
  openSelectionAuditDatabase,
  SqliteSelectionAuditStore,
} from "../selection-audit/sqlite-selection-audit-store.js";
import type { CliCommand } from "./arguments.js";
import type { CommandOutcome } from "./commands.js";
import { EXIT_CODES } from "./exit-codes.js";
import { resolveContextctlPaths } from "./paths.js";

type AuditCommand = Extract<
  CliCommand,
  { kind: "audit_list" | "audit_show" }
>;

/** Reads the protected local audit store without assembling the query runtime. */
export async function runSelectionAuditCommand(input: {
  readonly command: AuditCommand;
  readonly environment: Readonly<Partial<Record<string, string>>>;
  readonly workingDirectory: string;
}): Promise<CommandOutcome> {
  const paths = resolveContextctlPaths(input.environment, input.workingDirectory);
  const stateIdentity = readDaemonStateIdentity(input.environment);
  const inspection = inspectSelectionAuditDatabase({
    location: paths.selectionAuditDatabase,
    stateIdentity,
  });
  if (inspection.status === "missing") {
    if (input.command.kind === "audit_list") {
      return {
        stdout: input.command.json
          ? "[]"
          : "선택 감사 기록이 아직 없습니다.",
        stderr: [],
        exitCode: EXIT_CODES.ok,
      };
    }
    return notFound(input.command.auditId);
  }
  if (inspection.status === "incompatible") {
    return {
      stdout: "",
      stderr: [
        `선택 감사 저장소를 읽을 수 없습니다: ${inspection.detail}`,
      ],
      exitCode: EXIT_CODES.genericFailure,
    };
  }

  const database = openSelectionAuditDatabase({
    location: paths.selectionAuditDatabase,
    stateIdentity,
    readOnly: true,
  });
  try {
    const store = new SqliteSelectionAuditStore(database);
    if (input.command.kind === "audit_list") {
      const records = await store.list(input.command.limit);
      return {
        stdout: input.command.json
          ? JSON.stringify(records, undefined, 2)
          : renderAuditList(records),
        stderr: [],
        exitCode: EXIT_CODES.ok,
      };
    }
    const record = await store.find(input.command.auditId);
    if (record === undefined) return notFound(input.command.auditId);
    return {
      stdout: input.command.json
        ? JSON.stringify(record, undefined, 2)
        : renderAuditRecord(record),
      stderr: [],
      exitCode: EXIT_CODES.ok,
    };
  } finally {
    database.close();
  }
}

function renderAuditList(records: readonly SelectionAuditSummary[]): string {
  if (records.length === 0) return "선택 감사 기록이 아직 없습니다.";
  return records
    .map((record) => {
      const counts = record.verdictCounts;
      return [
        `${record.recordedAt}  ${record.auditId}`,
        `  ${record.mode} · 후보 ${record.catalog.evaluatedCount} · 제외 ${record.catalog.policyExcludedCount} · 승인 ${counts.admit} · 보류 ${counts.defer} · 거부 ${counts.reject} · 집합 제외 ${record.planning.removalCount}`,
      ].join("\n");
    })
    .join("\n");
}

function renderAuditRecord(record: SelectionAuditRecord): string {
  const counts = record.verdictCounts;
  const retained = record.planning.decisions.filter(
    (decision) => decision.decision !== "not_planned",
  );
  return [
    `감사 식별자: ${record.auditId}`,
    `기록 시각: ${record.recordedAt}`,
    `실행 모드: ${record.mode}`,
    `질의 크기: ${record.queryUtf8Bytes} UTF-8 bytes (원문 미저장)`,
    `후보: ${record.catalog.evaluatedCount}, 정책 제외: ${record.catalog.policyExcludedCount}`,
    `판정: 승인 ${counts.admit}, 보류 ${counts.defer}, 거부 ${counts.reject}`,
    `최소 집합: ${retained.length}개 유지, ${record.planning.removalCount}개 제외, 모호성 ${record.planning.ambiguous ? "있음" : "없음"}`,
    `기록 digest: ${record.recordDigest}`,
    "",
    "계획에 유지된 Card:",
    ...(retained.length === 0
      ? ["  (없음)"]
      : retained.map(
          (decision) =>
            `  ${decision.cardId} ${decision.versionId} · ${decision.decision} · ${decision.reason}`,
        )),
  ].join("\n");
}

function notFound(auditId: string): CommandOutcome {
  return {
    stdout: "",
    stderr: [`선택 감사 기록을 찾지 못했습니다: ${auditId}`],
    exitCode: EXIT_CODES.genericFailure,
  };
}
