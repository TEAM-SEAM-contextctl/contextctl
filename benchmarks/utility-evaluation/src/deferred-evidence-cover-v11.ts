import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  buildCardSelectionEntry,
  cosineSimilarity,
  rankHybridCandidates,
  scoreCardsAgainstQuery,
  type ApprovedCard,
} from "@contextctl/selection-delivery";

import { buildHybridIndex, retrieveHybrid } from "./baseline.js";
import {
  buildScopeProbeCandidates,
  type ProbedCardInput,
  type ScopeProbeCandidate,
  planDeferredEvidenceCover,
  DEFERRED_EVIDENCE_CANDIDATE_BOUNDS,
  DEFERRED_EVIDENCE_COVER_CONFIGURATION,
  DEFERRED_EVIDENCE_COVER_POLICY_DIGEST,
  DEFERRED_EVIDENCE_COVER_POLICY_VERSION,
} from "./deferred-evidence-cover-v11-policy.js";
import {
  applyDatasetPolicy,
  assertIndependentBlind,
  resolveCandidateEvaluationPlan,
  type CandidateEvidenceRole,
} from "./deferred-evidence-cover-v11-blind.js";
import { readConfiguration } from "./config.js";
import { corpusDigest, readEvaluationDataset } from "./dataset.js";
import { createEvaluationEmbedders } from "./embedding.js";
import { observePath, summarizePath } from "./metrics.js";
import { prepareProduct, startProductServer } from "./product.js";
import { readPublishedCorpus } from "./qdrant.js";
import type {
  EvaluationDataset,
  PathObservation,
  ProductChunk,
  RetrievedChunk,
  SelectionExpectation,
} from "./types.js";

const execFileAsync = promisify(execFile);

await main();

interface CandidateQueryResult {
  readonly id: string;
  readonly expectedAnswerable: boolean;
  readonly selectionExpectation: SelectionExpectation;
  readonly hybridRag: PathObservation;
  readonly currentProduct: PathObservation;
  readonly candidate: PathObservation;
  readonly executable: boolean;
  readonly deterministic: boolean;
  readonly probedRelevantChunkRecall: number | undefined;
  readonly selectedCards: readonly {
    readonly cardId: string;
    readonly versionId: string;
    readonly description: string;
  }[];
  readonly candidateCards: readonly {
    readonly cardId: string;
    readonly versionId: string;
    readonly description: string;
  }[];
  readonly routedCards: readonly {
    readonly cardId: string;
    readonly versionId: string;
    readonly description: string;
  }[];
  readonly disposition: "admit" | "defer" | "reject";
  readonly audit: ReturnType<typeof planDeferredEvidenceCover>["audit"];
}

async function main(): Promise<void> {
  const configuration = readConfiguration([]);
  const evaluationPlan = resolveCandidateEvaluationPlan(configuration);
  const datasets: {
    readonly split: EvaluationDataset["split"];
    readonly dataset: EvaluationDataset;
    readonly evidenceRole: CandidateEvidenceRole;
  }[] = await Promise.all(
    evaluationPlan.datasets.map(async (specification) => ({
      split: specification.split,
      dataset: await readEvaluationDataset({
        path: specification.fixturePath,
        expectedSplit: specification.split,
        corpusDirectory: specification.corpusDirectory,
      }),
      evidenceRole: specification.evidenceRole,
    })),
  );
  const expectedCorpus = await corpusDigest(evaluationPlan.sourceCorpusDirectory);
  const policySourceSha256 = await sha256File(
    join(
      configuration.benchmarkDirectory,
      "src",
      "deferred-evidence-cover-v11-policy.ts",
    ),
  );
  if (evaluationPlan.blind) {
    for (const { dataset } of datasets) {
      assertIndependentBlind({
        dataset,
        corpusSha256: expectedCorpus.sha256,
        policyDigest: DEFERRED_EVIDENCE_COVER_POLICY_DIGEST,
        policySourceSha256,
      });
    }
  }
  const product = await prepareProduct(configuration, {
    ...(evaluationPlan.blind
      ? { sourceCorpusDirectory: evaluationPlan.sourceCorpusDirectory }
      : {}),
  });
  const actualCorpus = await corpusDigest(product.corpusDirectory);
  if (actualCorpus.sha256 !== expectedCorpus.sha256) {
    throw new Error("prepared product corpus differs from the fixture corpus");
  }
  const corpus = await readPublishedCorpus({
    qdrant: {
      url: required(configuration.qdrantUrl, "Qdrant URL"),
      ...(configuration.qdrantApiKey === undefined
        ? {}
        : { apiKey: configuration.qdrantApiKey }),
    },
    stateNamespaceId: configuration.stateNamespaceId,
    securityDomain: configuration.securityDomain,
  });
  const embedders = await createEvaluationEmbedders(
    required(configuration.embeddingAssetDirectory, "embedding assets"),
  );
  const cardVectors = await embedders.card.embedMany(
    product.approvedCards.map((card) => ({
      key: card.versionId,
      text: buildCardSelectionEntry(card).payload,
    })),
  );
  const sentenceViews = await prepareSentenceViews(
    corpus.chunks,
    embedders.documentEvidence,
  );
  const baselineIndex = buildHybridIndex(corpus.chunks);
  const server = await startProductServer({ configuration, product });
  const splits: unknown[] = [];
  try {
    for (const { split, dataset, evidenceRole } of datasets) {
      const policyApplication = applyDatasetPolicy(
        product.approvedCards,
        dataset,
      );
      const eligibleCards = policyApplication.eligible;
      const queries: CandidateQueryResult[] = [];
      for (const [index, fixture] of dataset.queries.entries()) {
        const started = performance.now();
        const [cardQueryVector, documentQueryVector] = await Promise.all([
          embedders.card.embed(fixture.query),
          embedders.document.embed(fixture.query),
        ]);
        const lexical = scoreCardsAgainstQuery(
          fixture.query,
          eligibleCards,
        );
        const lexicalByVersionId = new Map(
          lexical.map((entry) => [entry.versionId, entry.score]),
        );
        const semantic = eligibleCards
          .map((card) => ({
            cardId: card.cardId,
            cardVersionId: card.versionId,
            similarity: cosineSimilarity(
              cardQueryVector,
              requiredVector(cardVectors, card.versionId),
            ),
          }))
          .sort(
            (left, right) =>
              right.similarity - left.similarity ||
              compareText(left.cardVersionId, right.cardVersionId),
          );
        const semanticByVersionId = new Map(
          semantic.map((entry) => [entry.cardVersionId, entry.similarity]),
        );
        const hybridByVersionId = new Map(
          rankHybridCandidates({
            lexical,
            semantic: semantic.slice(0, 32),
            lexicalTopK: 32,
          }).map((entry) => [entry.versionId, entry.score]),
        );
        const candidates = buildScopeProbeCandidates(
          eligibleCards.map((card) => ({
            card,
            lexical: lexicalByVersionId.get(card.versionId) ?? 0,
            semantic: requiredSimilarity(semanticByVersionId, card.versionId),
            hybrid: hybridByVersionId.get(card.versionId) ?? 0,
            lexicalSignals:
              lexical.find((entry) => entry.versionId === card.versionId)
                ?.signals ?? [],
          })),
        );
        const probed = candidates.map((candidate) =>
          probeCandidate({
            candidate,
            chunks: corpus.chunks,
            queryVector: documentQueryVector,
            sentenceViews,
          }),
        );
        const candidate = planDeferredEvidenceCover({
          query: fixture.query,
          cards: probed,
        });
        const reversed = planDeferredEvidenceCover({
          query: fixture.query,
          cards: [...probed]
            .reverse()
            .map((entry) => ({
              ...entry,
              scopes: [...entry.scopes]
                .reverse()
                .map((scope) => ({
                  ...scope,
                  chunks: [...scope.chunks].reverse(),
                })),
            })),
        });
        const candidateChunks = candidate.executable
          ? finalChunks({
              cards: candidate.selectedCards,
              chunks: corpus.chunks,
              queryVector: documentQueryVector,
              topK: configuration.topK,
              maximumCharacters: configuration.maxContextCharacters,
            })
          : [];
        const candidateLatency = performance.now() - started;
        const denseRanking = await corpus.searchDense(
          documentQueryVector,
          configuration.prefetchK,
        );
        const baseline = retrieveHybrid({
          index: baselineIndex,
          chunks: corpus.chunks,
          query: fixture.query,
          denseRanking,
          topK: configuration.topK,
          prefetchK: configuration.prefetchK,
          maxContextCharacters: configuration.maxContextCharacters,
        });
        const current = await server.resolve(
          fixture.query,
          configuration.maxContextCharacters,
        );
        const candidateObservation = observePath({
          path: "selection_candidate",
          fixture,
          chunks: candidateChunks,
          allChunks: corpus.chunks,
          candidateCount: candidates.length,
          cutoff: configuration.topK,
          latencySamplesMs: [candidateLatency],
        });
        queries.push({
          id: fixture.id,
          expectedAnswerable: fixture.expectedAnswerable,
          selectionExpectation: fixture.selectionExpectation,
          hybridRag: observePath({
            path: "hybrid_rag",
            fixture,
            chunks: baseline.chunks,
            allChunks: corpus.chunks,
            candidateCount: baseline.candidateCount,
            cutoff: configuration.topK,
            latencySamplesMs: [0],
          }),
          currentProduct: observePath({
            path: "contextctl",
            fixture,
            chunks: current.chunks,
            allChunks: corpus.chunks,
            candidateCount: current.candidateCount,
            cutoff: configuration.topK,
            latencySamplesMs: [current.latencyMs],
          }),
          candidate: candidateObservation,
          executable: candidate.executable,
          deterministic:
            candidate.audit.auditDigest === reversed.audit.auditDigest,
          probedRelevantChunkRecall:
            fixture.expectedAnswerable ||
            fixture.selectionExpectation.kind === "close_unanswerable"
            ? relevantProbeRecall(fixture.relevantChunkAnchors, probed, corpus.chunks)
            : undefined,
          selectedCards: candidate.selectedCards.map((card) => ({
            cardId: card.cardId,
            versionId: card.versionId,
            description: card.meaning.description,
          })),
          candidateCards: candidates.map(({ card }) => ({
            cardId: card.cardId,
            versionId: card.versionId,
            description: card.meaning.description,
          })),
          routedCards: candidate.routedCards.map((card) => ({
            cardId: card.cardId,
            versionId: card.versionId,
            description: card.meaning.description,
          })),
          disposition: candidate.disposition,
          audit: candidate.audit,
        });
        process.stdout.write(
          `[v11 ${split} ${String(index + 1)}/${String(dataset.queries.length)}] ${fixture.id}\n`,
        );
      }
      const answerable = queries.filter((query) => query.expectedAnswerable);
      const closedWithoutExecution = queries.filter(
        (query) =>
          query.selectionExpectation.kind === "unrelated" ||
          query.selectionExpectation.kind === "forbidden" ||
          query.selectionExpectation.kind === "legacy_unclassified_unanswerable",
      );
      const closeUnanswerable = queries.filter(
        (query) => query.selectionExpectation.kind === "close_unanswerable",
      );
      const forbidden = queries.filter(
        (query) => query.selectionExpectation.kind === "forbidden",
      );
      const routable = [...answerable, ...closeUnanswerable];
      const summary = {
        hybridRag: summarizePath(queries.map((query) => query.hybridRag)),
        currentProduct: summarizePath(
          queries.map((query) => query.currentProduct),
        ),
        candidate: summarizePath(queries.map((query) => query.candidate)),
      };
      const answerableContextReduction = reduction(
        summarizePath(answerable.map((query) => query.hybridRag))
          .meanContextCharacters,
        summarizePath(answerable.map((query) => query.candidate))
          .meanContextCharacters,
      );
      const gates = [
        gate(
          `${split}: first-stage relevant probe recall`,
          mean(routable.map((query) => query.probedRelevantChunkRecall ?? 0)),
          1,
          "= 100%",
        ),
        gate(
          `${split}: answerable fact coverage`,
          mean(
            answerable.map(
              (query) => query.candidate.requiredFactCoverage ?? 0,
            ),
          ),
          1,
          "= 100%",
        ),
        gate(
          `${split}: answerable Chunk recall`,
          mean(
            answerable.map(
              (query) => query.candidate.relevantChunkRecallAtK ?? 0,
            ),
          ),
          1,
          "= 100%",
        ),
        gate(
          `${split}: non-answerable Scope execution closure`,
          mean(
            closedWithoutExecution.map((query) =>
              query.executable ? 0 : 1,
            ),
          ),
          1,
          "= 100%",
        ),
        gate(
          `${split}: close-unanswerable topical routing`,
          mean(
            closeUnanswerable.map((query) =>
              passesCloseRouting(query) ? 1 : 0,
            ),
          ),
          1,
          "= 100%",
        ),
        maximumGate(
          `${split}: close-unanswerable irrelevant context`,
          closeUnanswerable.length === 0
            ? 0
            : mean(
                closeUnanswerable.map(
                  (query) => query.candidate.irrelevantContextRatio,
                ),
              ),
          0.1,
          "<= 10%",
        ),
        gate(
          `${split}: answerable Hybrid RAG context reduction`,
          answerableContextReduction,
          0.65,
          ">= 65%",
        ),
        maximumGate(
          `${split}: candidate latency p95`,
          summary.candidate.latencyP95Ms,
          150,
          "<= 150ms",
        ),
        booleanGate(
          `${split}: deterministic order`,
          queries.every((query) => query.deterministic),
        ),
        ...(forbidden.length === 0
          ? []
          : [
              booleanGate(
                `${split}: forbidden Card pre-score exclusion`,
                forbidden.every(passesForbiddenExclusion),
              ),
            ]),
      ];
      splits.push({
        dataset: {
          split,
          sha256: dataset.sha256,
          queryCount: dataset.queries.length,
          evidenceRole,
          policyExcludedCards: policyApplication.excluded,
          ...(dataset.sealedAt === undefined
            ? {}
            : { sealedAt: dataset.sealedAt }),
          ...(dataset.frozenPolicyDigest === undefined
            ? {}
            : { frozenPolicyDigest: dataset.frozenPolicyDigest }),
          ...(dataset.frozenPolicySourceSha256 === undefined
            ? {}
            : { frozenPolicySourceSha256: dataset.frozenPolicySourceSha256 }),
          ...(dataset.frozenCorpusSha256 === undefined
            ? {}
            : { frozenCorpusSha256: dataset.frozenCorpusSha256 }),
        },
        summary: { ...summary, answerableContextReduction },
        gates,
        queries,
      });
    }
  } finally {
    await server.close();
  }
  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    experiment: "selection-deferred-evidence-cover-candidate-v11",
    commit: await gitCommit(configuration.repositoryRoot),
    contextctlVersion: product.version,
    environment: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      qdrantVersion: corpus.version,
    },
    policy: {
      version: DEFERRED_EVIDENCE_COVER_POLICY_VERSION,
      digest: DEFERRED_EVIDENCE_COVER_POLICY_DIGEST,
      sourceSha256: policySourceSha256,
      configuration: {
        ...DEFERRED_EVIDENCE_COVER_CONFIGURATION,
      },
    },
    profiles: {
      document: {
        id: embedders.document.profileId,
        version: embedders.document.profileVersion,
      },
      card: {
        id: embedders.card.profileId,
        version: embedders.card.profileVersion,
      },
    },
    corpus: {
      sha256: expectedCorpus.sha256,
      cards: product.approvedCards.length,
      chunks: corpus.chunks.length,
    },
    splits,
    decision: splits.every((value) => isPassingSplit(value))
      ? evaluationPlan.blind
        ? "independent_blind_passed_requires_product_promotion"
        : "development_passed_requires_policy_freeze"
      : evaluationPlan.blind
        ? "independent_blind_failed_candidate_rejected"
        : "candidate_requires_revision_before_freeze",
  };
  await mkdir(configuration.resultsDirectory, { recursive: false });
  await writeFile(
    join(configuration.resultsDirectory, "deferred-evidence-cover-v11-result.json"),
    `${JSON.stringify(result, undefined, 2)}\n`,
  );
  process.stdout.write(
    `decision: ${result.decision}\nartifact: ${configuration.resultsDirectory}\n`,
  );
  if (
    result.decision !== "development_passed_requires_policy_freeze" &&
    result.decision !== "independent_blind_passed_requires_product_promotion"
  ) {
    process.exitCode = 2;
  }
}

interface SentenceView {
  readonly key: string;
  readonly vector: readonly number[];
}

function probeCandidate(input: {
  readonly candidate: ScopeProbeCandidate;
  readonly chunks: readonly ProductChunk[];
  readonly queryVector: readonly number[];
  readonly sentenceViews: ReadonlyMap<string, readonly SentenceView[]>;
}): ProbedCardInput {
  const { candidate } = input;
  return {
    candidate,
    scopes: candidate.card.scopes.flatMap((scope) => {
      if (scope.kind !== "managed_document") return [];
      const units =
        scope.selection.kind === "semantic_units"
          ? new Set(scope.selection.semanticUnitIds)
          : undefined;
      const ranked = input.chunks
        .filter(
          (chunk) =>
            chunk.documentId === scope.documentIndex.documentId &&
            (units === undefined || units.has(chunk.semanticUnitId)),
        )
        .map((chunk) => ({
          chunkRevisionId: chunk.chunkRevisionId,
          text: chunk.text,
          score: cosineSimilarity(input.queryVector, chunk.vector),
        }))
        .sort(
          (left, right) =>
            right.score - left.score ||
            compareText(left.chunkRevisionId, right.chunkRevisionId),
        )
        .slice(0, DEFERRED_EVIDENCE_CANDIDATE_BOUNDS.probeChunksPerScope)
        .map(({ chunkRevisionId, text, score }, index) => {
          const views = input.sentenceViews.get(chunkRevisionId) ?? [];
          return {
            chunkRevisionId,
            text,
            rank: index + 1,
            similarity: score,
            sentenceSimilarity: maxSimilarity(input.queryVector, views),
          };
        });
      return [
        {
          scopeId: scope.reference.scopeId,
          scopeVersion: scope.reference.scopeVersion,
          chunks: ranked,
        },
      ];
    }),
  };
}

async function prepareSentenceViews(
  chunks: readonly ProductChunk[],
  embedder: import("./embedding.js").BatchEmbedder,
): Promise<ReadonlyMap<string, readonly SentenceView[]>> {
  const segmenter = new Intl.Segmenter("und", { granularity: "sentence" });
  const fragments = chunks.flatMap((chunk) => {
    const sentences = [...segmenter.segment(chunk.text)]
      .map((entry) => entry.segment.trim())
      .filter((value) => value !== "");
    const values = sentences.length === 0 ? [chunk.text.trim()] : sentences;
    return values.map((text, index) => ({
      chunkRevisionId: chunk.chunkRevisionId,
      key: `sentence:${chunk.chunkRevisionId}:${String(index)}`,
      text,
    }));
  });
  const vectors = await embedder.embedMany(
    fragments.map(({ key, text }) => ({ key, text })),
  );
  const byChunk = new Map<string, SentenceView[]>();
  for (const fragment of fragments) {
    const values = byChunk.get(fragment.chunkRevisionId) ?? [];
    values.push({
      key: fragment.key,
      vector: requiredVector(vectors, fragment.key),
    });
    byChunk.set(fragment.chunkRevisionId, values);
  }
  return new Map(
    [...byChunk].map(([chunkRevisionId, views]) => [
      chunkRevisionId,
      views.sort((left, right) => compareText(left.key, right.key)),
    ]),
  );
}

function maxSimilarity(
  query: readonly number[],
  views: readonly SentenceView[],
): number {
  return views.reduce(
    (maximum, view) => Math.max(maximum, cosineSimilarity(query, view.vector)),
    -1,
  );
}

function finalChunks(input: {
  readonly cards: readonly ApprovedCard[];
  readonly chunks: readonly ProductChunk[];
  readonly queryVector: readonly number[];
  readonly topK: number;
  readonly maximumCharacters: number;
}): readonly RetrievedChunk[] {
  const allowed = allowedChunkRevisions(input.cards, input.chunks);
  const ranked = input.chunks
    .filter((chunk) => allowed.has(chunk.chunkRevisionId))
    .map((chunk) => ({
      ...chunk,
      score: cosineSimilarity(input.queryVector, chunk.vector),
      scoreKind: "product" as const,
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        compareText(left.chunkRevisionId, right.chunkRevisionId),
    );
  const selected: RetrievedChunk[] = [];
  let characters = 0;
  for (const chunk of ranked) {
    if (selected.length >= input.topK) break;
    if (characters + chunk.text.length > input.maximumCharacters) continue;
    selected.push(chunk);
    characters += chunk.text.length;
  }
  return selected;
}

function allowedChunkRevisions(
  cards: readonly ApprovedCard[],
  chunks: readonly ProductChunk[],
): ReadonlySet<string> {
  const allowed = new Set<string>();
  for (const card of cards) {
    for (const scope of card.scopes) {
      if (scope.kind !== "managed_document") continue;
      const units =
        scope.selection.kind === "semantic_units"
          ? new Set(scope.selection.semanticUnitIds)
          : undefined;
      for (const chunk of chunks) {
        if (
          chunk.documentId === scope.documentIndex.documentId &&
          (units === undefined || units.has(chunk.semanticUnitId))
        ) {
          allowed.add(chunk.chunkRevisionId);
        }
      }
    }
  }
  return allowed;
}

function relevantProbeRecall(
  anchors: readonly string[],
  cards: readonly ProbedCardInput[],
  allChunks: readonly ProductChunk[],
): number {
  const relevant = new Set(
    allChunks
      .filter((chunk) => anchors.some((anchor) => chunk.text.includes(anchor)))
      .map((chunk) => chunk.chunkRevisionId),
  );
  if (relevant.size === 0) return 0;
  const probed = new Set(
    cards.flatMap((card) =>
      card.scopes.flatMap((scope) =>
        scope.chunks.map((chunk) => chunk.chunkRevisionId),
      ),
    ),
  );
  return (
    [...relevant].filter((revision) => probed.has(revision)).length /
    relevant.size
  );
}

function gate(
  name: string,
  actual: number,
  expected: number,
  expectation: string,
): {
  readonly name: string;
  readonly passed: boolean;
  readonly actual: number;
  readonly expected: string;
} {
  return { name, passed: actual >= expected, actual, expected: expectation };
}

function maximumGate(
  name: string,
  actual: number,
  expected: number,
  expectation: string,
): {
  readonly name: string;
  readonly passed: boolean;
  readonly actual: number;
  readonly expected: string;
} {
  return { name, passed: actual <= expected, actual, expected: expectation };
}

function passesCloseRouting(query: CandidateQueryResult): boolean {
  const allowed = new Set(
    query.selectionExpectation.allowedCardDescriptions,
  );
  const routed = query.executable ? query.selectedCards : query.routedCards;
  return (
    routed.length > 0 &&
    routed.every((card) => allowed.has(card.description)) &&
    (query.executable || query.candidate.chunks.length === 0)
  );
}

function passesForbiddenExclusion(query: CandidateQueryResult): boolean {
  const forbidden = new Set(
    query.selectionExpectation.forbiddenCardDescriptions,
  );
  return [...query.candidateCards, ...query.routedCards, ...query.selectedCards]
    .every((card) => !forbidden.has(card.description));
}

function booleanGate(name: string, actual: boolean) {
  return { name, passed: actual, actual, expected: "true" };
}

function isPassingSplit(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value["gates"])) return false;
  return value["gates"].every(
    (gateValue) => isRecord(gateValue) && gateValue["passed"] === true,
  );
}

function requiredVector(
  vectors: ReadonlyMap<string, readonly number[]>,
  key: string,
): readonly number[] {
  const vector = vectors.get(key);
  if (vector === undefined) throw new Error(`missing embedding vector: ${key}`);
  return vector;
}

function requiredSimilarity(
  similarities: ReadonlyMap<string, number>,
  versionId: string,
): number {
  const similarity = similarities.get(versionId);
  if (similarity === undefined) {
    throw new Error(`missing Card similarity: ${versionId}`);
  }
  return similarity;
}

function required(value: string | undefined, label: string): string {
  if (value === undefined) throw new Error(`missing ${label}`);
  return value;
}

function mean(values: readonly number[]): number {
  return values.length === 0
    ? 1
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function reduction(baseline: number, candidate: number): number {
  return baseline === 0 ? 0 : 1 - candidate / baseline;
}

async function gitCommit(root: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: root,
  });
  return stdout.trim();
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
