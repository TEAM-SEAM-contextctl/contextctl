import type { Server } from "node:http";

import { describe, expect, it } from "vitest";

import type { DeliveryResult } from "../../src/application/select-context.js";
import { createHttpQueryHandler } from "../../src/infrastructure/http/http-query-handler.js";
import { createDeliveryHttpServer } from "../../src/infrastructure/http/node-http-server.js";
import { FixtureDocumentRetriever } from "../../src/infrastructure/fixture-document-retriever.js";
import { InMemoryCardCatalog } from "../../src/infrastructure/in-memory-card-catalog.js";
import { createDemoCardSet } from "../fixtures/approved-card.fixture.js";
import { createRefundPolicyChunkMap } from "../fixtures/document-chunk.fixture.js";

/** The demo question: it names refund wording and stock wording at once. */
const DEMO_QUERY = "환불할 수 없는 상품과 현재 재고를 알려줘";

/**
 * Binds the server to a loopback port the OS picks.
 *
 * The test does the listening on purpose: `createDeliveryHttpServer` never
 * binds, because where it binds is the daemon's decision, so a round trip can
 * only be exercised by a caller that supplies one.
 */
function listenOnLoopback(server: Server): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("server did not bind to a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((cause) => {
      if (cause === undefined) {
        resolve();
        return;
      }
      reject(cause);
    });
  });
}

describe("createDeliveryHttpServer", () => {
  it("answers a real selection request over a socket", async () => {
    const server = createDeliveryHttpServer(
      createHttpQueryHandler({
        catalog: new InMemoryCardCatalog(createDemoCardSet()),
        retriever: new FixtureDocumentRetriever(createRefundPolicyChunkMap()),
      }),
    );

    try {
      const port = await listenOnLoopback(server);

      const response = await fetch(
        `http://127.0.0.1:${String(port)}/v1/context/selection`,
        {
          method: "POST",
          body: JSON.stringify({ query: DEMO_QUERY }),
        },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");

      const result = (await response.json()) as DeliveryResult;
      expect(result.query).toBe(DEMO_QUERY);
      expect(result.evidence.chunks.length).toBeGreaterThan(0);
    } finally {
      await close(server);
    }
  });
});
