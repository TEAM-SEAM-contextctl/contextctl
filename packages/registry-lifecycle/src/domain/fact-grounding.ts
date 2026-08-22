import type {
  PublicationFactName,
  PublishedFact,
  PublishedSourceCoordinate,
} from "@contextctl/contracts";

import type { CardMeaning, CardMeaningOrigin } from "./card-meaning.js";
import type { RetrievalScope } from "./retrieval-scope.js";

/**
 * One grounding observation, with how much it decides.
 *
 * `fatal` findings reject the version: the expression states something the
 * observed source does not have. `review` findings leave it promotable but
 * name what a person still has to judge — the check is deterministic, and it
 * does not claim to prove a natural-language sentence true.
 */
export interface GroundingFinding {
  readonly rule: string;
  readonly message: string;
  readonly severity: "fatal" | "review";
}

/**
 * Which observed facts the meaning actually reflects.
 *
 * Shown to an operator as evidence, never used as an approval threshold: the
 * glossary defines `factCoverage` as a value the operator sees, not a gate.
 * A fact counts as covered when every scalar of its value appears in the
 * meaning's text.
 */
export interface FactCoverage {
  readonly covered: readonly PublicationFactName[];
  readonly uncovered: readonly PublicationFactName[];
}

/**
 * The three-way outcome the design requires.
 *
 * - `validated`: structure and every machine-readable fragment check out.
 * - `rejected`: expression too poor in facts, or naming what the source
 *   does not have — validation failure.
 * - `needs_review`: structurally valid, but the wording needs a human
 *   judgement; recorded as a review result, not a refusal.
 */
export type GroundingVerdict = "validated" | "rejected" | "needs_review";

export interface GroundingReport {
  readonly verdict: GroundingVerdict;
  readonly findings: readonly GroundingFinding[];
  readonly factCoverage: FactCoverage;
  /** What produced the meaning this report judged. */
  readonly origin: CardMeaningOrigin;
}

export interface GroundingInput {
  readonly coordinate: PublishedSourceCoordinate;
  /** The unit's Published Facts — the closed vocabulary grounding checks against. */
  readonly facts: readonly PublishedFact[];
  readonly scopes: readonly RetrievalScope[];
  readonly meaning: CardMeaning;
  readonly origin: CardMeaningOrigin;
}

/**
 * Decides whether a Card Version may be trusted, using only deterministic
 * comparisons against the observed source.
 *
 * Two different questions are answered, and the report keeps them apart.
 * Machine-readable fragments in the generated text — identifiers, numbers,
 * enumerated values, paths — must exist in the unit's Published Facts or its
 * coordinate: a fragment nothing observed can account for is a fabrication,
 * whether it was invented, altered, or carried over from a different knowledge
 * unit, and it is fatal. Semantic faithfulness — "does this sentence describe
 * this knowledge well" — is not machine-decidable, so model-authored text is
 * marked for review rather than judged, and `factCoverage` gives the reviewer
 * their evidence.
 *
 * The fact vocabulary being closed (21 names, contract-enforced) is what makes
 * the first question answerable at all: with free-form names there would be
 * nothing to ask "does this identifier exist in the facts" against.
 */
export function groundCardVersion(input: GroundingInput): GroundingReport {
  const { coordinate, facts, scopes, meaning, origin } = input;
  const findings: GroundingFinding[] = [
    ...checkMeaning(meaning),
    ...scopes.flatMap((scope) => checkScope(coordinate, scope)),
    ...scopes.flatMap((scope) => checkScopeTokens(scope)),
    ...checkMachineFragments(coordinate, facts, scopes, meaning),
  ];

  if (scopes.length === 0) {
    findings.push(fatal("scope.present", "card version must carry at least one retrieval scope"));
  }
  if (scopes.length > READ_MODEL_LIMITS.scopesPerCard) {
    // Splitting the Card is the answer, not serving a truncated range: a Card
    // that silently covers fewer scopes than it claims is worse than one an
    // operator was told to split.
    findings.push(
      fatal(
        "scope.count",
        `card version carries ${scopes.length} scopes, over the ${READ_MODEL_LIMITS.scopesPerCard} allowed by approved-card-read-v1`,
      ),
    );
  }

  if (origin.generator === "model") {
    // Not a defect: a machine cannot prove a model's sentence faithful, so the
    // judgement is recorded as pending rather than passed. Deterministic text
    // is assembled verbatim from the facts and needs no such judgement.
    findings.push({
      severity: "review",
      rule: "meaning.modelAuthored",
      message: `expression written by model ${origin.model ?? "unknown"} awaits an operator's semantic review`,
    });
  }

  return {
    verdict: verdictOf(findings),
    findings,
    factCoverage: computeFactCoverage(facts, meaning),
    origin,
  };
}

function verdictOf(findings: readonly GroundingFinding[]): GroundingVerdict {
  if (findings.some((finding) => finding.severity === "fatal")) {
    return "rejected";
  }
  return findings.some((finding) => finding.severity === "review")
    ? "needs_review"
    : "validated";
}

function fatal(rule: string, message: string): GroundingFinding {
  return { rule, message, severity: "fatal" };
}

/**
 * Fragments of the meaning that look machine-readable, each required to exist
 * in the observed universe: fact values, coordinate fields, scope references.
 *
 * The extraction is deliberately conservative — prefixed identifiers,
 * snake_case tokens, standalone numbers, paths, HTTP methods. Prose in any
 * language matches none of the patterns, so a sentence is never rejected for
 * being a sentence; only for the machine-shaped values it embeds.
 */
function checkMachineFragments(
  coordinate: PublishedSourceCoordinate,
  facts: readonly PublishedFact[],
  scopes: readonly RetrievalScope[],
  meaning: CardMeaning,
): GroundingFinding[] {
  const allowed = allowedTokens(coordinate, facts, scopes);
  const findings: GroundingFinding[] = [];

  for (const [field, text] of meaningTexts(meaning)) {
    for (const fragment of machineFragments(text)) {
      if (!allowed.has(fragment.toLowerCase())) {
        findings.push(
          fatal(
            "meaning.fabricatedValue",
            `${field} names "${fragment}", which exists in neither the unit's facts nor its coordinate`,
          ),
        );
      }
    }
  }
  return findings;
}

function meaningTexts(meaning: CardMeaning): readonly (readonly [string, string])[] {
  return [
    ["meaning.description", meaning.description] as const,
    ...meaning.representativeQuestions.map(
      (text) => ["meaning.representativeQuestions", text] as const,
    ),
    ...meaning.aliases.map((text) => ["meaning.aliases", text] as const),
    ...meaning.keywords.map((text) => ["meaning.keywords", text] as const),
  ];
}

/**
 * Splits text into candidate tokens, dropping sentence punctuation.
 *
 * The dot stays inside a token (`public.payments`, `1.5`) but a trailing one is
 * the sentence's, not the value's — without stripping it, a description ending
 * in a path would be rejected for naming "/payments/{id}." while the coordinate
 * says "/payments/{id}".
 */
function tokenize(text: string): readonly string[] {
  return (text.match(/[\p{L}\p{N}_{}/.-]+/gu) ?? []).map(stripTrailingPunctuation);
}

/**
 * A loop rather than `/[.,]+$/`: that regex backtracks polynomially on a long
 * run of separators, and this function runs over text a model wrote — length
 * is bounded upstream, but the domain should not rely on it for its own
 * worst case.
 */
function stripTrailingPunctuation(token: string): string {
  let end = token.length;
  while (end > 0 && (token[end - 1] === "." || token[end - 1] === ",")) {
    end -= 1;
  }
  return token.slice(0, end);
}

/** Tokens that read as machine values rather than words. */
const PREFIXED_IDENTIFIER = /^[a-z]+_[a-z0-9][a-z0-9_-]*$/u;
const SNAKE_CASE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/u;
const STANDALONE_NUMBER = /^[0-9]+(?:\.[0-9]+)?$/u;
const PATH = /^\/[^\s]*$/u;
/** The closed HTTP method set — an enumerated value, not a word. */
const HTTP_METHOD = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/u;

function machineFragments(text: string): readonly string[] {
  const tokens = tokenize(text).filter(
    (token) =>
      PREFIXED_IDENTIFIER.test(token) ||
      SNAKE_CASE.test(token) ||
      STANDALONE_NUMBER.test(token) ||
      PATH.test(token) ||
      HTTP_METHOD.test(token),
  );
  // Numbers glued to a word — "8000행", "v2" would be words, but "8000" is a
  // checkable claim regardless of what it is attached to. Extracted from the
  // raw text and admitted symmetrically from the fact values, so "5영업일" in a
  // fact accounts for the 5 in the text.
  return [...tokens, ...digitRuns(text)];
}

function digitRuns(text: string): readonly string[] {
  return text.match(/[0-9]+(?:\.[0-9]+)?/gu) ?? [];
}

/**
 * Every token the observation can account for, lowercased.
 *
 * Built with the same tokenizer the fragments use, so a value embedded in a
 * fact sentence ("table payments holds refunds") accounts for the same token a
 * meaning would embed. Whole values are added too, for fragments the tokenizer
 * would split differently — paths keep their slashes either way.
 */
function allowedTokens(
  coordinate: PublishedSourceCoordinate,
  facts: readonly PublishedFact[],
  scopes: readonly RetrievalScope[],
): ReadonlySet<string> {
  const allowed = new Set<string>();
  const admit = (value: string): void => {
    allowed.add(value.toLowerCase());
    for (const token of [...tokenize(value), ...digitRuns(value)]) {
      allowed.add(token.toLowerCase());
    }
  };

  for (const fact of facts) {
    for (const scalar of scalarsOf(fact)) {
      admit(scalar);
    }
  }
  for (const value of coordinateValues(coordinate)) {
    admit(value);
  }
  for (const scope of scopes) {
    for (const value of scopeValues(scope)) {
      admit(value);
    }
  }
  return allowed;
}

function scalarsOf(fact: PublishedFact): readonly string[] {
  const values = Array.isArray(fact.value) ? fact.value : [fact.value];
  return values.map((value) => String(value));
}

function coordinateValues(coordinate: PublishedSourceCoordinate): readonly string[] {
  switch (coordinate.kind) {
    case "document":
      return [coordinate.sourceId, coordinate.documentId, coordinate.semanticUnitId];
    case "sql_table":
      return [
        coordinate.sourceId,
        coordinate.schema,
        coordinate.table,
        ...coordinate.columns,
      ];
    case "http_operation":
      return [
        coordinate.sourceId,
        coordinate.method,
        coordinate.path,
        ...(coordinate.operationId === undefined ? [] : [coordinate.operationId]),
        ...coordinate.parameters.map((parameter) => parameter.name),
      ];
    default: {
      const unreachable: never = coordinate;
      throw new Error(`unknown coordinate kind: ${String(unreachable)}`);
    }
  }
}

function scopeValues(scope: RetrievalScope): readonly string[] {
  const shared = [scope.reference.scopeId, scope.reference.scopeVersion];
  switch (scope.kind) {
    case "managed_document":
      return [
        ...shared,
        scope.documentIndex.documentIndexId,
        scope.documentIndex.sourceId,
        scope.documentIndex.documentId,
        scope.documentIndex.indexVersion,
        ...(scope.selection.kind === "semantic_units"
          ? scope.selection.semanticUnitIds
          : []),
      ];
    case "sql_source":
      return [...shared, scope.connector, scope.schema, scope.table, ...scope.columns];
    case "http_source":
      return [
        ...shared,
        scope.connector,
        scope.method,
        scope.path,
        ...(scope.operationId === undefined ? [] : [scope.operationId]),
        ...scope.parameters.map((parameter) => parameter.name),
      ];
    default: {
      const unreachable: never = scope;
      throw new Error(`unknown scope kind: ${String(unreachable)}`);
    }
  }
}

/**
 * A fact is covered when every scalar of its value appears in the meaning.
 *
 * Substring on lowercased text, because fact values are phrases ("Payment
 * failures") as often as tokens, and the comparison has to hold for both. The
 * result is informational: an uncovered fact is not a finding, it is what the
 * reviewing operator reads next to the text.
 */
function computeFactCoverage(
  facts: readonly PublishedFact[],
  meaning: CardMeaning,
): FactCoverage {
  const haystack = meaningTexts(meaning)
    .map(([, text]) => text)
    .join("\n")
    .toLowerCase();

  const covered: PublicationFactName[] = [];
  const uncovered: PublicationFactName[] = [];
  for (const fact of facts) {
    const scalars = scalarsOf(fact);
    const reflected = scalars.every((scalar) =>
      haystack.includes(scalar.toLowerCase()),
    );
    (reflected ? covered : uncovered).push(fact.name);
  }
  return { covered, uncovered };
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
      findings.push(fatal(rule, `${rule} must not be blank`));
    }
    return findings;
  }
  if (value.length > bounds.max) {
    findings.push(
      fatal(
        rule,
        `${rule} is ${value.length} code units, over the ${bounds.max} allowed by approved-card-read-v1`,
      ),
    );
  }
  if (CONTROL_CHARACTERS.test(value)) {
    findings.push(fatal(rule, `${rule} contains a control character`));
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
    findings.push(fatal(rule, `at least one ${rule} entry is required`));
  }
  if (values.length > bounds.count) {
    findings.push(
      fatal(
        rule,
        `${rule} has ${values.length} entries, over the ${bounds.count} allowed by approved-card-read-v1`,
      ),
    );
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
    fatal(
      "scope.kind",
      `scope ${scope.kind} is incompatible with ${coordinate.kind} coordinate`,
    ),
  ];
}

function checkManagedDocumentScope(
  coordinate: Extract<PublishedSourceCoordinate, { kind: "document" }>,
  scope: Extract<RetrievalScope, { kind: "managed_document" }>,
): GroundingFinding[] {
  const findings: GroundingFinding[] = [];

  if (scope.documentIndex.sourceId !== coordinate.sourceId) {
    findings.push(
      fatal(
        "scope.document.sourceId",
        `document index source ${scope.documentIndex.sourceId} does not match observed source ${coordinate.sourceId}`,
      ),
    );
  }
  if (scope.documentIndex.documentId !== coordinate.documentId) {
    findings.push(
      fatal(
        "scope.document.documentId",
        `document index document ${scope.documentIndex.documentId} does not match observed document ${coordinate.documentId}`,
      ),
    );
  }
  if (
    scope.selection.kind === "semantic_units" &&
    !scope.selection.semanticUnitIds.includes(coordinate.semanticUnitId)
  ) {
    findings.push(
      fatal(
        "scope.document.semanticUnitIds",
        `semantic selection omits the observed unit ${coordinate.semanticUnitId}`,
      ),
    );
  }

  return findings;
}

function checkSqlScope(
  coordinate: Extract<PublishedSourceCoordinate, { kind: "sql_table" }>,
  scope: Extract<RetrievalScope, { kind: "sql_source" }>,
): GroundingFinding[] {
  const findings: GroundingFinding[] = [];

  if (scope.table !== coordinate.table) {
    findings.push(
      fatal(
        "scope.sql.table",
        `table ${scope.table} does not match observed table ${coordinate.table}`,
      ),
    );
  }
  for (const column of scope.columns) {
    if (!coordinate.columns.includes(column)) {
      findings.push(
        fatal(
          "scope.sql.columns",
          `column ${column} does not exist in observed table ${coordinate.table}`,
        ),
      );
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
    findings.push(
      fatal(
        "scope.http.method",
        `method ${scope.method} does not match observed method ${coordinate.method}`,
      ),
    );
  }
  if (scope.path !== coordinate.path) {
    findings.push(
      fatal(
        "scope.http.path",
        `path ${scope.path} does not match observed path ${coordinate.path}`,
      ),
    );
  }

  return findings;
}
