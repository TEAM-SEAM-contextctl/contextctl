import type { Server } from "node:http";

import { describe, expect, it } from "vitest";

import type { ContextResolution } from "../../src/domain/context-resolution.js";
import {
  CONTEXT_RESOLUTION_MAXIMUM_BYTES,
  RESOLVE_REQUEST_MAXIMUM_BYTES,
  utf8ByteLength,
} from "../../src/domain/transport-policy.js";
import {
  createHttpQueryHandler,
  RESOLVE_PATH,
} from "../../src/infrastructure/http/http-query-handler.js";
import { createDeliveryHttpServer } from "../../src/infrastructure/http/node-http-server.js";
import {
  createDemoCardSet,
  DEMO_QUERY,
} from "../fixtures/approved-card.fixture.js";
import { createFixtureContextApplication } from "../fixtures/context-application.fixture.js";
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

function jsonStringWithBytes(key: string, bytes: number): string {
  const empty = JSON.stringify({ [key]: "" });
  const value = "가".repeat(Math.floor((bytes - utf8ByteLength(empty)) / 3));
  const remainder = "x".repeat(
    bytes - utf8ByteLength(empty) - utf8ByteLength(value),
  );
  return JSON.stringify({ [key]: value + remainder });
}

describe("createDeliveryHttpServer", () => {
  it("answers a real resolution request over a socket", async () => {
    const server = createDeliveryHttpServer(
      createHttpQueryHandler(
        createFixtureContextApplication({
          cards: createDemoCardSet(),
          chunks: createRefundPolicyChunkMap(),
        }),
      ),
    );

    try {
      const port = await listenOnLoopback(server);

      const response = await fetch(
        `http://127.0.0.1:${String(port)}${RESOLVE_PATH}`,
        {
          method: "POST",
          body: JSON.stringify({ query: DEMO_QUERY }),
        },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");

      const resolution = (await response.json()) as ContextResolution;
      expect(resolution.query).toBe(DEMO_QUERY);
      expect(resolution.policy.payloadSchemaVersion).toBe(3);

      // The round trip is what this test exists for, so it checks that a
      // fulfilled item survived the socket rather than re-checking assembly.
      const fulfilled = resolution.items.flatMap((item) =>
        item.fulfillment.status === "fulfilled" ? [item.fulfillment.context] : [],
      );
      expect(fulfilled).toHaveLength(1);
      expect(fulfilled[0]?.chunks.length).toBeGreaterThan(0);
    } finally {
      await close(server);
    }
  });

  it("refuses a request body over 64 KiB before resolution", async () => {
    let calls = 0;
    const server = createDeliveryHttpServer(async () => {
      calls += 1;
      return {
        status: 200,
        body: "{}",
      };
    });

    try {
      const port = await listenOnLoopback(server);
      const response = await fetch(
        `http://127.0.0.1:${String(port)}${RESOLVE_PATH}`,
        {
          method: "POST",
          body: "x".repeat(64 * 1024 + 1),
        },
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: { code: "invalid_request", retriable: false },
      });
      expect(calls).toBe(0);
    } finally {
      await close(server);
    }
  });

  it("accepts a multibyte request exactly at 64 KiB", async () => {
    let received = "";
    const server = createDeliveryHttpServer(async (request) => {
      received = request.body;
      return { status: 200, body: "{}" };
    });

    try {
      const port = await listenOnLoopback(server);
      const body = jsonStringWithBytes("query", RESOLVE_REQUEST_MAXIMUM_BYTES);
      const response = await fetch(
        `http://127.0.0.1:${String(port)}${RESOLVE_PATH}`,
        { method: "POST", body },
      );

      expect(response.status).toBe(200);
      expect(received).toBe(body);
    } finally {
      await close(server);
    }
  });

  it("commits a 2 MiB response whole and replaces an oversized one", async () => {
    const boundary = jsonStringWithBytes(
      "value",
      CONTEXT_RESOLUTION_MAXIMUM_BYTES,
    );
    let body = boundary;
    const server = createDeliveryHttpServer(async () => ({ status: 200, body }));

    try {
      const port = await listenOnLoopback(server);
      const accepted = await fetch(
        `http://127.0.0.1:${String(port)}${RESOLVE_PATH}`,
        { method: "POST", body: "{}" },
      );
      expect(accepted.status).toBe(200);
      expect(utf8ByteLength(await accepted.text())).toBe(
        CONTEXT_RESOLUTION_MAXIMUM_BYTES,
      );

      body = `${boundary}x`;
      const refused = await fetch(
        `http://127.0.0.1:${String(port)}${RESOLVE_PATH}`,
        { method: "POST", body: "{}" },
      );
      expect(refused.status).toBe(500);
      await expect(refused.json()).resolves.toEqual({
        error: { code: "unexpected_failure", retriable: false },
      });
    } finally {
      await close(server);
    }
  });
});
