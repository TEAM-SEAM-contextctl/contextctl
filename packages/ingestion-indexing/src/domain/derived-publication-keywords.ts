import type { DocumentBlock } from "./document-model.js";

/** Reproduce the exact bounded vocabulary projected into Publication facts. */
export const DOCUMENT_KEYWORD_EXTRACTION_POLICY_VERSION =
  "document-keywords-v1";

/** Uses the contract ceiling so late, distinctive terms are not silently lost. */
export const MAX_DERIVED_PUBLICATION_KEYWORDS = 64;
export const MAX_DERIVED_PUBLICATION_KEYWORD_CODE_UNITS = 64;

const WORD_SEGMENTER = new Intl.Segmenter("und", { granularity: "word" });
const ELIGIBLE_BLOCK_KINDS = new Set<DocumentBlock["kind"]>([
  "paragraph",
  "list_item",
  "table",
  "quote",
]);

export type DerivedKeywordSourceBlock = Pick<
  DocumentBlock,
  "kind" | "analysisText"
>;

interface KeywordCandidate {
  readonly value: string;
  readonly firstOccurrence: number;
  frequency: number;
}

/**
 * Derives a small, deterministic word vocabulary from one Semantic Unit.
 *
 * Only word-like surface forms cross the Publication boundary. Headings already
 * have dedicated facts, while code and non-text structure are deliberately
 * excluded so this field cannot become a disguised excerpt or identifier dump.
 * Inflection is preserved: language-specific stemming here would make the
 * supposedly multilingual contract depend on an incomplete morphology table.
 */
export function derivePublicationKeywords(
  blocks: readonly DerivedKeywordSourceBlock[],
): readonly string[] {
  const candidates = new Map<string, KeywordCandidate>();
  let occurrence = 0;

  for (const block of blocks) {
    if (!ELIGIBLE_BLOCK_KINDS.has(block.kind)) {
      continue;
    }
    const normalized = block.analysisText
      .normalize("NFKC")
      .toLocaleLowerCase("und");
    for (const segment of WORD_SEGMENTER.segment(normalized)) {
      if (!segment.isWordLike) {
        continue;
      }
      const value = segment.segment.trim();
      if (!isAllowedKeyword(value)) {
        continue;
      }
      const existing = candidates.get(value);
      if (existing === undefined) {
        candidates.set(value, {
          value,
          firstOccurrence: occurrence,
          frequency: 1,
        });
      } else {
        existing.frequency += 1;
      }
      occurrence += 1;
    }
  }

  return [...candidates.values()]
    .sort(compareCandidatePriority)
    .slice(0, MAX_DERIVED_PUBLICATION_KEYWORDS)
    .map((candidate) => candidate.value)
    .sort(compareText);
}

function isAllowedKeyword(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > MAX_DERIVED_PUBLICATION_KEYWORD_CODE_UNITS
  ) {
    return false;
  }
  const codePointCount = Array.from(value).length;
  return codePointCount >= 2 || /^\p{N}$/u.test(value);
}

function compareCandidatePriority(
  left: KeywordCandidate,
  right: KeywordCandidate,
): number {
  return (
    right.frequency - left.frequency ||
    left.firstOccurrence - right.firstOccurrence ||
    compareText(left.value, right.value)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
