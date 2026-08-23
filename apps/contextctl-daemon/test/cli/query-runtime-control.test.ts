import { describe, expect, it } from "vitest";

import type { ContextResolution } from "@contextctl/selection-delivery";

import { runQuery } from "../../src/cli/commands.js";
import type { CliRuntime } from "../../src/cli/runtime.js";
import { ManualRuntimeClock } from "../../src/runtime/clock.js";
import {
  AdmissionControlledResolve,
  DaemonRuntimeControl,
} from "../../src/runtime/runtime-control.js";

describe("query CLI runtime control", () => {
  it("does not print a success serialized after the total deadline", async () => {
    const clock = new ManualRuntimeClock();
    const control = new DaemonRuntimeControl({ clock });
    const resolution = Object.defineProperty({}, "payloadSchemaVersion", {
      enumerable: true,
      get: () => {
        clock.advance(3_000);
        return 3;
      },
    }) as ContextResolution;
    const contextApplication = new AdmissionControlledResolve(control, {
      resolveWithin: async () => resolution,
    });
    const cli = {
      runtime: {
        control,
        contextApplication,
        prepareStateReadiness: async () => undefined,
        prepareCardCandidates: async () => undefined,
      },
    } as unknown as CliRuntime;

    const outcome = await runQuery(cli, {
      kind: "query",
      text: "late serialization",
      json: true,
    });

    expect(outcome.exitCode).toBe(7);
    expect(JSON.parse(outcome.stdout)).toEqual({
      code: "deadline_exceeded",
      retriable: true,
    });
    expect(outcome.stderr).toEqual([
      "질의를 처리하지 못했습니다: deadline_exceeded (재시도 가능)",
    ]);
  });

  it("refuses an oversized request before candidate preparation", async () => {
    const control = new DaemonRuntimeControl();
    let preparations = 0;
    let resolutions = 0;
    const cli = {
      runtime: {
        control,
        contextApplication: {
          resolveContext: async () => {
            resolutions += 1;
            return { payloadSchemaVersion: 3 } as unknown as ContextResolution;
          },
        },
        prepareStateReadiness: async () => undefined,
        prepareCardCandidates: async () => {
          preparations += 1;
        },
      },
    } as unknown as CliRuntime;

    const outcome = await runQuery(cli, {
      kind: "query",
      text: "가".repeat(64 * 1024),
      json: true,
    });

    expect(outcome.exitCode).toBe(7);
    expect(JSON.parse(outcome.stdout)).toEqual({
      code: "invalid_request",
      retriable: false,
    });
    expect(preparations).toBe(0);
    expect(resolutions).toBe(0);
  });

  it("does not print an oversized response partially", async () => {
    const control = new DaemonRuntimeControl();
    const contextApplication = new AdmissionControlledResolve(control, {
      resolveWithin: async () =>
        ({ value: "x".repeat(2 * 1024 * 1024) }) as unknown as ContextResolution,
    });
    const cli = {
      runtime: {
        control,
        contextApplication,
        prepareStateReadiness: async () => undefined,
        prepareCardCandidates: async () => undefined,
      },
    } as unknown as CliRuntime;

    const outcome = await runQuery(cli, {
      kind: "query",
      text: "oversized response",
      json: true,
    });

    expect(outcome.exitCode).toBe(7);
    expect(JSON.parse(outcome.stdout)).toEqual({
      code: "unexpected_failure",
      retriable: false,
    });
    expect(outcome.stderr).toEqual([
      "질의를 처리하지 못했습니다: unexpected_failure",
    ]);
  });
});
