import { fileURLToPath } from "node:url";
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
});
