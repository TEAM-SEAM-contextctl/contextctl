import type { PublishedSourceCoordinate } from "@contextctl/contracts";

import type { CardMeaning } from "./context-card.js";
import type { RetrievalScope } from "./retrieval-scope.js";

/** Why a Card Version failed deterministic grounding, for the audit trail. */
export interface GroundingFinding {
  readonly rule: string;
  readonly message: string;
}

export type GroundingResult =
  | { readonly outcome: "validated" }
  | { readonly outcome: "rejected"; readonly findings: readonly GroundingFinding[] };

/**
 * Decides whether a Card Version may be trusted, using only deterministic
 * comparisons against the observed source. LLM-authored expression is checked
 * for presence; every machine coordinate is checked against the coordinate
 * Ingestion observed, so a Card can never name a source location that the
 * source does not actually have.
 */
export function groundCardVersion(
  coordinate: PublishedSourceCoordinate,
  scopes: readonly RetrievalScope[],
  meaning: CardMeaning,
): GroundingResult {
  const findings = [
    ...checkMeaning(meaning),
    ...scopes.flatMap((scope) => checkScope(coordinate, scope)),
  ];

  if (scopes.length === 0) {
    findings.push({
      rule: "scope.present",
      message: "card version must carry at least one retrieval scope",
    });
  }

  return findings.length === 0
    ? { outcome: "validated" }
    : { outcome: "rejected", findings };
}

function checkMeaning(meaning: CardMeaning): GroundingFinding[] {
  const findings: GroundingFinding[] = [];

  if (meaning.description.trim() === "") {
    findings.push({
      rule: "meaning.description",
      message: "description must not be blank",
    });
  }
  if (meaning.representativeQuestions.length === 0) {
    findings.push({
      rule: "meaning.representativeQuestions",
      message: "at least one representative question is required",
    });
  }
  if (
    meaning.representativeQuestions.some((question) => question.trim() === "")
  ) {
    findings.push({
      rule: "meaning.representativeQuestions",
      message: "representative questions must not be blank",
    });
  }

  return findings;
}

function checkScope(
  coordinate: PublishedSourceCoordinate,
  scope: RetrievalScope,
): GroundingFinding[] {
  if (coordinate.kind === "document" && scope.kind === "managed_document") {
    return checkManagedDocumentScope(coordinate, scope);
  }
  if (coordinate.kind === "sql_table" && scope.kind === "sql_source") {
    return checkSqlScope(coordinate, scope);
  }
  if (coordinate.kind === "http_operation" && scope.kind === "http_source") {
    return checkHttpScope(coordinate, scope);
  }
  return [
    {
      rule: "scope.kind",
      message: `scope ${scope.kind} is incompatible with ${coordinate.kind} coordinate`,
    },
  ];
}

function checkManagedDocumentScope(
  coordinate: Extract<PublishedSourceCoordinate, { kind: "document" }>,
  scope: Extract<RetrievalScope, { kind: "managed_document" }>,
): GroundingFinding[] {
  const findings: GroundingFinding[] = [];

  if (scope.documentIndex.sourceId !== coordinate.sourceId) {
    findings.push({
      rule: "scope.document.sourceId",
      message: `document index source ${scope.documentIndex.sourceId} does not match observed source ${coordinate.sourceId}`,
    });
  }
  if (scope.documentIndex.documentId !== coordinate.documentId) {
    findings.push({
      rule: "scope.document.documentId",
      message: `document index document ${scope.documentIndex.documentId} does not match observed document ${coordinate.documentId}`,
    });
  }
  if (
    scope.selection.kind === "semantic_units" &&
    !scope.selection.semanticUnitIds.includes(coordinate.semanticUnitId)
  ) {
    findings.push({
      rule: "scope.document.semanticUnitIds",
      message: `semantic selection omits the observed unit ${coordinate.semanticUnitId}`,
    });
  }

  return findings;
}

function checkSqlScope(
  coordinate: Extract<PublishedSourceCoordinate, { kind: "sql_table" }>,
  scope: Extract<RetrievalScope, { kind: "sql_source" }>,
): GroundingFinding[] {
  const findings: GroundingFinding[] = [];

  if (scope.table !== coordinate.table) {
    findings.push({
      rule: "scope.sql.table",
      message: `table ${scope.table} does not match observed table ${coordinate.table}`,
    });
  }
  for (const column of scope.columns) {
    if (!coordinate.columns.includes(column)) {
      findings.push({
        rule: "scope.sql.columns",
        message: `column ${column} does not exist in observed table ${coordinate.table}`,
      });
    }
  }

  return findings;
}

function checkHttpScope(
  coordinate: Extract<PublishedSourceCoordinate, { kind: "http_operation" }>,
  scope: Extract<RetrievalScope, { kind: "http_source" }>,
): GroundingFinding[] {
  const findings: GroundingFinding[] = [];

  if (scope.method !== coordinate.method) {
    findings.push({
      rule: "scope.http.method",
      message: `method ${scope.method} does not match observed method ${coordinate.method}`,
    });
  }
  if (scope.path !== coordinate.path) {
    findings.push({
      rule: "scope.http.path",
      message: `path ${scope.path} does not match observed path ${coordinate.path}`,
    });
  }

  return findings;
}
