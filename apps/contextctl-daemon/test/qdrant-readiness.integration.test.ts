import { describe, expect, it } from "vitest";

import { probeQdrantReadiness } from "../src/vector-backend.js";

const qdrantUrl = process.env.CONTEXTCTL_QDRANT_URL;
if (qdrantUrl === undefined || qdrantUrl.trim() === "") {
  throw new Error(
    "qdrant readiness integration requires CONTEXTCTL_QDRANT_URL; run npm run test:integration:qdrant",
  );
}

describe("Qdrant readiness integration", () => {
  it("recognizes the same live service used by the product adapters", async () => {
    await expect(
      probeQdrantReadiness({ CONTEXTCTL_QDRANT_URL: qdrantUrl }),
    ).resolves.toMatchObject({
      status: "reachable",
      endpoint: expect.stringContaining(new URL(qdrantUrl).host),
      elapsedMs: expect.any(Number),
    });
  });
});
