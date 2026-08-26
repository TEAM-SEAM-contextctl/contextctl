import { describe, expect, it } from "vitest";

import {
  EXIT_CODES,
  operatorExitCode,
  type ExitCode,
} from "../../src/cli/exit-codes.js";
import { failed } from "../../src/cli/commands.js";

/**
 * The codes are a contract with whatever runs `contextctl`, so they are asserted.
 *
 * Not for the specific numbers — those are ours to pick — but for the two
 * properties a caller depends on: a failure never looks like success, and two
 * failures an operator would act on differently never arrive as the same value.
 * Before this mapping existed the CLI folded four Registry statuses into `1`, so
 * a release gate that did not pass and a mistyped flag were indistinguishable to
 * CI, which is the reason `gate_failed` was given its own status in the first
 * place.
 */
describe("exit codes", () => {
  it("gives every failure a code of its own", () => {
    const codes = Object.values(EXIT_CODES).filter((code) => code !== EXIT_CODES.ok);

    expect(new Set(codes).size).toBe(codes.length);
  });

  it("reserves zero for success", () => {
    for (const [name, code] of Object.entries(EXIT_CODES)) {
      if (name === "ok") {
        expect(code).toBe(0);
      } else {
        expect(code).not.toBe(0);
      }
    }
  });

  it.each([
    ["ok", EXIT_CODES.ok],
    ["refused", EXIT_CODES.refused],
    ["usage_error", EXIT_CODES.usageError],
    ["gate_failed", EXIT_CODES.gateFailed],
  ] as const)("maps the %s status to its own code", (status, expected) => {
    expect(operatorExitCode(status)).toBe(expected);
  });

  it("tells a failed release gate apart from a refused decision", () => {
    // The distinction CI depends on. `refused` means Registry applied a rule —
    // an operator fixes the request. `gate_failed` means the reachability gate
    // did not pass, which stops a release.
    expect(operatorExitCode("gate_failed")).not.toBe(operatorExitCode("refused"));
  });

  it("does not report an ordinary operational failure as a Registry refusal", () => {
    const outcome = failed("dependency unavailable");

    expect(outcome.exitCode).toBe(EXIT_CODES.genericFailure);
    expect(outcome.exitCode).not.toBe(EXIT_CODES.refused);
  });

  it("tells a gap apart from a fork", () => {
    // A gap clears itself when the missing Publication is delivered; a fork
    // waits for a person to decide which successor the Source follows. A script
    // that retried both would spin forever on the second.
    expect(EXIT_CODES.chainDeferred).not.toBe(EXIT_CODES.chainForked);
  });

  it("has no code outside the type", () => {
    // The type is derived from the table, so this only fails if someone widens
    // one without the other — at which point a caller could return a number no
    // consumer was told about.
    const codes: readonly ExitCode[] = Object.values(EXIT_CODES);

    expect(codes.every((code) => Number.isInteger(code) && code >= 0)).toBe(true);
  });
});
