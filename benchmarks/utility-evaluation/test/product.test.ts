import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { stageEvaluationCorpus } from "../src/product.js";

describe("evaluation corpus staging", () => {
  it("copies only regular Markdown inputs into an isolated product corpus", async () => {
    const root = await mkdtemp(join(tmpdir(), "contextctl-eval-corpus-"));
    const source = join(root, "source");
    const target = join(root, "target");
    try {
      await mkdir(source);
      await writeFile(join(source, "policy.md"), "# Policy\n\nsealed bytes\n");
      await writeFile(join(source, "notes.txt"), "not a source");

      await stageEvaluationCorpus(source, target);

      await expect(readFile(join(target, "policy.md"), "utf8")).resolves.toBe(
        "# Policy\n\nsealed bytes\n",
      );
      await expect(readFile(join(target, "notes.txt"), "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
