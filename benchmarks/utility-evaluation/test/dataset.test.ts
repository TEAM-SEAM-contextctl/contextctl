import { fileURLToPath } from "node:url";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { readEvaluationDataset } from "../src/dataset.js";

const benchmark = resolve(fileURLToPath(new URL("../", import.meta.url)));
const corpus = resolve(benchmark, "../../apps/contextctl-daemon/demo/docs");

describe("utility evaluation fixtures", () => {
  for (const split of ["development", "holdout"] as const) {
    it(`validates ${split} evidence against the public demo corpus`, async () => {
      const dataset = await readEvaluationDataset({
        path: resolve(benchmark, "fixtures", `${split}.json`),
        expectedSplit: split,
        corpusDirectory: corpus,
      });
      expect(dataset.queries.length).toBeGreaterThan(0);
      expect(dataset.sha256).toMatch(/^[a-f0-9]{64}$/u);
    });
  }

  it("validates sealed policy overrides for a forbidden blind query", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "contextctl-blind-fixture-"));
    const fixture = resolve(root, "fixture.json");
    try {
      await writeFile(resolve(root, "source.md"), "# Restricted policy\n");
      await writeFile(
        fixture,
        `${JSON.stringify({
          schemaVersion: 1,
          split: "shadow",
          sealedAt: "2026-09-03T00:00:00.000Z",
          frozenPolicyDigest: `sha256:${"a".repeat(64)}`,
          frozenPolicySourceSha256: "b".repeat(64),
          frozenCorpusSha256: "c".repeat(64),
          catalogPolicyOverrides: [
            {
              cardDescription: "Restricted policy",
              sensitive: true,
              allowedUsage: ["retrieval"],
            },
          ],
          queries: [
            {
              id: "forbidden-1",
              category: "forbidden",
              query: "restricted policy",
              expectedAnswerable: false,
              requiredFacts: [],
              relevantChunkAnchors: [],
              selectionExpectation: {
                kind: "forbidden",
                allowedCardDescriptions: [],
                forbiddenCardDescriptions: ["Restricted policy"],
              },
            },
          ],
        })}\n`,
      );

      const dataset = await readEvaluationDataset({
        path: fixture,
        expectedSplit: "shadow",
        corpusDirectory: root,
      });

      expect(dataset.catalogPolicyOverrides).toHaveLength(1);
      expect(
        dataset.queries[0]?.selectionExpectation.forbiddenCardDescriptions,
      ).toEqual(["Restricted policy"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
