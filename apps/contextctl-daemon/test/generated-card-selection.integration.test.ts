import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { InMemoryVectorIndexAdapter } from "@contextctl/ingestion-indexing";
import { approveCardVersion } from "@contextctl/registry-lifecycle";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDaemonRuntime, type DaemonRuntime } from "../src/main.js";
import { GENERATED_CARD_SELECTION_CASES } from "./fixtures/generated-card-selection-v1.js";

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

describe.skipIf(artifactDirectory === undefined || resultPath === undefined)(
  "generated-card-selection-v1 · Granite fp32",
  () => {
    let runtime: DaemonRuntime;
    let cardRecords: readonly CardRecord[];
    let results: readonly CaseResult[];

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

      await writeFile(
        resultPath!,
        `${JSON.stringify({
          benchmarkId: "generated-card-selection-v1",
          queryCount: results.length,
          passed: results.every((result) => result.passed),
          cases: results,
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
  },
);

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
