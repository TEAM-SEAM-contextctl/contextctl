import type {
  PublicationFactName,
  PublishedFact,
  PublishedSourceCoordinate,
} from "@contextctl/contracts";

import type { CardMeaning } from "../domain/context-card.js";
import type {
  CardMeaningGenerator,
  CardMeaningRequest,
} from "../ports/card-meaning-generator.js";

/**
 * Builds a Card's expression layer from the observation alone, with no model
 * behind it.
 *
 * This is not an attempt at good prose. It restates what was observed —
 * coordinates and facts — in a fixed shape, so the wording is flat and
 * obviously mechanical. What it buys is that Registry can consume a Publication
 * at all: `claimPublication` requires this port, so without an implementation
 * no Card is ever created. It also gives the pipeline something to fall back to
 * when a model-backed generator is unreachable, which ARCHITECTURE.md §7.4 asks
 * for: an outage should degrade the Card text, not stop Registry.
 *
 * Because every word comes from the request, it cannot name a table, column,
 * path, or document that the source does not have. The grounding check still
 * runs over its output; nothing here is exempt from it.
 *
 * The keywords and aliases are the part of this text a query is matched
 * against, so they carry the words a person actually wrote — the document
 * title, the section label, the heading path, derived keywords when Ingestion
 * publishes them — and not the schema vocabulary around them. `document`,
 * `unit`, `kind`, `count` and a base32 identifier are true of every Card and
 * therefore select none; a Korean heading is true of one.
 */
export class DeterministicCardMeaningGenerator implements CardMeaningGenerator {
  async generate(request: CardMeaningRequest): Promise<CardMeaning> {
    const { coordinate, facts } = request;

    return {
      description: describe(coordinate, facts),
      representativeQuestions: [askAbout(coordinate)],
      aliases: aliasesFor(coordinate, facts),
      keywords: keywordsFor(coordinate, facts),
    };
  }
}

/**
 * `approved-card-read-v1` ceilings on the two matched lists, in UTF-16 code
 * units — the same numbers `groundCardVersion` refuses a version over. Applied
 * here so a thin heading never produces a version that is stored only to be
 * rejected, and applied deterministically so the same facts always keep the
 * same words.
 */
const KEYWORD_LIMITS = { count: 64, each: 64 } as const;
const ALIAS_LIMITS = { count: 32, each: 128 } as const;

/**
 * The facts a person wrote, as opposed to the ones a parser measured.
 *
 * A title, a heading, the heading path above it and Ingestion's derived
 * keywords are the words a reader uses to name this knowledge area. A media
 * type, a block count, a block kind list and a unit kind describe the shape of
 * the observation, are identical across unrelated Cards, and would match a
 * query on `markdown` or `paragraph` to every document in the catalog.
 *
 * Only document-unit facts are listed. `http.summary` and `http.operation_id`
 * are human-written too, but no producer publishes an operation unit yet; they
 * join this set when one does, with a test that shows what they match.
 */
const HUMAN_FACT_NAMES: readonly PublicationFactName[] = [
  "section.label",
  "document.title",
  "section.path",
  "keywords.derived",
];

function describe(
  coordinate: PublishedSourceCoordinate,
  facts: readonly PublishedFact[],
): string {
  const stated = facts
    .map((fact) => `${fact.name}: ${formatValue(fact.value)}`)
    .join(" · ");
  const subject = subjectOf(coordinate);
  return stated === "" ? subject : `${subject} ${stated}`;
}

function subjectOf(coordinate: PublishedSourceCoordinate): string {
  switch (coordinate.kind) {
    case "document":
      return `Semantic unit ${coordinate.semanticUnitId} of document ${coordinate.documentId}.`;
    case "sql_table":
      return `Table ${coordinate.schema}.${coordinate.table} with columns ${coordinate.columns.join(", ")}.`;
    case "http_operation":
      return `HTTP operation ${coordinate.method} ${coordinate.path}.`;
    default: {
      const unreachable: never = coordinate;
      throw new Error(`unknown coordinate: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * One question naming the coordinate. Grounding requires at least one, and a
 * template keeps it honest: inventing plausible questions is exactly the kind
 * of guessing this generator exists to avoid.
 */
function askAbout(coordinate: PublishedSourceCoordinate): string {
  switch (coordinate.kind) {
    case "document":
      return `What does ${coordinate.documentId} say in ${coordinate.semanticUnitId}?`;
    case "sql_table":
      return `What does the ${coordinate.table} table record?`;
    case "http_operation":
      return `What does ${coordinate.method} ${coordinate.path} return?`;
    default: {
      const unreachable: never = coordinate;
      throw new Error(`unknown coordinate: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * The coordinate's own names first, then the heading a person gave the area.
 *
 * The coordinate aliases are the stable, citable handles — `public.payments`,
 * `GET /payments/{id}` — and they stay exactly as they were. The section label
 * and document title are added after them because a reviewer approving a Card
 * and the Card-selection embedding both read this list, and a heading says what
 * the area is in a way an identifier cannot. Capped at the read-model limit in
 * that same order, so a catalog with many headings loses the least specific
 * ones last.
 */
function aliasesFor(
  coordinate: PublishedSourceCoordinate,
  facts: readonly PublishedFact[],
): readonly string[] {
  return takeWithin(
    [
      coordinateAliases(coordinate),
      stringValues(facts, "section.label"),
      stringValues(facts, "document.title"),
    ],
    ALIAS_LIMITS,
  );
}

function coordinateAliases(coordinate: PublishedSourceCoordinate): readonly string[] {
  switch (coordinate.kind) {
    case "document":
      return sortedUnique([coordinate.documentId, coordinate.semanticUnitId]);
    case "sql_table":
      return sortedUnique([
        coordinate.table,
        `${coordinate.schema}.${coordinate.table}`,
      ]);
    case "http_operation":
      return sortedUnique([
        coordinate.path,
        `${coordinate.method} ${coordinate.path}`,
      ]);
    default: {
      const unreachable: never = coordinate;
      throw new Error(`unknown coordinate: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * Tokens a query might carry, taken from what a person wrote and from the
 * coordinate names a person types.
 *
 * In priority order: the section label, the document title, the heading path,
 * derived keywords, then the coordinate's own terms — a table's schema, name
 * and columns, an HTTP path. Not the fact *names*: `document.title` splitting
 * into `document` and `title` was true of every Card. Not a document or unit
 * identifier either: nobody queries for `unit_2k2ygrf6…`, and its prefix `unit`
 * was matching inside unrelated English words. Not the HTTP method: `get` is
 * a protocol verb, not a name for the area.
 *
 * The priority matters at the ceiling. Sorting first and cutting after would
 * order Latin and digits ahead of Hangul and drop the Korean headings first;
 * filling by group and sorting the survivors keeps the words that name the
 * area and loses coordinate tokens instead.
 */
function keywordsFor(
  coordinate: PublishedSourceCoordinate,
  facts: readonly PublishedFact[],
): readonly string[] {
  return takeWithin(
    [
      ...HUMAN_FACT_NAMES.map((name) =>
        sortedUnique(stringValues(facts, name).flatMap(tokenize)),
      ),
      sortedUnique(coordinateTerms(coordinate).flatMap(tokenize)),
    ],
    KEYWORD_LIMITS,
  );
}

function coordinateTerms(coordinate: PublishedSourceCoordinate): readonly string[] {
  switch (coordinate.kind) {
    case "document":
      return [];
    case "sql_table":
      return [coordinate.schema, coordinate.table, ...coordinate.columns];
    case "http_operation":
      return [coordinate.path];
    default: {
      const unreachable: never = coordinate;
      throw new Error(`unknown coordinate: ${JSON.stringify(unreachable)}`);
    }
  }
}

/** Every string a named fact carries, whether it was a scalar or a list. */
function stringValues(
  facts: readonly PublishedFact[],
  name: PublicationFactName,
): readonly string[] {
  return facts
    .filter((fact) => fact.name === name)
    .flatMap((fact) => (Array.isArray(fact.value) ? fact.value : [fact.value]))
    .filter((value): value is string => typeof value === "string")
    .filter((value) => value.trim() !== "");
}

/**
 * Concatenates the groups in priority order, drops repeats and over-long
 * entries, stops at the count ceiling, and sorts what survived.
 *
 * An entry over the per-item ceiling is dropped rather than cut: a truncated
 * word is not a word a person wrote, and the grounding limit exists so a value
 * is either stored whole or not at all. The cut at the count ceiling falls on
 * the lowest-priority group, which is what the group order is for; the final
 * sort keeps the output independent of that order for anything under the
 * ceiling, so it is byte-identical to what `sortedUnique` alone used to give.
 */
function takeWithin(
  groups: readonly (readonly string[])[],
  limits: { readonly count: number; readonly each: number },
): readonly string[] {
  const kept: string[] = [];
  const seen = new Set<string>();

  for (const group of groups) {
    for (const value of group) {
      if (kept.length === limits.count) {
        return kept.sort();
      }
      if (value.length > limits.each || seen.has(value)) {
        continue;
      }
      seen.add(value);
      kept.push(value);
    }
  }
  return kept.sort();
}

function tokenize(value: string): string[] {
  return value
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token !== "")
    .map((token) => token.toLowerCase());
}

function formatValue(value: PublishedFact["value"]): string {
  return Array.isArray(value) ? value.join(", ") : String(value);
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}
