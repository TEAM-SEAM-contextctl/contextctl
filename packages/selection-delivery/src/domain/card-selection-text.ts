import type { ApprovedCard, ApprovedScope } from "./card-catalog.js";
import { canonicalDigest, canonicalJson } from "./canonical-digest.js";
import { measureTextUnits } from "./text-measure.js";

/**
 * The schema name the canonical Card text is produced under.
 *
 * It travels inside the text itself, so a vector built from an older shape can
 * be told from one built under this shape by reading the input rather than by
 * trusting a profile field. `CardSelectionProfile.selectionTextSchemaVersion`
 * states the same number; the two exist together because one identifies the
 * vector family and the other identifies the bytes that were embedded.
 */
export const CARD_SELECTION_TEXT_SCHEMA = "card-selection-text-v1" as const;

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
    };

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
 * encoded. RFC 8785 rather than `JSON.stringify` for the reason
 * `canonical-digest.ts` states — property order must not depend on which code
 * path assigned the fields.
 */
export function cardSelectionTextPayload(text: CardSelectionTextV1): string {
  return canonicalJson(text);
}

/** `sha256:<hex>` over `cardSelectionTextPayload(text)`. */
export function cardSelectionTextDigest(text: CardSelectionTextV1): string {
  return canonicalDigest(text);
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
        // receives on a guide. `documentIndexId`, `connectorId`, `accessHandle`
        // and `indexVersion` stay out: the first three are our own
        // infrastructure, and the fourth changes on every republication, which
        // would invalidate a Card's vector because a document was reindexed.
        sourceId: normalizeSelectionText(scope.documentIndex.sourceId),
        documentId: normalizeSelectionText(scope.documentIndex.documentId),
      };
    case "sql_source":
      return {
        kind: "sql",
        scopeId: normalizeSelectionText(scope.reference.scopeId),
        scopeVersion: normalizeSelectionText(scope.reference.scopeVersion),
        connector: normalizeSelectionText(scope.connector),
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
      };
  }
}

/**
 * NFKC, LF line endings, whitespace runs collapsed to one space, ends trimmed.
 *
 * The whitespace collapse subsumes the line-ending rule — `\r\n` is a run of
 * whitespace and becomes one space — so newlines do not survive into the
 * canonical text at all. That is intended: the text is a single flat string
 * handed to an encoder, and a paragraph break carries no meaning the encoder
 * would read differently from a space.
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
