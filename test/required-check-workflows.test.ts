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
      'if [[ "${EVALUATION_REQUIRED}" == "true" && "${EVALUATION_RESULT}" != "success" ]]',
    );
  });
});

function readWorkflow(name: string): string {
  return readFileSync(
    resolve(repositoryRoot, ".github", "workflows", name),
    "utf8",
  );
}
