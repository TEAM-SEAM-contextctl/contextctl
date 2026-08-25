import { createHash } from "node:crypto";

import type { ApprovedCard, ApprovedScope } from "./card-catalog.js";
import { measureTextUnits } from "./text-measure.js";

/**
 * The schema name of the logical Card selection record and model projection.
 *
 * The logical record retains this name for diagnostics. The compact model
 * payload deliberately omits schema syntax, so vector-family separation is
 * enforced by `CardSelectionProfile.selectionTextSchemaVersion`, transform
 * versions and the embedding profile identifier.
 *
 * `v3` separates the full logical selection record from the lines sent to the
 * model. Opaque managed-document identifiers stay in the record but do not
 * distort semantic similarity; human-facing SQL and HTTP coordinates remain
 * model input. A vector built from the v2 canonical JSON is therefore a
 * different family and cannot be reused under this label.
 *
 * Bumping it requires the profile lineage to change and every candidate vector
 * to be rebuilt before the new snapshot becomes current.
 */
export const CARD_SELECTION_TEXT_SCHEMA = "card-selection-text-v3" as const;

/**
 * What a Card contributes to the semantic index, and nothing else.
 *
 * Three properties decide what may appear here, and each one rules something
 * out. It is *approved* — the meaning of the Card Version an operator promoted,
 * never a draft. It is *public* — a logical Scope coordinate a consumer already
 * receives on a retrieval guide, never a connector id, an access handle or a
 * security domain, because a vector is derived data that outlives the request it
 * was built for and an infrastructure coordinate inside one is a leak with no
 * expiry. And it is *declared* — the Card's own description, questions, aliases
 * and keywords, never the content of the documents the Card points at, because
 * selection decides which Cards may be read and must not require having read
 * them.
 */
export interface CardSelectionTextV1 {
  readonly schema: typeof CARD_SELECTION_TEXT_SCHEMA;
  readonly description: string;
  readonly representativeQuestions: readonly string[];
  readonly aliases: readonly string[];
  readonly keywords: readonly string[];
  readonly scopes: readonly CardSelectionScope[];
}

export type CardSelectionScope =
  | {
      readonly kind: "managed_document";
      readonly scopeId: string;
      readonly scopeVersion: string;
      readonly sourceId: string;
      readonly documentId: string;
    }
  | {
      readonly kind: "sql";
      readonly scopeId: string;
      readonly scopeVersion: string;
      readonly connector: string;
      readonly schema: string;
      readonly table: string;
      readonly columns: readonly string[];
    }
  | {
      readonly kind: "http";
      readonly scopeId: string;
      readonly scopeVersion: string;
      readonly connector: string;
      readonly method: string;
      readonly path: string;
      /** Absent, never empty, when the source named no operation. */
      readonly operationId?: string;
      readonly parameters: readonly CardSelectionHttpParameter[];
    };

/** One HTTP parameter, normalized for embedding exactly like every other field. */
export interface CardSelectionHttpParameter {
  readonly location: "path" | "query";
  readonly name: string;
  readonly required: boolean;
}

/**
 * Builds the one canonical text a Card is embedded from.
 *
 * Every step exists to make two runs over the same approved Card produce byte
 * for byte the same input, because the digest of that input is what tells a
 * candidate index whether a stored vector is still the vector for this Card.
 *
 * - NFKC, so a Hangul syllable written composed and decomposed is one string
 *   and full-width Latin folds onto ASCII.
 * - CR and CRLF collapse to LF and every run of whitespace becomes one space,
 *   so a Card re-entered through an editor that changed its line endings does
 *   not invalidate its own vector.
 * - Empty entries are dropped, the rest are deduplicated and ordered by Unicode
 *   code point, so the order an operator happened to type aliases in is not part
 *   of the Card's identity.
 * - Scopes are ordered by `(scopeId, scopeVersion)` for the same reason.
 *
 * Case is deliberately *not* folded, unlike `query-scoring.ts`, which lowercases
 * before matching substrings. Lexical matching compares our text against a
 * user's text and case is noise there; an embedding model was trained on cased
 * text, and lowercasing an acronym before encoding it discards a signal the
 * model can use.
 */
export function buildCardSelectionText(card: ApprovedCard): CardSelectionTextV1 {
  return {
    schema: CARD_SELECTION_TEXT_SCHEMA,
    description: normalizeSelectionText(card.meaning.description),
    representativeQuestions: normalizeList(card.meaning.representativeQuestions),
    aliases: normalizeList(card.meaning.aliases),
    keywords: normalizeList(card.meaning.keywords),
    scopes: [...card.scopes]
      .map(toSelectionScope)
      .sort(compareScopes),
  };
}

/**
 * The exact UTF-8 string that is handed to an embedding provider and digested.
 *
 * One value serves both, and that is the point: a digest taken over a different
 * serialization than the one that was embedded would certify bytes nobody
 * encoded. The normalized arrays already have deterministic order, so the
 * payload is a compact newline-delimited semantic projection rather than JSON
 * syntax the embedding model was never trained to interpret.
 */
export function cardSelectionTextPayload(text: CardSelectionTextV1): string {
  return [
    text.description,
    ...text.representativeQuestions,
    ...text.aliases,
    ...text.keywords,
    ...text.scopes.flatMap(scopeEmbeddingValues),
  ].join("\n");
}

/** `sha256:<hex>` over `cardSelectionTextPayload(text)`. */
export function cardSelectionTextDigest(text: CardSelectionTextV1): string {
  return `sha256:${createHash("sha256")
    .update(cardSelectionTextPayload(text), "utf8")
    .digest("hex")}`;
}

/**
 * One Card reduced to everything the semantic path needs to know about it.
 *
 * The three derived values are computed together because they have to agree:
 * `payload` is what a provider encodes, `selectionTextDigest` certifies exactly
 * those bytes, and `units` is what the admission limit is applied to. Computing
 * any of them separately invites the version where a limit was checked against
 * one string and a different string was embedded.
 */
export interface CardSelectionEntry {
  readonly cardId: string;
  readonly cardVersionId: string;
  readonly text: CardSelectionTextV1;
  readonly payload: string;
  readonly selectionTextDigest: string;
  readonly units: number;
}

/** Builds the canonical text, its digest and its measured length in one pass. */
export function buildCardSelectionEntry(card: ApprovedCard): CardSelectionEntry {
  const text = buildCardSelectionText(card);
  const payload = cardSelectionTextPayload(text);

  return {
    cardId: card.cardId,
    cardVersionId: card.versionId,
    text,
    payload,
    selectionTextDigest: cardSelectionTextDigest(text),
    units: measureTextUnits(payload),
  };
}

function toSelectionScope(scope: ApprovedScope): CardSelectionScope {
  switch (scope.kind) {
    case "managed_document":
      return {
        kind: "managed_document",
        scopeId: normalizeSelectionText(scope.reference.scopeId),
        scopeVersion: normalizeSelectionText(scope.reference.scopeVersion),
        // Which source and which document, both of which a consumer already
        // receives on a guide. They remain in the logical record but v3 omits
        // them from the semantic model input. `documentIndexId` and
        // `indexVersion` stay out of this record entirely:
        // the first is our own bookkeeping, and the second changes on every
        // republication, which would invalidate a Card's vector because a
        // document was reindexed. A connector and an access handle would belong
        // in this list too and are not named because the read model no longer
        // has them — a vector outlives the request it was built for, so a
        // physical coordinate inside one is a leak with no expiry.
        sourceId: normalizeSelectionText(scope.documentIndex.sourceId),
        documentId: normalizeSelectionText(scope.documentIndex.documentId),
      };
    case "sql_source":
      return {
        kind: "sql",
        scopeId: normalizeSelectionText(scope.reference.scopeId),
        scopeVersion: normalizeSelectionText(scope.reference.scopeVersion),
        connector: normalizeSelectionText(scope.connector),
        // Without this, `public.payments` and `analytics.payments` produce the
        // same bytes, the same digest and one shared vector — two Cards the
        // candidate index cannot tell apart at all.
        schema: normalizeSelectionText(scope.schema),
        table: normalizeSelectionText(scope.table),
        // Sorted and deduplicated like the meaning lists. A column order is a
        // fact about how a Scope was written down, not about what it means, and
        // two Cards listing the same columns in two orders must embed alike.
        columns: normalizeList(scope.columns),
      };
    default:
      return {
        kind: "http",
        scopeId: normalizeSelectionText(scope.reference.scopeId),
        scopeVersion: normalizeSelectionText(scope.reference.scopeVersion),
        connector: normalizeSelectionText(scope.connector),
        method: normalizeSelectionText(scope.method),
        path: normalizeSelectionText(scope.path),
        // An absent operation name is carried as an absent field rather than as
        // an empty string. The approved read model rejects an empty name, and
        // preserving absence keeps the logical record honest.
        ...(scope.operationId === undefined
          ? {}
          : { operationId: normalizeSelectionText(scope.operationId) }),
        parameters: normalizeParameters(scope.parameters),
      };
  }
}

/**
 * Keeps only coordinates that carry searchable meaning in the model input.
 *
 * Managed-document identifiers are opaque hashes and version handles. They
 * remain on the approved Scope and in the candidate identity, but repeating
 * them inside every model input moves semantically adjacent Cards apart for a
 * reason no user query can express. SQL and HTTP coordinates are human-facing
 * names, so they remain useful selection evidence.
 */
function scopeEmbeddingValues(scope: CardSelectionScope): readonly string[] {
  switch (scope.kind) {
    case "managed_document":
      return [];
    case "sql":
      return [scope.connector, scope.schema, scope.table, ...scope.columns];
    case "http":
      return [
        scope.connector,
        scope.method,
        scope.path,
        ...(scope.operationId === undefined ? [] : [scope.operationId]),
        ...scope.parameters.flatMap((parameter) => [
          parameter.location,
          parameter.name,
          parameter.required ? "required" : "optional",
        ]),
      ];
  }
}

/**
 * NFKC, LF line endings, whitespace runs collapsed to one space, ends trimmed.
 *
 * The whitespace collapse subsumes the line-ending rule — `\r\n` is a run of
 * whitespace and becomes one space — so newlines do not survive *inside one
 * field*. `cardSelectionTextPayload` later separates fields with one newline;
 * an editor's paragraph layout is not allowed to create extra model records.
 *
 * Exported because a query has to be transformed the same way before it is
 * embedded. Two texts encoded under two different normalizations are two points
 * in a space that was only ever meant to hold one, and the resulting cosine is
 * not wrong in a way anything downstream could notice — it is merely worse. That
 * symmetry is what `queryInputTransformVersion` on the profile names.
 */
export function normalizeSelectionText(text: string): string {
  return text.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

/**
 * Parameters normalized and put in one order, like every other list here.
 *
 * Ordered by `(location, name)` rather than left as declared, for the reason
 * `columns` is sorted: the order a source happened to list its parameters in is
 * a fact about how the Scope was written down, not about what it means, and two
 * Scopes accepting the same parameters must embed alike. Nothing is
 * deduplicated — the upstream contract already refuses a repeated key, and
 * silently dropping one here would hide a Scope that broke that rule.
 */
function normalizeParameters(
  parameters: readonly {
    readonly location: "path" | "query";
    readonly name: string;
    readonly required: boolean;
  }[],
): readonly CardSelectionHttpParameter[] {
  return [...parameters]
    .map((parameter) => ({
      location: parameter.location,
      name: normalizeSelectionText(parameter.name),
      required: parameter.required,
    }))
    .sort(
      (left, right) =>
        compareByCodePoint(left.location, right.location) ||
        compareByCodePoint(left.name, right.name),
    );
}

/** Normalized, empties dropped, duplicates dropped, code point order. */
function normalizeList(values: readonly string[]): readonly string[] {
  const normalized = new Set<string>();

  for (const value of values) {
    const text = normalizeSelectionText(value);
    if (text !== "") {
      normalized.add(text);
    }
  }
  return [...normalized].sort(compareByCodePoint);
}

/**
 * Ordering by Unicode code point, which `<` does not do.
 *
 * `<` on strings compares UTF-16 code units, and a code unit ordering puts every
 * astral character (encoded as a surrogate pair in the range U+D800–U+DFFF)
 * *before* the Private Use Area and the CJK compatibility block, which sit above
 * it. Sorting by code point instead is what the requirement says and, more to
 * the point, it is a property of the text rather than of the encoding a runtime
 * happens to store it in.
 */
function compareByCodePoint(left: string, right: string): number {
  const leftPoints = [...left];
  const rightPoints = [...right];
  const shared = Math.min(leftPoints.length, rightPoints.length);

  for (let index = 0; index < shared; index += 1) {
    // Non-null: `index` is below both lengths, and every element of a spread
    // string is a whole code point, so `codePointAt(0)` is defined.
    const leftPoint = leftPoints[index]!.codePointAt(0)!;
    const rightPoint = rightPoints[index]!.codePointAt(0)!;
    if (leftPoint !== rightPoint) {
      return leftPoint < rightPoint ? -1 : 1;
    }
  }
  return leftPoints.length - rightPoints.length;
}

/** scopeId, then scopeVersion, both by code point. */
function compareScopes(
  left: CardSelectionScope,
  right: CardSelectionScope,
): number {
  return (
    compareByCodePoint(left.scopeId, right.scopeId) ||
    compareByCodePoint(left.scopeVersion, right.scopeVersion)
  );
}
