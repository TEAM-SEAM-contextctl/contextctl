import type { ApprovedDocumentSelection } from "../domain/card-catalog.js";
import type {
  DocumentChunkQuery,
  ManagedDocumentRetriever,
  RetrievedChunk,
} from "../ports/managed-document-retriever.js";
import { DocumentRetrievalFault } from "../ports/managed-document-retriever.js";

/**
 * A chunk as a fixture declares it: everything a retrieved chunk carries except
 * the score, because the score is a property of a query, not of the chunk.
 */
export type FixtureChunk = Omit<RetrievedChunk, "score">;

/**
 * A `ManagedDocumentRetriever` over chunks held in memory, one list per
 * document index.
 *
 * There is no Vector DB in the demo path, and ADR 0002 leaves that adapter for
 * the daemon to assemble, so this stands in for it while remaining honest about
 * the two obligations the port places on an adapter: scores are normalized to
 * [0, 1], and no chunk outside the requested `selection` is ever returned. Both
 * are enforced here rather than assumed, so a consumer written against this
 * adapter is written against the real contract.
 *
 * Similarity is character-bigram Jaccard, implemented privately in this file.
 * It intentionally duplicates the same idea in `domain/query-scoring.ts`: a
 * fixture adapter standing in for a vector store must not pin the domain's
 * scoring rules, and the two are free to diverge.
 */
export class FixtureDocumentRetriever implements ManagedDocumentRetriever {
  readonly #chunksByIndexId: Readonly<Record<string, readonly FixtureChunk[]>>;

  constructor(chunksByIndexId: Readonly<Record<string, readonly FixtureChunk[]>>) {
    this.#chunksByIndexId = { ...chunksByIndexId };
  }

  searchChunks(query: DocumentChunkQuery): Promise<readonly RetrievedChunk[]> {
    // `Object.hasOwn` rather than a truthiness check, so an index registered
    // with an empty chunk list reads as available-and-empty instead of missing.
    if (!Object.hasOwn(this.#chunksByIndexId, query.documentIndex.documentIndexId)) {
      return Promise.reject(new DocumentRetrievalFault("index_unavailable"));
    }

    const chunks = this.#chunksByIndexId[query.documentIndex.documentIndexId] ?? [];
    if (query.limit <= 0) {
      return Promise.resolve([]);
    }

    const queryBigrams = toBigrams(normalizeText(query.queryText));
    const scored = chunks
      .filter((chunk) => isInSelection(chunk, query.selection))
      .map((chunk) => ({
        ...chunk,
        score: bigramJaccard(queryBigrams, toBigrams(normalizeText(chunk.text))),
      }));

    scored.sort(compareByScoreThenRevision);

    return Promise.resolve(scored.slice(0, query.limit));
  }
}

/**
 * The Scope decides what may be seen. A `document` selection exposes the whole
 * index; a `semantic_units` selection exposes exactly the named units, and a
 * chunk belonging to none of them is filtered out before it is ever scored.
 */
function isInSelection(
  chunk: FixtureChunk,
  selection: ApprovedDocumentSelection,
): boolean {
  if (selection.kind === "document") {
    return true;
  }
  return selection.semanticUnitIds.includes(chunk.semanticUnitId);
}

/**
 * Higher score first, then ascending `chunkRevisionId`.
 *
 * The tie-break uses `<` and `>` rather than `localeCompare`, which resolves
 * against the runtime's locale and would let the same query return a different
 * order on two machines. `selection-verdict.ts` breaks ties the same way.
 */
function compareByScoreThenRevision(
  left: RetrievedChunk,
  right: RetrievedChunk,
): number {
  if (left.score !== right.score) {
    return right.score - left.score;
  }
  if (left.chunkRevisionId < right.chunkRevisionId) {
    return -1;
  }
  if (left.chunkRevisionId > right.chunkRevisionId) {
    return 1;
  }
  return 0;
}

/**
 * NFKC so a Hangul syllable written composed or decomposed is one string,
 * lowercased without a locale, and collapsed on whitespace.
 */
function normalizeText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

/** The set of adjacent character pairs; a text shorter than two yields none. */
function toBigrams(text: string): ReadonlySet<string> {
  const bigrams = new Set<string>();

  for (let index = 0; index + 2 <= text.length; index += 1) {
    bigrams.add(text.slice(index, index + 2));
  }
  return bigrams;
}

/**
 * Jaccard over the two bigram sets, which is 0 when either side is empty and
 * otherwise lands in [0, 1] by construction: the intersection can never exceed
 * the union.
 */
function bigramJaccard(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const bigram of left) {
    if (right.has(bigram)) {
      intersection += 1;
    }
  }

  return intersection / (left.size + right.size - intersection);
}
