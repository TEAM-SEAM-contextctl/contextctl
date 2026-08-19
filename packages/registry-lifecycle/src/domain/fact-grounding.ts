import type { PublishedSourceCoordinateV2 as PublishedSourceCoordinate } from "@contextctl/contracts";

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
 *
 * The design calls this Fact Grounding, and the name is precise about what is
 * and is not claimed: the check compares a Card against the Published Facts and
 * coordinates of its Knowledge Unit. It does not claim to prove that a natural
 * language sentence is true. Semantic faithfulness is shown to an operator as
 * coverage and change comparison, and no generated version is auto-approved.
 */
export function groundCardVersion(
  coordinate: PublishedSourceCoordinate,
  scopes: readonly RetrievalScope[],
  meaning: CardMeaning,
): GroundingResult {
  const findings = [
    ...checkMeaning(meaning),
    ...scopes.flatMap((scope) => checkScope(coordinate, scope)),
    ...scopes.flatMap((scope) => checkScopeTokens(scope)),
  ];

  if (scopes.length === 0) {
    findings.push({
      rule: "scope.present",
      message: "card version must carry at least one retrieval scope",
    });
  }
  if (scopes.length > READ_MODEL_LIMITS.scopesPerCard) {
    // Splitting the Card is the answer, not serving a truncated range: a Card
    // that silently covers fewer scopes than it claims is worse than one an
    // operator was told to split.
    findings.push({
      rule: "scope.count",
      message: `card version carries ${scopes.length} scopes, over the ${READ_MODEL_LIMITS.scopesPerCard} allowed by approved-card-read-v1`,
    });
  }

  return findings.length === 0
    ? { outcome: "validated" }
    : { outcome: "rejected", findings };
}

/**
 * `approved-card-read-v1` size limits, in UTF-16 code units.
 *
 * These are the shape of the read model Selection consumes, so they are checked
 * here rather than where the catalog is assembled: a version that breaks them
 * never reaches `validated`, and the domain already refuses to promote anything
 * else. Enforcing at assembly time would leave a stored version that looks
 * approvable but cannot be served.
 *
 * Nothing is truncated. A description cut mid-sentence still reads like a
 * description, so it would be served as if it were whole, and the operator who
 * could have fixed it never learns it was too long.
 */
const READ_MODEL_LIMITS = {
  description: { max: 1_024 },
  representativeQuestions: { count: 16, each: 512 },
  aliases: { count: 32, each: 128 },
  keywords: { count: 64, each: 64 },
  scopesPerCard: 64,
  /**
   * Every id and version token in the read model.
   *
   * The contract identifiers constrain the character set but not the length, so
   * an arbitrarily long `unit_…` passes upstream validation and would reach the
   * catalog. Checked here because these tokens are what a consumer echoes back
   * and what the snapshot digest is computed over.
   */
  token: 256,
} as const;

/** Rejected anywhere in the read model: they break canonical comparison. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

function checkMeaning(meaning: CardMeaning): GroundingFinding[] {
  return [
    ...checkText("meaning.description", meaning.description, {
      max: READ_MODEL_LIMITS.description.max,
      required: true,
    }),
    ...checkTextList(
      "meaning.representativeQuestions",
      meaning.representativeQuestions,
      { ...READ_MODEL_LIMITS.representativeQuestions, required: true },
    ),
    ...checkTextList("meaning.aliases", meaning.aliases, {
      ...READ_MODEL_LIMITS.aliases,
      required: false,
    }),
    ...checkTextList("meaning.keywords", meaning.keywords, {
      ...READ_MODEL_LIMITS.keywords,
      required: false,
    }),
  ];
}

/** Ids and versions the Scope carries, all bounded the same way. */
function checkScopeTokens(scope: RetrievalScope): GroundingFinding[] {
  const tokens: readonly string[] = [
    scope.reference.scopeId,
    scope.reference.scopeVersion,
    ...(scope.kind === "managed_document"
      ? [
          scope.documentIndex.documentIndexId,
          scope.documentIndex.sourceId,
          scope.documentIndex.documentId,
          scope.documentIndex.indexVersion,
        ]
      : []),
    ...(scope.kind === "sql_source"
      ? [scope.connector, scope.table, ...scope.columns]
      : []),
    ...(scope.kind === "http_source" ? [scope.connector, scope.path] : []),
  ];

  return tokens.flatMap((token) =>
    checkText("scope.token", token, {
      max: READ_MODEL_LIMITS.token,
      required: true,
    }),
  );
}

function checkText(
  rule: string,
  value: string,
  bounds: { readonly max: number; readonly required: boolean },
): GroundingFinding[] {
  const findings: GroundingFinding[] = [];
  if (value.trim() === "") {
    // A blank value and a missing one are the same absence to a reader, and
    // both are refused rather than stored as an empty string.
    if (bounds.required) {
      findings.push({ rule, message: `${rule} must not be blank` });
    }
    return findings;
  }
  if (value.length > bounds.max) {
    findings.push({
      rule,
      message: `${rule} is ${value.length} code units, over the ${bounds.max} allowed by approved-card-read-v1`,
    });
  }
  if (CONTROL_CHARACTERS.test(value)) {
    findings.push({
      rule,
      message: `${rule} contains a control character`,
    });
  }
  return findings;
}

function checkTextList(
  rule: string,
  values: readonly string[],
  bounds: {
    readonly count: number;
    readonly each: number;
    readonly required: boolean;
  },
): GroundingFinding[] {
  const findings: GroundingFinding[] = [];
  if (bounds.required && values.length === 0) {
    findings.push({ rule, message: `at least one ${rule} entry is required` });
  }
  if (values.length > bounds.count) {
    findings.push({
      rule,
      message: `${rule} has ${values.length} entries, over the ${bounds.count} allowed by approved-card-read-v1`,
    });
  }
  for (const value of values) {
    findings.push(
      ...checkText(rule, value, { max: bounds.each, required: true }),
    );
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
