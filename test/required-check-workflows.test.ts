import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("required external check workflows", () => {
  it("does not download optional ONNX CUDA assets on CPU-only runners", () => {
    for (const name of ["ci.yml", "document-retrieval-evaluation.yml"]) {
      const workflow = readWorkflow(name);

      expect(workflow).toMatch(
        /\nenv:\n(?: {2}#.*\n)* {2}ONNXRUNTIME_NODE_INSTALL: skip\n\njobs:\n/,
      );
    }
  });

  it("keeps Qdrant and Granite integration checks addressable by stable names", () => {
    const workflow = readWorkflow("ci.yml");

    expect(workflow).toContain("  qdrant-integration:\n");
    expect(workflow).toContain("  granite-integration:\n");
  });

  it("always reports the document retrieval gate on pull requests", () => {
    const workflow = readWorkflow("document-retrieval-evaluation.yml");
    const trigger = workflow.slice(
      workflow.indexOf("on:\n"),
      workflow.indexOf("permissions:\n"),
    );

    expect(trigger).toContain("  pull_request:\n");
    expect(trigger).not.toContain("paths:");
    expect(workflow).toContain("    name: document-retrieval-gate\n");
    expect(workflow).toContain("    if: ${{ always() }}\n");
    expect(workflow).toContain(
      "EVALUATION_REQUIRED: ${{ needs.change_detection.outputs.relevant }}",
    );
    expect(workflow).toContain(
      "EVALUATION_RESULT: ${{ needs.release_evaluation.result }}",
    );
    expect(workflow).toContain(
      "CONTEXTCTL_EVAL_RESOURCE_GATE_MODE: release",
    );
    expect(workflow).not.toContain("hosted_observation");
    expect(workflow).toContain(
      "scripts/run-document-retrieval-resource-probe.mjs",
    );
    expect(workflow).toContain(
      "npm run test:benchmark:ingestion-indexing",
    );
    expect(workflow).toContain(
      "CONTEXTCTL_DOCUMENT_RETRIEVAL_RESULT_PATH:",
    );
    expect(workflow).toContain(
      "CONTEXTCTL_INGESTION_BENCHMARK_RESULT_PATH:",
    );
    expect(workflow).toContain(
      "qdrant/qdrant@sha256:0fb8897412abc81d1c0430a899b9a81eb8328aa634e7242d1bc804c1fe8fe863",
    );
    expect(workflow).toContain(
      "${{ runner.temp }}/ingestion-indexing-benchmark.json",
    );
    expect(workflow).toContain(
      'if [[ "${EVALUATION_REQUIRED}" == "true" && "${EVALUATION_RESULT}" != "success" ]]',
    );
  });

  it("publishes npm candidates only after the complete installed-product gate", () => {
    const workflow = readWorkflow("publish-npm-candidate.yml");

    expect(workflow).toContain("  id-token: write\n");
    expect(workflow).toContain("    environment: npm\n");
    expect(workflow).toContain("    if: ${{ github.ref == 'refs/heads/main' }}\n");
    expect(workflow).toContain(
      "qdrant/qdrant@sha256:0fb8897412abc81d1c0430a899b9a81eb8328aa634e7242d1bc804c1fe8fe863",
    );
    for (const command of [
      "npm run test:consumer-install",
      "npm run test:operational",
      "npm run test:integration:qdrant",
      "npm run test:integration:granite",
      "npm run test:eval:document-retrieval",
      "npm run test:benchmark:ingestion-indexing",
      "npm run test:release-product-local",
      "npm run release:publish:dry-run",
      "npm run release:publish:candidate -- --target public --registry https://registry.npmjs.org/ --yes --provenance",
      "npm run release:verify:published -- --target public --registry https://registry.npmjs.org/ --require-provenance",
    ]) {
      expect(workflow).toContain(command);
    }
    expect(workflow.indexOf("release:publish:candidate")).toBeLessThan(
      workflow.indexOf("release:verify:published"),
    );
  });
});

function readWorkflow(name: string): string {
  return readFileSync(
    resolve(repositoryRoot, ".github", "workflows", name),
    "utf8",
  );
}
