import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import type { McpQueryServer } from "../../src/infrastructure/mcp/mcp-query-server.js";
import { runStdioServer } from "../../src/infrastructure/mcp/stdio-transport.js";
import type { DeliveryRequestExecution } from "../../src/infrastructure/transport/request-execution.js";
import {
  CONTEXT_RESOLUTION_MAXIMUM_BYTES,
  RESOLVE_REQUEST_MAXIMUM_BYTES,
  utf8ByteLength,
} from "../../src/domain/transport-policy.js";

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
function startTransport(
  recording = createRecordingServer(),
  execution?: DeliveryRequestExecution,
): Harness {
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding("utf8");

  const chunks: string[] = [];
  output.on("data", (chunk: string) => chunks.push(chunk));

  const finished = runStdioServer(
    recording.server,
    input,
    output,
    execution,
  ).then(() => chunks.join("").split("\n").filter((line) => line !== ""));

  return { input, finished, received: recording.received };
}

function requestWithBytes(id: number, bytes: number): string {
  const build = (padding: string): string =>
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/list",
      params: { padding },
    });
  const empty = build("");
  const available = bytes - utf8ByteLength(empty);
  const multibyte = "가".repeat(Math.floor(available / 3));
  const remainder = "x".repeat(available % 3);
  const request = build(multibyte + remainder);
  if (utf8ByteLength(request) !== bytes) {
    throw new Error("failed to construct exact MCP request fixture");
  }
  return request;
}

function responseWithBytes(id: number, bytes: number): string {
  const build = (value: string): string =>
    JSON.stringify({ jsonrpc: "2.0", id, result: { value } });
  const empty = build("");
  const response = build("x".repeat(bytes - utf8ByteLength(empty)));
  if (utf8ByteLength(response) !== bytes) {
    throw new Error("failed to construct exact MCP response fixture");
  }
  return response;
}

function requestLine(id: number): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list" })}\n`;
}

const CONTROLLED_EXECUTION: DeliveryRequestExecution = {
  maximumInFlightRequests: 2,
  now: () => 0,
  runRequest: async (_input, operation) =>
    await operation(new AbortController().signal),
  assertResponseCanCommit: () => undefined,
};

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

  it("finishes a controlled stream with only trailing whitespace", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const recording = createRecordingServer();

    const finished = runStdioServer(
      recording.server,
      input,
      output,
      CONTROLLED_EXECUTION,
    );
    input.end("   ");

    await expect(finished).resolves.toBeUndefined();
    expect(recording.received).toEqual([]);
  });

  it("accepts a multibyte frame exactly at 64 KiB", async () => {
    const harness = startTransport();
    const request = requestWithBytes(21, RESOLVE_REQUEST_MAXIMUM_BYTES);

    harness.input.end(`${request}\n`);

    const lines = await harness.finished;
    expect(harness.received).toEqual([request]);
    expect(lines).toHaveLength(1);
  });

  it("rejects an oversized frame before invoking the MCP server", async () => {
    const harness = startTransport();
    const request = requestWithBytes(22, RESOLVE_REQUEST_MAXIMUM_BYTES);

    harness.input.end(`${request} \n`);

    const lines = await harness.finished;
    expect(harness.received).toEqual([]);
    const response = JSON.parse(lines[0] ?? "null") as {
      readonly id: null;
      readonly result: {
        readonly isError: boolean;
        readonly content: readonly [{ readonly text: string }];
      };
    };
    expect(response.id).toBeNull();
    expect(response.result.isError).toBe(true);
    expect(JSON.parse(response.result.content[0].text)).toEqual({
      error: { code: "invalid_request", retriable: false },
    });
  });

  it("commits a 2 MiB frame whole and replaces an oversized frame", async () => {
    const boundary = responseWithBytes(23, CONTEXT_RESOLUTION_MAXIMUM_BYTES);
    let response = boundary;
    const recording: RecordingServer = {
      received: [],
      server: {
        handleMessage: async () => response,
      },
    };
    const accepted = startTransport(recording);
    accepted.input.end(requestLine(23));
    const acceptedLines = await accepted.finished;
    expect(utf8ByteLength(acceptedLines[0] ?? "")).toBe(
      CONTEXT_RESOLUTION_MAXIMUM_BYTES,
    );

    response = `${boundary} `;
    const refused = startTransport(recording);
    refused.input.end(requestLine(23));
    const refusedLines = await refused.finished;
    const envelope = JSON.parse(refusedLines[0] ?? "null") as {
      readonly id: number;
      readonly result: {
        readonly isError: boolean;
        readonly content: readonly [{ readonly text: string }];
      };
    };
    expect(envelope.id).toBe(23);
    expect(envelope.result.isError).toBe(true);
    expect(JSON.parse(envelope.result.content[0].text)).toEqual({
      error: { code: "unexpected_failure", retriable: false },
    });
  });

  it("enforces the same frame bounds on the daemon-controlled path", async () => {
    const oversizedRequest = `${requestWithBytes(
      24,
      RESOLVE_REQUEST_MAXIMUM_BYTES,
    )} `;
    const oversizedResponse = `${responseWithBytes(
      25,
      CONTEXT_RESOLUTION_MAXIMUM_BYTES,
    )} `;
    const received: string[] = [];
    const server: McpQueryServer = {
      handleMessage: async (rawMessage) => {
        received.push(rawMessage);
        return oversizedResponse;
      },
    };
    const harness = startTransport(
      { server, received },
      CONTROLLED_EXECUTION,
    );

    harness.input.end(`${oversizedRequest}\n${requestLine(25)}`);

    const lines = await harness.finished;
    expect(harness.received).toEqual([requestLine(25).trimEnd()]);
    expect(lines).toHaveLength(2);
    const payloads = lines.map((line) => JSON.parse(line) as {
      readonly id: number | null;
      readonly result: {
        readonly isError: boolean;
        readonly content: readonly [{ readonly text: string }];
      };
    });
    expect(payloads.map(({ id }) => id)).toEqual(
      expect.arrayContaining([null, 25]),
    );
    expect(
      payloads.map(({ result }) => JSON.parse(result.content[0].text)),
    ).toEqual(
      expect.arrayContaining([
        { error: { code: "invalid_request", retriable: false } },
        { error: { code: "unexpected_failure", retriable: false } },
      ]),
    );
  });
});
