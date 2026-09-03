import { describe, expect, it } from "vitest";

import type { ApprovedCard } from "@contextctl/selection-delivery";

import {
  applyDatasetPolicy,
  assertIndependentBlind,
  resolveCandidateEvaluationPlan,
} from "../src/deferred-evidence-cover-v11-blind.js";
import type { EvaluationConfiguration } from "../src/config.js";
import type { EvaluationDataset, QueryFixture } from "../src/types.js";

describe("deferred evidence cover v11 blind boundary", () => {
  it("requires the blind fixture and corpus as one sealed input", () => {
    expect(() =>
      resolveCandidateEvaluationPlan(configuration(), {
        CONTEXTCTL_DEFERRED_V11_BLIND_FIXTURE: "/tmp/blind.json",
      }),
    ).toThrow(/must be set together/u);

    const plan = resolveCandidateEvaluationPlan(configuration(), {
      CONTEXTCTL_DEFERRED_V11_BLIND_FIXTURE: "/tmp/blind.json",
      CONTEXTCTL_DEFERRED_V11_BLIND_CORPUS_DIRECTORY: "/tmp/blind-corpus",
    });
    expect(plan.blind).toBe(true);
    expect(plan.datasets).toEqual([
      {
        split: "shadow",
        fixturePath: "/tmp/blind.json",
        corpusDirectory: "/tmp/blind-corpus",
        evidenceRole: "independent_blind",
      },
    ]);
  });

  it("refuses a blind whose policy, corpus, or required strata were not sealed", () => {
    const dataset = blindDataset();
    expect(() =>
      assertIndependentBlind({
        dataset,
        corpusSha256: "b".repeat(64),
        policyDigest: `sha256:${"a".repeat(64)}`,
        policySourceSha256: "c".repeat(64),
      }),
    ).not.toThrow();
    expect(() =>
      assertIndependentBlind({
        dataset,
        corpusSha256: "d".repeat(64),
        policyDigest: `sha256:${"a".repeat(64)}`,
        policySourceSha256: "c".repeat(64),
      }),
    ).toThrow(/corpus digest/u);
  });

  it("removes forbidden Cards before they reach candidate scoring", () => {
    const dataset = {
      ...blindDataset(),
      queries: [query("forbidden", "forbidden", "forbidden-card")],
      catalogPolicyOverrides: [
        {
          cardDescription: "forbidden-card",
          sensitive: true,
          allowedUsage: ["retrieval"],
        },
      ],
    } satisfies EvaluationDataset;
    const application = applyDatasetPolicy(
      [card("public-card"), card("forbidden-card")],
      dataset,
    );

    expect(
      application.eligible.map((value) => value.meaning.description),
    ).toEqual(["public-card"]);
    expect(application.excluded).toHaveLength(1);
  });
});

function configuration(): EvaluationConfiguration {
  return {
    validateOnly: false,
    split: "holdout",
    repositoryRoot: "/repo",
    benchmarkDirectory: "/repo/benchmarks/utility-evaluation",
    corpusDirectory: "/repo/apps/contextctl-daemon/demo/docs",
    fixturePath: "/repo/benchmarks/utility-evaluation/fixtures/holdout.json",
    resultsDirectory: "/tmp/results",
    workDirectory: "/tmp/work",
    runId: "test",
    httpPort: 18_080,
    repetitions: 1,
    topK: 5,
    prefetchK: 20,
    maxContextCharacters: 8_000,
    stateNamespaceId: "test",
    securityDomain: "test",
    command: { file: "node", prefixArguments: [], source: "workspace" },
  };
}

function blindDataset(): EvaluationDataset {
  return {
    split: "shadow",
    sealedAt: "2026-09-03T00:00:00.000Z",
    sha256: "f".repeat(64),
    frozenPolicyDigest: `sha256:${"a".repeat(64)}`,
    frozenPolicySourceSha256: "c".repeat(64),
    frozenCorpusSha256: "b".repeat(64),
    catalogPolicyOverrides: [],
    queries: [
      ...queries("single_scope_answerable", "answerable", 6),
      ...queries("multi_scope_answerable", "answerable", 6),
      ...queries("adjacent_section", "answerable", 4),
      ...queries("close_unanswerable", "close_unanswerable", 6),
      ...queries("unrelated", "unrelated", 4),
      ...queries("forbidden", "forbidden", 4, "forbidden-card"),
    ],
  };
}

function queries(
  category: string,
  kind: QueryFixture["selectionExpectation"]["kind"],
  count: number,
  forbiddenCardDescription?: string,
): readonly QueryFixture[] {
  return Array.from({ length: count }, (_, index) =>
    query(`${category}-${String(index)}`, kind, forbiddenCardDescription, category),
  );
}

function query(
  id: string,
  kind: QueryFixture["selectionExpectation"]["kind"],
  forbiddenCardDescription?: string,
  category = id,
): QueryFixture {
  const answerable = kind === "answerable";
  return {
    id,
    category,
    query: id,
    expectedAnswerable: answerable,
    requiredFacts: answerable ? [id] : [],
    relevantChunkAnchors:
      answerable || kind === "close_unanswerable" ? [id] : [],
    selectionExpectation: {
      kind,
      allowedCardDescriptions: kind === "close_unanswerable" ? [id] : [],
      forbiddenCardDescriptions:
        kind === "forbidden" && forbiddenCardDescription !== undefined
          ? [forbiddenCardDescription]
          : [],
    },
  };
}

function card(description: string): ApprovedCard {
  return {
    cardId: description,
    versionId: `${description}-v1`,
    meaning: {
      description,
      representativeQuestions: [description],
      aliases: [description],
      keywords: [description],
    },
    policy: { sensitive: false, allowedUsage: ["retrieval"] },
    scopes: [],
  };
}
