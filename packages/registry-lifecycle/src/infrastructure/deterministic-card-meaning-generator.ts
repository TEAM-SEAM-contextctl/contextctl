import type {
  PublishedFactV2 as PublishedFact,
  PublishedSourceCoordinateV2 as PublishedSourceCoordinate,
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
 */
export class DeterministicCardMeaningGenerator implements CardMeaningGenerator {
  async generate(request: CardMeaningRequest): Promise<CardMeaning> {
    const { coordinate, facts } = request;

    return {
      description: describe(coordinate, facts),
      representativeQuestions: [askAbout(coordinate)],
      aliases: aliasesFor(coordinate),
      keywords: keywordsFor(coordinate, facts),
    };
  }
}

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

function aliasesFor(coordinate: PublishedSourceCoordinate): readonly string[] {
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

/** Identifier tokens a query might carry, taken apart on separators. */
function keywordsFor(
  coordinate: PublishedSourceCoordinate,
  facts: readonly PublishedFact[],
): readonly string[] {
  const sources = [
    ...aliasesFor(coordinate),
    ...facts.map((fact) => fact.name),
    ...(coordinate.kind === "sql_table" ? coordinate.columns : []),
    ...(coordinate.kind === "http_operation" ? [coordinate.method] : []),
  ];
  return sortedUnique(sources.flatMap(tokenize));
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
