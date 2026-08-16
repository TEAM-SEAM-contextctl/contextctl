import { describe, expect, it } from "vitest";

import {
  DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
  TransformersJsLocalEmbeddingAdapter,
} from "../src/index.js";

const artifactDirectory = process.env.CONTEXTCTL_GRANITE_ASSET_DIRECTORY;

describe.skipIf(artifactDirectory === undefined)(
  "Granite local embedding integration",
  () => {
    it("reproduces normalized 384-dimensional document and query vectors offline", async () => {
      const adapter = new TransformersJsLocalEmbeddingAdapter({
        artifactDirectory: artifactDirectory!,
      });
      const request = {
        profile: DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
        inputs: [
          { key: "document", text: "결제 실패는 5분 뒤 다시 시도합니다." },
          { key: "query", text: "결제 재시도 절차" },
        ],
        signal: new AbortController().signal,
      };

      const first = await adapter.embed(request);
      const second = await adapter.embed(request);

      expect(second).toEqual(first);
      expect(first).toHaveLength(2);
      for (const output of first) {
        expect(output.vector).toHaveLength(384);
        const magnitude = Math.sqrt(
          output.vector.reduce(
            (sum, component) => sum + component * component,
            0,
          ),
        );
        expect(magnitude).toBeCloseTo(1, 3);
      }
    }, 120_000);
  },
);
