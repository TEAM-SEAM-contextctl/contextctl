import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  createMcpQueryServer,
  runStdioServer,
  type ContextResolution,
  type ResolveContextRequest,
} from "@contextctl/selection-delivery";

import type { BudgetedResolveApplication } from "../../src/context-application.js";
import { ManualRuntimeClock } from "../../src/runtime/clock.js";
import type { RequestBudget } from "../../src/runtime/deadline.js";
import {
  AdmissionControlledResolve,
  createDeliveryRequestExecution,
  DaemonRuntimeControl,
} from "../../src/runtime/runtime-control.js";

const EMPTY_RESOLUTION = {
  payloadSchemaVersion: 3,
} as unknown as ContextResolution;

function toolCall(id: number, query = "q"): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "resolve_context", arguments: { query } },
  });
}

async function waitFor(assertion: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (assertion()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("condition was not reached");
}

function outputLines(output: PassThrough): {
  readonly lines: string[];
  readonly done: Promise<void>;
} {
  const lines: string[] = [];
  let buffer = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      lines.push(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  });
  return {
    lines,
    done: new Promise<void>((resolve, reject) => {
      output.once("error", reject);
      output.once("finish", resolve);
    }),
  };
}

function startControlledTransport(
  control: DaemonRuntimeControl,
  application: BudgetedResolveApplication,
): {
  readonly input: PassThrough;
  readonly output: PassThrough;
  readonly captured: ReturnType<typeof outputLines>;
  readonly running: Promise<void>;
} {
  const input = new PassThrough();
  const output = new PassThrough();
  const captured = outputLines(output);
  const server = createMcpQueryServer(
    new AdmissionControlledResolve(control, application),
  );
  return {
    input,
    output,
    captured,
    running: runStdioServer(
      server,
      input,
      output,
      createDeliveryRequestExecution(control),
    ),
  };
}

async function finish(
  transport: ReturnType<typeof startControlledTransport>,
): Promise<void> {
  transport.input.end();
  await transport.running;
  transport.output.end();
  await transport.captured.done;
}

describe("daemon control through the Delivery MCP adapter", () => {
  it("reaches the eight-plus-thirty-two admission boundary", async () => {
    const control = new DaemonRuntimeControl();
    const releases: (() => void)[] = [];
    let open = false;
    let started = 0;
    const transport = startControlledTransport(control, {
      resolveWithin: async (
        _request: ResolveContextRequest,
        _budget: RequestBudget,
      ) => {
        started += 1;
        if (!open) {
          await new Promise<void>((resolve) => releases.push(resolve));
        }
        return EMPTY_RESOLUTION;
      },
    });

    transport.input.write(
      `${Array.from({ length: 41 }, (_, index) => toolCall(index + 1)).join("\n")}\n`,
    );
    await waitFor(
      () =>
        control.resolve.depth.active === 8 &&
        control.resolve.depth.queued === 32,
    );
    expect(started).toBe(8);
    await waitFor(() => transport.captured.lines.length === 1);
    const refused = JSON.parse(transport.captured.lines[0] ?? "null") as {
      readonly id: number;
      readonly result: {
        readonly isError: boolean;
        readonly content: readonly [{ readonly text: string }];
      };
    };
    expect(refused.id).toBe(41);
    expect(refused.result.isError).toBe(true);
    expect(JSON.parse(refused.result.content[0].text)).toEqual({
      error: { code: "overloaded", retriable: true },
    });

    open = true;
    for (const release of releases.splice(0)) release();
    await finish(transport);
    expect(transport.captured.lines).toHaveLength(41);
  });

  it("propagates an MCP cancellation and emits no late success", async () => {
    const control = new DaemonRuntimeControl();
    let observed: AbortSignal | undefined;
    const transport = startControlledTransport(control, {
      resolveWithin: async (_request, budget) => {
        const stage = budget.stageSignal(budget.managedSearchMs);
        observed = stage.signal;
        try {
          await new Promise<void>((_resolve, reject) => {
            stage.signal.addEventListener(
              "abort",
              () => reject(stage.signal.reason),
              { once: true },
            );
          });
        } finally {
          stage.dispose();
        }
        return EMPTY_RESOLUTION;
      },
    });

    transport.input.write(`${toolCall(7, "cancel me")}\n`);
    await waitFor(() => observed !== undefined);
    transport.input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 7, reason: "caller left" },
      })}\n`,
    );
    await waitFor(() => observed?.aborted === true);
    await finish(transport);
    expect(transport.captured.lines).toEqual([]);
  });

  it("checks the total after MCP serializes a success", async () => {
    const clock = new ManualRuntimeClock();
    const control = new DaemonRuntimeControl({ clock });
    const lateResolution = Object.defineProperty({}, "payloadSchemaVersion", {
      enumerable: true,
      get: () => {
        clock.advance(3_000);
        return 3;
      },
    }) as ContextResolution;
    const transport = startControlledTransport(control, {
      resolveWithin: async () => lateResolution,
    });

    transport.input.write(`${toolCall(9, "late serialization")}\n`);
    await finish(transport);
    const response = JSON.parse(transport.captured.lines[0] ?? "null") as {
      readonly result: {
        readonly isError: boolean;
        readonly content: readonly [{ readonly text: string }];
      };
    };
    expect(response.result.isError).toBe(true);
    expect(JSON.parse(response.result.content[0].text)).toEqual({
      error: { code: "deadline_exceeded", retriable: true },
    });
  });
});
