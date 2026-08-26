import { canonicalDigest } from "./canonical-digest.js";
import {
  normalizeLexicalText,
  tokenizeLexicalText,
  type SourceIntent,
} from "./query-scoring.js";

/** The deterministic query decomposition proposed for selection-planning-v2. */
export const QUERY_FACET_POLICY_VERSION = "query-facet-v1" as const;

/** More facets are treated as ambiguous rather than silently truncated. */
export const QUERY_FACET_LIMIT = 4;

const EXPLICIT_COORDINATORS = new Set([
  "그리고",
  "및",
  "또한",
  "동시에",
  "and",
  "also",
  "plus",
]);

const EXPLICIT_SOURCE_MARKERS: Readonly<
  Record<SourceIntent, ReadonlySet<string>>
> = {
  managed_document: new Set(["document", "documents", "doc", "docs", "문서"]),
  sql_source: new Set([
    "db",
    "database",
    "sql",
    "table",
    "tables",
    "데이터베이스",
    "테이블",
  ]),
  http_source: new Set(["api", "endpoint", "endpoints", "엔드포인트"]),
};

export interface QueryFacet {
  readonly facetId: string;
  readonly normalizedText: string;
  readonly contentTokens: readonly string[];
  readonly explicitSourceKinds: readonly SourceIntent[];
  readonly extraction: "whole_query" | "explicit_boundary";
}

export interface QueryFacetResult {
  readonly policyVersion: typeof QUERY_FACET_POLICY_VERSION;
  readonly facets: readonly QueryFacet[];
  readonly ambiguous: boolean;
}

/**
 * Splits only boundaries a user wrote explicitly.
 *
 * This is deliberately not a general parser. Quoted strings and backticks stay
 * whole, and a decomposition over the policy limit is marked ambiguous instead
 * of being cut to fit. An ambiguous query is a signal to keep the full strong
 * set, not permission to guess which intent mattered less.
 */
export function extractQueryFacets(query: string): QueryFacetResult {
  const whole = normalizeLexicalText(query);
  const split = splitOutsideProtectedText(query);
  if (split.ambiguous) {
    return resultFor([whole], true, "whole_query");
  }
  const separated = split.parts
    .flatMap(splitExplicitCoordinators)
    .map(normalizeLexicalText)
    .filter((part) => tokenizeLexicalText(part).length > 0);

  if (separated.length === 0) {
    return resultFor([whole], false, "whole_query");
  }
  if (separated.length > QUERY_FACET_LIMIT) {
    return resultFor([whole], true, "whole_query");
  }

  const distinct = uniqueInOrder(separated);
  if (distinct.length <= 1) {
    return resultFor([whole], false, "whole_query");
  }
  return resultFor(distinct, false, "explicit_boundary");
}

function resultFor(
  parts: readonly string[],
  ambiguous: boolean,
  extraction: QueryFacet["extraction"],
): QueryFacetResult {
  const facets = parts.map((normalizedText) => {
    const contentTokens = uniqueInOrder(tokenizeLexicalText(normalizedText));
    const explicitSourceKinds = [...inferExplicitSourceIntents(contentTokens)].sort(
      compareText,
    );
    return {
      facetId: canonicalDigest({
        normalizedText,
        contentTokens,
        explicitSourceKinds,
        extraction,
      }),
      normalizedText,
      contentTokens,
      explicitSourceKinds,
      extraction,
    } satisfies QueryFacet;
  });
  return {
    policyVersion: QUERY_FACET_POLICY_VERSION,
    facets,
    ambiguous,
  };
}

function inferExplicitSourceIntents(
  tokens: readonly string[],
): ReadonlySet<SourceIntent> {
  const intents = new Set<SourceIntent>();
  for (const [kind, markers] of Object.entries(
    EXPLICIT_SOURCE_MARKERS,
  ) as readonly (readonly [SourceIntent, ReadonlySet<string>])[]) {
    if (tokens.some((token) => markers.has(token))) intents.add(kind);
  }
  return intents;
}

/** Semicolon, sentence marks, comma and line breaks outside quotes. */
function splitOutsideProtectedText(query: string): {
  readonly parts: readonly string[];
  readonly ambiguous: boolean;
} {
  const normalized = query.normalize("NFKC").toLowerCase();
  const parts: string[] = [];
  let current = "";
  let quote: "\"" | "'" | "`" | undefined;
  let escaped = false;

  const flush = (): void => {
    if (current.trim() !== "") parts.push(current);
    current = "";
  };

  for (const character of normalized) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== undefined) {
      current += character;
      escaped = true;
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      quote = quote === character ? undefined : quote ?? character;
      current += character;
      continue;
    }
    if (
      quote === undefined &&
      (character === ";" ||
        character === "," ||
        character === "?" ||
        character === "!" ||
        character === "\n" ||
        character === "\r")
    ) {
      flush();
      continue;
    }
    current += character;
  }
  flush();
  return { parts, ambiguous: quote !== undefined || escaped };
}

function splitExplicitCoordinators(text: string): readonly string[] {
  const words = text.trim().split(/\s+/u);
  const parts: string[] = [];
  let current: string[] = [];
  let quote: "\"" | "'" | "`" | undefined;
  for (const word of words) {
    if (quote === undefined && EXPLICIT_COORDINATORS.has(word)) {
      if (current.length > 0) parts.push(current.join(" "));
      current = [];
      continue;
    }
    current.push(word);
    quote = quoteAfter(word, quote);
  }
  if (current.length > 0) parts.push(current.join(" "));
  return parts.length > 1 ? parts : [text];
}

function quoteAfter(
  text: string,
  initial: "\"" | "'" | "`" | undefined,
): "\"" | "'" | "`" | undefined {
  let quote = initial;
  let escaped = false;
  for (const character of text) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== undefined) {
      escaped = true;
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      quote = quote === character ? undefined : quote ?? character;
    }
  }
  return quote;
}

function uniqueInOrder(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
