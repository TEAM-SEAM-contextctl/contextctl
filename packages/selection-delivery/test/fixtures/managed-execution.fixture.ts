import type {
  ManagedDocumentResolutionTarget,
  ManagedResolutionFailure,
  ManagedResolutionOutcome,
  ResolvedDocumentChunk,
} from "../../src/index.js";

/**
 * An executor for the managed reads a plan names, over chunks held in memory.
 *
 * It lives in the test tree rather than in `src/`, and that placement is the
 * point. The package used to ship a `FixtureDocumentRetriever` implementing a
 * retrieval port it declared; there is no such port any more, so the stand-in
 * for a real executor is a test's own business. A production composition binds
 * Indexing's batch search in the Composition Root and never sees this file.
 *
 * It is written against the same contract the real executor honours: one
 * outcome per requested target in request order, 1-based ranks with no gaps,
 * and at most `limit` chunks. A test written against this is written against
 * the contract rather than against a convenience.
 */
export class FixtureManagedExecutor {
  readonly #chunksByScopeId: Readonly<Record<string, readonly FixtureChunk[]>>;
  readonly #failure: ManagedResolutionFailure;

  constructor(
    chunksByScopeId: Readonly<Record<string, readonly FixtureChunk[]>>,
    /**
     * What an unregistered Scope answers with.
     *
     * `scope_not_published` rather than an invented code: it is the reading a
     * real search gives to "what the Card points at is not published", and a
     * fixture that answered with a code no executor produces would let a test
     * pass against a vocabulary nothing real speaks.
     */
    failure: ManagedResolutionFailure = {
      stage: "managed_search",
      code: "scope_not_published",
      retriable: false,
    },
  ) {
    this.#chunksByScopeId = { ...chunksByScopeId };
    this.#failure = failure;
  }

  execute(
    queryText: string,
    targets: readonly ManagedDocumentResolutionTarget[],
  ): readonly ManagedResolutionOutcome[] {
    return targets.map((target): ManagedResolutionOutcome => {
      const scopeId = target.scopeRef.scopeId;
      // `Object.hasOwn` rather than a truthiness check, so a Scope registered
      // with an empty chunk list reads as published-and-empty instead of
      // missing: the two are different outcomes and a test needs both.
      if (!Object.hasOwn(this.#chunksByScopeId, scopeId)) {
        return {
          targetKey: target.targetKey,
          status: "failed",
          failure: this.#failure,
        };
      }
      return {
        targetKey: target.targetKey,
        status: "fulfilled",
        chunks: rank(this.#chunksByScopeId[scopeId] ?? [], queryText, target.limit),
      };
    });
  }
}

/**
 * A chunk as a fixture declares it: everything a resolved chunk carries except
 * the rank, because a rank is a property of one query's answer, not of a chunk.
 */
export type FixtureChunk = Omit<ResolvedDocumentChunk, "rank">;

/**
 * Orders the chunks a Scope holds and stamps 1-based ranks on the survivors.
 *
 * Similarity is character-bigram Jaccard, implemented privately in this file.
 * It intentionally duplicates the same idea in `domain/query-scoring.ts`: a
 * fixture standing in for a vector store must not pin the domain's scoring
 * rules, and the two are free to diverge. The similarity never leaves this
 * function — a real executor reports positions and withholds provider
 * similarity, so a fixture that leaked a score would let a test depend on
 * something no adapter supplies.
 */
function rank(
  chunks: readonly FixtureChunk[],
  queryText: string,
  limit: number,
): ResolvedDocumentChunk[] {
  if (limit <= 0) {
    return [];
  }

  const queryBigrams = toBigrams(normalizeText(queryText));
  const scored = chunks.map((chunk) => ({
    chunk,
    score: bigramJaccard(queryBigrams, toBigrams(normalizeText(chunk.text))),
  }));

  scored.sort((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    // `<` / `>` rather than `localeCompare`, which resolves against the runtime
    // locale and would let the same query rank differently on two machines.
    if (left.chunk.chunkRevisionId < right.chunk.chunkRevisionId) {
      return -1;
    }
    return left.chunk.chunkRevisionId > right.chunk.chunkRevisionId ? 1 : 0;
  });

  return scored
    .slice(0, limit)
    .map(({ chunk }, index) => ({ ...chunk, rank: index + 1 }));
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

/** Jaccard over the two bigram sets; 0 when either side is empty. */
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
