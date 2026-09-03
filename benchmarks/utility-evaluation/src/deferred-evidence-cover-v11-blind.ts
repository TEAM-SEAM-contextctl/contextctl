import { resolve } from "node:path";

import {
  applyPolicyContext,
  DEFAULT_POLICY_CONTEXT,
  type ApprovedCard,
  type PolicyApplication,
} from "@contextctl/selection-delivery";

import type { EvaluationConfiguration } from "./config.js";
import type { EvaluationDataset, EvaluationSplit } from "./types.js";

export type CandidateEvidenceRole = "development_only" | "independent_blind";

export interface CandidateDatasetSpec {
  readonly split: EvaluationSplit;
  readonly fixturePath: string;
  readonly corpusDirectory: string;
  readonly evidenceRole: CandidateEvidenceRole;
}

export interface CandidateEvaluationPlan {
  readonly blind: boolean;
  readonly sourceCorpusDirectory: string;
  readonly datasets: readonly CandidateDatasetSpec[];
}

const BLIND_FIXTURE_VARIABLE =
  "CONTEXTCTL_DEFERRED_V11_BLIND_FIXTURE" as const;
const BLIND_CORPUS_VARIABLE =
  "CONTEXTCTL_DEFERRED_V11_BLIND_CORPUS_DIRECTORY" as const;
const DIAGNOSTIC_FIXTURE_VARIABLE =
  "CONTEXTCTL_DEFERRED_V11_DIAGNOSTIC_FIXTURE" as const;

export function resolveCandidateEvaluationPlan(
  configuration: EvaluationConfiguration,
  environment: NodeJS.ProcessEnv = process.env,
): CandidateEvaluationPlan {
  const blindFixture = nonEmpty(environment[BLIND_FIXTURE_VARIABLE]);
  const blindCorpus = nonEmpty(environment[BLIND_CORPUS_VARIABLE]);
  const diagnosticFixture = nonEmpty(environment[DIAGNOSTIC_FIXTURE_VARIABLE]);
  if ((blindFixture === undefined) !== (blindCorpus === undefined)) {
    throw new Error(
      `${BLIND_FIXTURE_VARIABLE} and ${BLIND_CORPUS_VARIABLE} must be set together`,
    );
  }
  if (blindFixture !== undefined && diagnosticFixture !== undefined) {
    throw new Error(
      `${DIAGNOSTIC_FIXTURE_VARIABLE} cannot be combined with blind mode`,
    );
  }
  if (blindFixture !== undefined && blindCorpus !== undefined) {
    const sourceCorpusDirectory = resolve(blindCorpus);
    if (sourceCorpusDirectory === resolve(configuration.corpusDirectory)) {
      throw new Error("blind corpus must differ from the public demo corpus");
    }
    return {
      blind: true,
      sourceCorpusDirectory,
      datasets: [
        {
          split: "shadow",
          fixturePath: resolve(blindFixture),
          corpusDirectory: sourceCorpusDirectory,
          evidenceRole: "independent_blind",
        },
      ],
    };
  }
  return {
    blind: false,
    sourceCorpusDirectory: configuration.corpusDirectory,
    datasets: [
      ...(["development", "holdout"] as const).map((split) => ({
        split,
        fixturePath: resolve(
          configuration.benchmarkDirectory,
          "fixtures",
          `${split}.json`,
        ),
        corpusDirectory: configuration.corpusDirectory,
        evidenceRole: "development_only" as const,
      })),
      ...(diagnosticFixture === undefined
        ? []
        : [
            {
              split: "shadow" as const,
              fixturePath: resolve(diagnosticFixture),
              corpusDirectory: configuration.corpusDirectory,
              evidenceRole: "development_only" as const,
            },
          ]),
    ],
  };
}

export function assertIndependentBlind(input: {
  readonly dataset: EvaluationDataset;
  readonly corpusSha256: string;
  readonly policyDigest: string;
  readonly policySourceSha256: string;
}): void {
  const { dataset } = input;
  if (dataset.split !== "shadow" || dataset.queries.length < 30) {
    throw new Error(
      "independent blind must be a shadow fixture with at least 30 queries",
    );
  }
  if (dataset.frozenPolicyDigest !== input.policyDigest) {
    throw new Error("blind fixture was not sealed against this policy digest");
  }
  if (dataset.frozenPolicySourceSha256 !== input.policySourceSha256) {
    throw new Error("blind fixture was not sealed against this policy source");
  }
  if (dataset.frozenCorpusSha256 !== input.corpusSha256) {
    throw new Error("blind fixture corpus digest does not match the supplied corpus");
  }

  requireCases(dataset, "single_scope_answerable", "answerable", 6);
  requireCases(dataset, "multi_scope_answerable", "answerable", 6);
  requireCases(dataset, "adjacent_section", "answerable", 4);
  requireCases(dataset, "close_unanswerable", "close_unanswerable", 6);
  requireCases(dataset, "unrelated", "unrelated", 4);
  requireCases(dataset, "forbidden", "forbidden", 4);
}

export function applyDatasetPolicy(
  cards: readonly ApprovedCard[],
  dataset: EvaluationDataset,
): PolicyApplication {
  const overrides = new Map(
    dataset.catalogPolicyOverrides.map((entry) => [
      entry.cardDescription,
      entry,
    ]),
  );
  for (const description of overrides.keys()) {
    const matches = cards.filter(
      (card) => card.meaning.description === description,
    );
    if (matches.length === 0) {
      throw new Error(`policy override names an unknown Card: ${description}`);
    }
    if (matches.length > 1) {
      throw new Error(`policy override is ambiguous: ${description}`);
    }
  }
  const catalog = cards.map((card): ApprovedCard => {
    const override = overrides.get(card.meaning.description);
    return override === undefined
      ? card
      : {
          ...card,
          policy: {
            sensitive: override.sensitive,
            allowedUsage: override.allowedUsage,
          },
        };
  });
  const application = applyPolicyContext(catalog, DEFAULT_POLICY_CONTEXT);
  const excludedDescriptions = new Set(
    application.excluded.map((entry) => {
      const card = catalog.find((value) => value.versionId === entry.versionId);
      if (card === undefined) {
        throw new Error(`excluded Card is absent: ${entry.versionId}`);
      }
      return card.meaning.description;
    }),
  );
  for (const query of dataset.queries) {
    for (const description of query.selectionExpectation
      .forbiddenCardDescriptions) {
      if (!excludedDescriptions.has(description)) {
        throw new Error(
          `forbidden query ${query.id} names a Card not excluded by PolicyContext: ${description}`,
        );
      }
    }
  }
  return application;
}

function requireCases(
  dataset: EvaluationDataset,
  category: string,
  expectation: EvaluationDataset["queries"][number]["selectionExpectation"]["kind"],
  minimum: number,
): void {
  const count = dataset.queries.filter(
    (query) =>
      query.category === category &&
      query.selectionExpectation.kind === expectation,
  ).length;
  if (count < minimum) {
    throw new Error(
      `independent blind needs at least ${String(minimum)} ${category} queries; found ${String(count)}`,
    );
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === "" ? undefined : normalized;
}
