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
      runtime: { control, contextApplication },
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
});
