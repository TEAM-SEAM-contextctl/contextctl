import type { Server } from "node:http";

import { describe, expect, it } from "vitest";

import type {
  ContextResolution,
  ResolutionItem,
} from "../../src/domain/context-resolution.js";
import { createHttpQueryHandler } from "../../src/infrastructure/http/http-query-handler.js";
import { createDeliveryHttpServer } from "../../src/infrastructure/http/node-http-server.js";
import { FixtureDocumentRetriever } from "../../src/infrastructure/fixture-document-retriever.js";
import { InMemoryCardCatalog } from "../../src/infrastructure/in-memory-card-catalog.js";
import {
  createDemoCardSet,
  DEMO_QUERY,
} from "../fixtures/approved-card.fixture.js";
import { createRefundPolicyChunkMap } from "../fixtures/document-chunk.fixture.js";

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

      const resolution = (await response.json()) as ContextResolution;
      expect(resolution.query).toBe(DEMO_QUERY);
      expect(resolution.policy.payloadSchemaVersion).toBe(2);

      // The round trip is what this test exists for, so it checks that a
      // fulfilled item survived the socket rather than re-checking assembly.
      const fulfilled = resolution.items.filter(
        (item): item is Extract<ResolutionItem, { fulfillment: "fulfilled" }> =>
          item.fulfillment === "fulfilled",
      );
      expect(fulfilled).toHaveLength(1);
      expect(fulfilled[0]?.context.chunks.length).toBeGreaterThan(0);
    } finally {
      await close(server);
    }
  });
});
