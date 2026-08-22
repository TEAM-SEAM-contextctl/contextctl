import { request as httpRequest, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDeliveryHttpServer,
  createHttpQueryHandler,
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

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  return await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("server did not bind"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function waitFor(assertion: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (assertion()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("condition was not reached");
}

function blockingApplication(): {
  readonly application: BudgetedResolveApplication;
  readonly release: () => void;
  readonly started: () => number;
} {
  const releases: (() => void)[] = [];
  let open = false;
  let started = 0;
  return {
    application: {
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
    },
    release: () => {
      open = true;
      for (const resolve of releases.splice(0)) resolve();
    },
    started: () => started,
  };
}

async function post(port: number, query = "q"): Promise<Response> {
  return await fetch(`http://127.0.0.1:${String(port)}/v1/context/resolve`, {
    method: "POST",
    body: JSON.stringify({ query }),
  });
}

function controlledServer(
  control: DaemonRuntimeControl,
  application: BudgetedResolveApplication,
): Server {
  return createDeliveryHttpServer(
    createHttpQueryHandler(new AdmissionControlledResolve(control, application)),
    createDeliveryRequestExecution(control),
  );
}

describe("daemon control through the Delivery HTTP adapter", () => {
  it("runs eight, queues thirty-two and refuses the forty-first", async () => {
    const control = new DaemonRuntimeControl();
    const blocked = blockingApplication();
    const port = await listen(controlledServer(control, blocked.application));

    const admitted = Array.from({ length: 40 }, () => post(port));
    await waitFor(
      () =>
        control.resolve.depth.active === 8 &&
        control.resolve.depth.queued === 32,
    );
    expect(blocked.started()).toBe(8);

    const refused = await post(port, "one too many");
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({
      error: { code: "overloaded", retriable: true },
    });

    blocked.release();
    const responses = await Promise.all(admitted);
    expect(responses.every((response) => response.status === 200)).toBe(true);
  });

  it("counts body receive time from the socket request event", async () => {
    const clock = new ManualRuntimeClock();
    const control = new DaemonRuntimeControl({ clock });
    let started = 0;
    const server = controlledServer(control, {
      resolveWithin: async () => {
        started += 1;
        return EMPTY_RESOLUTION;
      },
    });
    let requestArrived = false;
    server.once("request", () => {
      requestArrived = true;
    });
    const port = await listen(server);
    const body = JSON.stringify({ query: "slow body" });

    const answered = new Promise<{
      readonly status: number;
      readonly body: string;
    }>((resolve, reject) => {
      const outgoing = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: "/v1/context/resolve",
          method: "POST",
          headers: { "content-length": Buffer.byteLength(body) },
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
          incoming.on("end", () =>
            resolve({
              status: incoming.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        },
      );
      outgoing.once("error", reject);
      outgoing.write(body.slice(0, 1));
      void waitFor(() => requestArrived).then(() => {
        clock.advance(3_000);
        outgoing.end(body.slice(1));
      }, reject);
    });

    const response = await answered;
    expect(response.status).toBe(504);
    expect(JSON.parse(response.body)).toEqual({
      error: { code: "deadline_exceeded", retriable: true },
    });
    expect(started).toBe(0);
  });

  it("replaces a success serialized after the total deadline", async () => {
    const clock = new ManualRuntimeClock();
    const control = new DaemonRuntimeControl({ clock });
    const lateResolution = Object.defineProperty({}, "payloadSchemaVersion", {
      enumerable: true,
      get: () => {
        clock.advance(3_000);
        return 3;
      },
    }) as ContextResolution;
    const port = await listen(
      controlledServer(control, {
        resolveWithin: async () => lateResolution,
      }),
    );

    const response = await post(port, "late serialization");
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({
      error: { code: "deadline_exceeded", retriable: true },
    });
  });

  it("propagates a disconnected caller into running work", async () => {
    const control = new DaemonRuntimeControl();
    let observed: AbortSignal | undefined;
    const port = await listen(
      controlledServer(control, {
        resolveWithin: async (_request, budget) => {
          const stage = budget.stageSignal(budget.managedSearchMs);
          observed = stage.signal;
          try {
            await new Promise<void>((resolve) => {
              stage.signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
          } finally {
            stage.dispose();
          }
          return EMPTY_RESOLUTION;
        },
      }),
    );
    const body = JSON.stringify({ query: "disconnect" });
    const outgoing = httpRequest({
      host: "127.0.0.1",
      port,
      path: "/v1/context/resolve",
      method: "POST",
      headers: { "content-length": Buffer.byteLength(body) },
    });
    outgoing.on("error", () => undefined);
    outgoing.end(body);

    await waitFor(() => observed !== undefined);
    outgoing.destroy();
    await waitFor(() => observed?.aborted === true && control.resolve.idle);
    expect(observed?.aborted).toBe(true);
  });
});
