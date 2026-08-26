import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { InMemoryVectorIndexAdapter } from "@contextctl/ingestion-indexing";
import { approveCardVersion } from "@contextctl/registry-lifecycle";
import {
  buildCardSelectionEntry,
  catalogSnapshotVersion,
  InMemoryCardCandidateIndexStore,
  normalizeSelectionText,
  rankHybridCandidates,
  scoreCardsAgainstQuery,
  type ApprovedCard,
} from "@contextctl/selection-delivery";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDaemonRuntime, type DaemonRuntime } from "../src/main.js";
import { GENERATED_CARD_SELECTION_CASES } from "./fixtures/generated-card-selection-v1.js";
import {
  SELECTION_GENERALIZATION_CALIBRATION_CASES,
  SELECTION_GENERALIZATION_CASES,
  SELECTION_GENERALIZATION_HOLDOUT_CASES,
  type SelectionGeneralizationSplit,
} from "./fixtures/selection-generalization-v1.js";

const artifactDirectory = process.env.CONTEXTCTL_GRANITE_ASSET_DIRECTORY;
const resultPath = process.env.CONTEXTCTL_GENERATED_CARD_SELECTION_RESULT_PATH;
const DOCUMENTS = ["expense.md", "leave.md", "payment.md", "refund.md", "shipping.md"] as const;

interface CardRecord {
  readonly cardId: string;
  readonly document: string;
  readonly aliases: readonly string[];
}

interface CaseResult {
  readonly id: string;
  readonly expectedCardIds: readonly string[];
  readonly admittedCardIds: readonly string[];
  readonly passed: boolean;
}

interface GeneralizationCaseResult extends CaseResult {
  readonly split: SelectionGeneralizationSplit;
}

interface GrowthResult {
  readonly catalogSize: number;
  readonly changedBaseScoreCount: number;
  readonly changedAdmissionCount: number;
  readonly passed: boolean;
  readonly cases?: readonly {
    readonly id: string;
    readonly leadingSemanticCardId: string | undefined;
    readonly leadingSemanticSimilarity: number | undefined;
    readonly expected: readonly {
      readonly cardId: string;
      readonly lexicalScore: number;
      readonly semanticSimilarity: number | undefined;
      readonly semanticScore: number;
      readonly score: number;
      readonly signals: readonly {
        readonly field: string;
        readonly matched: string;
        readonly contribution: number;
      }[];
    }[];
    readonly top: readonly {
      readonly cardId: string;
      readonly lexicalScore: number;
      readonly semanticSimilarity: number | undefined;
      readonly semanticScore: number;
      readonly score: number;
      readonly signals: readonly {
        readonly field: string;
        readonly matched: string;
        readonly contribution: number;
      }[];
    }[];
  }[];
}

describe.skipIf(artifactDirectory === undefined || resultPath === undefined)(
  "generated-card-selection-v1 · Granite fp32",
  () => {
    let runtime: DaemonRuntime;
    let cardRecords: readonly CardRecord[];
    let results: readonly CaseResult[];
    let generalizationResults: readonly GeneralizationCaseResult[];
    let growthResults: readonly GrowthResult[];

    beforeAll(async () => {
      const sourceConfigurations = Object.fromEntries(
        DOCUMENTS.map((document) => [
          sourceReference(document),
          { path: fileURLToPath(new URL(`../demo/docs/${document}`, import.meta.url)) },
        ]),
      );
      runtime = createDaemonRuntime({
        embeddingArtifactDirectory: artifactDirectory!,
        // This Gate measures Publication facts, Registry generation and Card
        // selection. Qdrant durability is exercised by its own required job;
        // replacing only document-vector storage keeps this test isolated from
        // an infrastructure dependency that cannot change the generated Card.
        vectorIndex: new InMemoryVectorIndexAdapter(),
        sourceConfigurations,
      });

      const collected: CardRecord[] = [];
      let decisionSequence = 0;
      for (const document of DOCUMENTS) {
        const published = await runtime.ingestion.workflow.publish({
          source: {
            sourceType: "markdown",
            displayName: document,
            configReference: sourceReference(document),
            polling: { enabled: false },
          },
          connectorId: runtime.connectorId,
          securityDomain: runtime.securityDomain,
        });
        const publicationId = published.publication?.publicationId;
        if (publicationId === undefined) {
          throw new Error(`${document} produced no Publication`);
        }
        const claimed = await runtime.registryIntake.claim(publicationId);
        if (claimed.status !== "claimed") {
          throw new Error(`${document} claim returned ${claimed.status}`);
        }
        for (const intaken of claimed.cardVersions) {
          const card = await runtime.cards.findCard(intaken.cardId);
          const version = card?.versions.versions.find(
            (candidate) => candidate.id === intaken.versionId,
          );
          if (version?.meaning === undefined) {
            throw new Error(`missing generated meaning for ${intaken.versionId}`);
          }
          collected.push({
            cardId: intaken.cardId,
            document,
            aliases: version.meaning.aliases,
          });
          decisionSequence += 1;
          await approveCardVersion(
            {
              cards: runtime.cards,
              clock: { now: () => "2026-08-25T00:00:00.000Z" },
              ids: {
                nextId: () => `decision_generated_${String(decisionSequence).padStart(4, "0")}`,
              },
            },
            intaken.cardId,
            intaken.versionId,
            { decidedBy: "generated-card-selection-v1" },
          );
        }
      }
      cardRecords = collected;
      await runtime.prepareCardCandidates();

      const measured: CaseResult[] = [];
      for (const testCase of GENERATED_CARD_SELECTION_CASES) {
        const expectedCardIds = testCase.sections.map((section) =>
          cardIdFor(cardRecords, testCase.document, section),
        );
        const resolution = await runtime.contextApplication.resolveContext({
          query: testCase.query,
        });
        const admittedCardIds = resolution.selection.selected.map(
          (selected) => selected.cardId,
        );
        measured.push({
          id: testCase.id,
          expectedCardIds,
          admittedCardIds,
          passed:
            expectedCardIds.length === admittedCardIds.length &&
            expectedCardIds.every((cardId) => admittedCardIds.includes(cardId)),
        });
      }
      results = measured;

      const generalizationMeasured: GeneralizationCaseResult[] = [];
      for (const testCase of SELECTION_GENERALIZATION_CASES) {
        const requiredCardIds = testCase.sections.map((section) =>
          cardIdFor(cardRecords, testCase.document, section),
        );
        const allowedCardIds = [
          ...requiredCardIds,
          ...(testCase.allowedSections ?? []).map((entry) =>
            cardIdFor(cardRecords, entry.document, entry.section),
          ),
        ];
        const resolution = await runtime.contextApplication.resolveContext({
          query: testCase.query,
        });
        const admittedCardIds = resolution.selection.selected
          .map((selected) => selected.cardId)
          .sort();
        generalizationMeasured.push({
          id: testCase.id,
          split: testCase.split,
          expectedCardIds: requiredCardIds,
          admittedCardIds,
          passed:
            requiredCardIds.every((cardId) => admittedCardIds.includes(cardId)) &&
            admittedCardIds.every((cardId) => allowedCardIds.includes(cardId)),
        });
      }
      generalizationResults = generalizationMeasured;
      growthResults = await measureUnrelatedGrowth(
        runtime,
        await runtime.catalog.listApprovedCards(),
        generalizationResults,
      );

      await writeFile(
        resultPath!,
        `${JSON.stringify({
          benchmarkId: "generated-card-selection-v1",
          catalog: cardRecords,
          queryCount: results.length,
          passed: results.every((result) => result.passed),
          cases: results,
          generalization: {
            benchmarkId: "selection-generalization-v1",
            calibrationQueryCount: SELECTION_GENERALIZATION_CALIBRATION_CASES.length,
            holdoutQueryCount: SELECTION_GENERALIZATION_HOLDOUT_CASES.length,
            passed:
              generalizationResults.every((result) => result.passed) &&
              growthResults.every((result) => result.passed),
            cases: generalizationResults,
            growth: growthResults,
          },
        }, null, 2)}\n`,
        "utf8",
      );
    }, 180_000);

    afterAll(async () => {
      await runtime?.control.lifecycle.shutdown();
      runtime?.database.close();
    });

    it("admits exactly the expected generated Cards for every demo query", () => {
      expect(results.filter((result) => !result.passed)).toEqual([]);
      expect(results).toHaveLength(GENERATED_CARD_SELECTION_CASES.length);
    });

    it("covers a generated Card for every expected document section", () => {
      const expectedCardCount = GENERATED_CARD_SELECTION_CASES.reduce(
        (sum, testCase) => sum + testCase.sections.length,
        0,
      );
      expect(
        GENERATED_CARD_SELECTION_CASES.flatMap((testCase) =>
          testCase.sections.map((section) =>
            cardIdFor(cardRecords, testCase.document, section),
          ),
        ),
      ).toHaveLength(expectedCardCount);
    });

    it("recovers every calibration fact without admitting an unexpected Card", () => {
      const calibration = generalizationResults.filter(
        (result) => result.split === "calibration",
      );
      expect(calibration).toHaveLength(SELECTION_GENERALIZATION_CALIBRATION_CASES.length);
      expect(calibration.filter((result) => !result.passed)).toEqual([]);
    });

    it("passes the sealed generalization holdout without a forbidden admission", () => {
      const holdout = generalizationResults.filter(
        (result) => result.split === "holdout",
      );
      expect(holdout).toHaveLength(SELECTION_GENERALIZATION_HOLDOUT_CASES.length);
      expect(holdout.filter((result) => !result.passed)).toEqual([]);
    });

    it("keeps base scores and admissions invariant under unrelated growth", () => {
      expect(growthResults.map((result) => result.catalogSize)).toEqual([
        44, 46, 58, 64, 105, 128,
      ]);
      expect(growthResults.filter((result) => !result.passed)).toEqual([]);
    });
  },
);

async function measureUnrelatedGrowth(
  runtime: DaemonRuntime,
  baseCards: readonly ApprovedCard[],
  baselineResults: readonly GeneralizationCaseResult[],
): Promise<readonly GrowthResult[]> {
  const catalogSizes = [44, 46, 58, 64, 105, 128] as const;
  if (baseCards.length !== catalogSizes[0]) {
    throw new Error(
      `selection-generalization-v1 expected 44 Cards, received ${String(baseCards.length)}`,
    );
  }
  const baselineScores = new Map(
    SELECTION_GENERALIZATION_CASES.map((testCase) => [
      testCase.id,
      new Map(
        scoreCardsAgainstQuery(testCase.query, baseCards).map((candidate) => [
          candidate.versionId,
          candidate.score,
        ]),
      ),
    ]),
  );
  const baselineAdmissions = new Map(
    baselineResults.map((result) => [result.id, [...result.admittedCardIds].sort()]),
  );
  const queryVectors = new Map<string, readonly number[]>();
  for (const testCase of SELECTION_GENERALIZATION_CASES) {
    const embedded = await runtime.cardEmbeddingProvider.embed({
      profile: runtime.cardSelectionProfile,
      inputs: [{ key: testCase.id, text: normalizeSelectionText(testCase.query) }],
    });
    const vector = embedded[0]?.vector;
    if (vector === undefined) throw new Error(`missing query vector for ${testCase.id}`);
    queryVectors.set(testCase.id, vector);
  }

  const results: GrowthResult[] = [];
  for (const catalogSize of catalogSizes) {
    const cards = [
      ...baseCards,
      ...createUnrelatedCards(catalogSize - baseCards.length),
    ];
    const entries = cards.map(buildCardSelectionEntry);
    const index = await new InMemoryCardCandidateIndexStore().acquire({
      entries,
      catalogSnapshotVersion: catalogSnapshotVersion(
        entries,
        runtime.cardSelectionProfile,
      ),
      profile: runtime.cardSelectionProfile,
      embedding: runtime.cardEmbeddingProvider,
    });
    let changedBaseScoreCount = 0;
    let changedAdmissionCount = 0;
    const caseDiagnostics = [];
    for (const testCase of SELECTION_GENERALIZATION_CASES) {
      const lexical = scoreCardsAgainstQuery(testCase.query, cards);
      const baseline = baselineScores.get(testCase.id)!;
      changedBaseScoreCount += lexical.filter(
        (candidate) =>
          baseline.has(candidate.versionId) &&
          baseline.get(candidate.versionId) !== candidate.score,
      ).length;
      const semantic = index.topK(queryVectors.get(testCase.id)!, 32);
      const hybrid = rankHybridCandidates({
        lexical,
        semantic,
        lexicalTopK: 32,
      });
      const admitted = hybrid
        .filter((candidate) => candidate.score >= 0.85)
        .map((candidate) => candidate.cardId)
        .sort();
      if (!sameStrings(admitted, baselineAdmissions.get(testCase.id)!)) {
        changedAdmissionCount += 1;
      }
      if (catalogSize === baseCards.length) {
        const expectedCardIds = baselineResults.find(
          (result) => result.id === testCase.id,
        )?.expectedCardIds;
        caseDiagnostics.push({
          id: testCase.id,
          leadingSemanticCardId: semantic[0]?.cardId,
          leadingSemanticSimilarity: semantic[0]?.similarity,
          expected: hybrid
            .filter((candidate) => expectedCardIds?.includes(candidate.cardId))
            .map((candidate) => ({
              cardId: candidate.cardId,
              lexicalScore: candidate.lexicalScore,
              semanticSimilarity: candidate.semanticSimilarity,
              semanticScore: candidate.semanticScore,
              score: candidate.score,
              signals: candidate.signals,
            })),
          top: [...hybrid]
            .sort((left, right) => right.score - left.score)
            .slice(0, 6)
            .map((candidate) => ({
              cardId: candidate.cardId,
              lexicalScore: candidate.lexicalScore,
              semanticSimilarity: candidate.semanticSimilarity,
              semanticScore: candidate.semanticScore,
              score: candidate.score,
              signals: candidate.signals,
            })),
        });
      }
    }
    results.push({
      catalogSize,
      changedBaseScoreCount,
      changedAdmissionCount,
      passed: changedBaseScoreCount === 0 && changedAdmissionCount === 0,
      ...(caseDiagnostics.length > 0 ? { cases: caseDiagnostics } : {}),
    });
  }
  return results;
}

function createUnrelatedCards(count: number): readonly ApprovedCard[] {
  return Array.from({ length: count }, (_, index) => {
    const suffix = String(index).padStart(4, "0");
    return {
      cardId: `generalization_filler_card_${suffix}`,
      versionId: `generalization_filler_version_${suffix}`,
      meaning: {
        description: `천문 관측 장비 교정 이력 ${suffix}`,
        representativeQuestions: [`천문망원경교정기록${suffix}`],
        aliases: [`천문 장비 교정 ${suffix}`],
        keywords: ["천문", "망원경", `교정${suffix}`],
      },
      policy: { sensitive: false, allowedUsage: ["retrieval"] },
      scopes: [{
        kind: "managed_document",
        reference: { scopeId: `generalization_scope_${suffix}`, scopeVersion: "filler-version" },
        documentIndex: {
          documentIndexId: `generalization_index_${suffix}`,
          sourceId: `generalization_source_${suffix}`,
          documentId: `generalization_document_${suffix}`,
          indexVersion: "filler-version",
        },
        selection: { kind: "document" },
      }],
    } satisfies ApprovedCard;
  });
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sourceReference(document: string): string {
  return `demo.${document.slice(0, -3)}`;
}

function cardIdFor(
  cards: readonly CardRecord[],
  document: string,
  section: string,
): string {
  const matches = cards.filter(
    (card) => card.document === document && card.aliases.includes(section),
  );
  if (matches.length !== 1) {
    throw new Error(
      `expected one generated Card for ${document} / ${section}, found ${String(matches.length)}`,
    );
  }
  return matches[0]!.cardId;
}
