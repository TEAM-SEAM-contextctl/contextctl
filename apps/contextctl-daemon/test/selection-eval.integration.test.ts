import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";

import { DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE } from "@contextctl/ingestion-indexing";
import {
  buildCardSelectionEntry,
  CARD_SELECTION_EMBEDDING_PROFILE,
  catalogSnapshotVersion,
  DEFAULT_SELECTION_THRESHOLDS,
  HYBRID_SCORING_POLICY_VERSION,
  InMemoryCardCandidateIndexStore,
  type LocalCardEmbeddingInferenceResource,
  normalizeSelectionText,
  rankHybridCandidates,
  QUERY_SCORING_POLICY_VERSION,
  scoreCardsAgainstQuery,
  TransformersJsLocalCardEmbeddingAdapter,
} from "@contextctl/selection-delivery";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  evaluateSelection,
  selectionEvalGate,
  type SelectionEvalReport,
} from "../../../packages/selection-delivery/test/fixtures/selection-eval.js";
import {
  SELECTION_EVAL_CARDS,
  SELECTION_EVAL_DATASET_DIGEST,
  SELECTION_EVAL_SPLIT_DIGEST,
} from "../../../packages/selection-delivery/test/fixtures/selection-eval-v1.js";
import { WorkerThreadLocalEmbeddingInferenceResource } from "../src/runtime/worker-thread-local-embedding-inference-resource.js";

const artifactDirectory = process.env.CONTEXTCTL_GRANITE_ASSET_DIRECTORY;
const resultPath = process.env.CONTEXTCTL_SELECTION_EVAL_RESULT_PATH;

describe.skipIf(artifactDirectory === undefined)("selection-eval-v1 · Granite fp32", () => {
  let resource: WorkerThreadLocalEmbeddingInferenceResource;
  let lexical: SelectionEvalReport;
  let hybrid: SelectionEvalReport;

  beforeAll(async () => {
    resource = new WorkerThreadLocalEmbeddingInferenceResource({
      artifactDirectory: artifactDirectory!,
      profile: DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
    });
    await resource.ready();
    if (CARD_SELECTION_EMBEDDING_PROFILE.execution.kind !== "local") {
      throw new Error("the production Card profile must be local");
    }
    const cardResource: LocalCardEmbeddingInferenceResource = {
      execution: CARD_SELECTION_EMBEDDING_PROFILE.execution,
      modelMaxTokens: resource.modelMaxTokens,
      tokenCount: async (text) => await resource.tokenCount(text),
      tokenCounts: async (texts) => await resource.tokenCounts(texts),
      embed: async (texts, options) => await resource.embed(texts, options),
    };
    const embedding = new TransformersJsLocalCardEmbeddingAdapter({
      inferenceResource: cardResource,
      profile: CARD_SELECTION_EMBEDDING_PROFILE,
    });
    const entries = SELECTION_EVAL_CARDS.map(buildCardSelectionEntry);
    const snapshot = catalogSnapshotVersion(entries, CARD_SELECTION_EMBEDDING_PROFILE);
    const index = await new InMemoryCardCandidateIndexStore().acquire({
      entries,
      catalogSnapshotVersion: snapshot,
      profile: CARD_SELECTION_EMBEDDING_PROFILE,
      embedding,
    });

    lexical = await evaluateSelection(async (query) => {
      const started = performance.now();
      const candidates = scoreCardsAgainstQuery(query, SELECTION_EVAL_CARDS);
      return { candidates, elapsedMs: performance.now() - started, embeddingCalls: 0 };
    });
    hybrid = await evaluateSelection(async (query) => {
      const started = performance.now();
      const lexicalCandidates = scoreCardsAgainstQuery(query, SELECTION_EVAL_CARDS);
      const output = await embedding.embed({
        profile: CARD_SELECTION_EMBEDDING_PROFILE,
        inputs: [{ key: "query", text: normalizeSelectionText(query) }],
      });
      const vector = output[0]?.vector;
      if (vector === undefined) throw new Error("Granite omitted the query vector");
      const semantic = index.topK(vector, 32);
      const candidates = rankHybridCandidates({
        lexical: lexicalCandidates,
        semantic,
        lexicalTopK: 32,
      });
      return { candidates, elapsedMs: performance.now() - started, embeddingCalls: 1 };
    });
    if (resultPath !== undefined) {
      const gate = selectionEvalGate(lexical, hybrid);
      await writeFile(
        resultPath,
        `${JSON.stringify({
          benchmarkId: "selection-eval-v1",
          datasetDigest: SELECTION_EVAL_DATASET_DIGEST,
          splitDigest: SELECTION_EVAL_SPLIT_DIGEST,
          profile: {
            id: CARD_SELECTION_EMBEDDING_PROFILE.id,
            version: CARD_SELECTION_EMBEDDING_PROFILE.version,
            model: CARD_SELECTION_EMBEDDING_PROFILE.model,
          },
          policy: {
            lexical: QUERY_SCORING_POLICY_VERSION,
            hybrid: HYBRID_SCORING_POLICY_VERSION,
            thresholds: DEFAULT_SELECTION_THRESHOLDS,
          },
          runtime: {
            node: process.version,
            platform: process.platform,
            architecture: process.arch,
          },
          lexical: lexical.holdout,
          hybrid: hybrid.holdout,
          cases: hybrid.cases,
          gate,
        }, null, 2)}\n`,
        "utf8",
      );
    }
  }, 120_000);

  afterAll(async () => {
    await resource?.close();
  });

  it("passes the frozen holdout quality gate", () => {
    const gate = selectionEvalGate(lexical, hybrid);
    expect(hybrid.cases.filter((entry) => entry.forbiddenAdmits.length > 0)).toEqual([]);
    expect(gate.failures).toEqual([]);
    expect(gate.passed).toBe(true);
  });

  it("reports reproducible input and split identities", () => {
    expect(SELECTION_EVAL_DATASET_DIGEST).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(SELECTION_EVAL_SPLIT_DIGEST).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(hybrid.holdout.queryCount).toBe(20);
    expect(hybrid.holdout.maxEmbeddingCallsPerQuery).toBe(1);
  });
});
