import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import type { McpQueryServer } from "../../src/infrastructure/mcp/mcp-query-server.js";
import { runStdioServer } from "../../src/infrastructure/mcp/stdio-transport.js";

interface RecordingServer {
  readonly server: McpQueryServer;
  readonly received: readonly string[];
}

/**
 * A stand-in server that records every line it is handed and answers requests
 * only, so a transport test measures framing rather than selection.
 *
 * The first request is delayed deliberately: `handleMessage` is async, so a
 * transport that did not serialise its calls would let the second response
 * overtake the first, and that reordering is invisible without the delay.
 */
function createRecordingServer(): RecordingServer {
  const received: string[] = [];

  return {
    received,
    server: {
      handleMessage: async (rawMessage: string) => {
        received.push(rawMessage);

        const message = JSON.parse(rawMessage) as { id?: number };
        if (message.id === undefined) {
          return undefined;
        }
        if (message.id === 1) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} });
      },
    },
  };
}

interface Harness {
  readonly input: PassThrough;
  readonly finished: Promise<readonly string[]>;
  readonly received: readonly string[];
}

/** Drives the transport over a pair of pipes, collecting the framed output. */
function startTransport(): Harness {
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding("utf8");

  const chunks: string[] = [];
  output.on("data", (chunk: string) => chunks.push(chunk));

  const recording = createRecordingServer();
  const finished = runStdioServer(recording.server, input, output).then(() =>
    chunks.join("").split("\n").filter((line) => line !== ""),
  );

  return { input, finished, received: recording.received };
}

function requestLine(id: number): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list" })}\n`;
}

describe("runStdioServer", () => {
  it("answers newline-delimited requests in the order they arrived", async () => {
    const harness = startTransport();

    harness.input.write(requestLine(1));
    harness.input.write(requestLine(2));
    harness.input.end();

    const lines = await harness.finished;

    expect(lines).toHaveLength(2);
    expect(lines.map((line) => (JSON.parse(line) as { id: number }).id)).toEqual([
      1, 2,
    ]);
  });

  it("buffers a request split across several chunks", async () => {
    const harness = startTransport();
    const line = requestLine(1);

    harness.input.write(line.slice(0, 5));
    harness.input.write(line.slice(5, 12));
    harness.input.write(line.slice(12));
    harness.input.end();

    const lines = await harness.finished;

    expect(harness.received).toEqual([line.slice(0, -1)]);
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0] ?? "null") as { id: number }).id).toBe(1);
  });

  it("writes nothing for a notification", async () => {
    const harness = startTransport();

    harness.input.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    harness.input.end();

    await expect(harness.finished).resolves.toEqual([]);
    expect(harness.received).toHaveLength(1);
  });

  it("skips blank lines without handing them to the server", async () => {
    const harness = startTransport();

    harness.input.write("\n");
    harness.input.write("   \n");
    harness.input.write(requestLine(2));
    harness.input.end();

    const lines = await harness.finished;

    expect(harness.received).toHaveLength(1);
    expect(lines).toHaveLength(1);
  });

  it("processes a trailing line that carries no newline", async () => {
    const harness = startTransport();

    harness.input.write(requestLine(1));
    harness.input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    harness.input.end();

    const lines = await harness.finished;

    expect(harness.received).toHaveLength(2);
    expect(lines.map((line) => (JSON.parse(line) as { id: number }).id)).toEqual([
      1, 2,
    ]);
  });
});
