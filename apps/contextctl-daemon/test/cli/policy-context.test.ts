import { DEFAULT_POLICY_CONTEXT } from "@contextctl/selection-delivery";
import { describe, expect, it } from "vitest";

import {
  PolicyContextConfigurationError,
  resolvePolicyContext,
  SENSITIVE_ACCESS_VARIABLE,
} from "../../src/cli/policy-context.js";

describe("resolvePolicyContext", () => {
  it("denies sensitive access when nothing is configured", () => {
    expect(resolvePolicyContext({})).toBe(DEFAULT_POLICY_CONTEXT);
    expect(resolvePolicyContext({})).toEqual({
      usage: "retrieval",
      sensitiveAccess: "deny",
    });
  });

  it("treats a blank value as unset, like every other variable", () => {
    expect(resolvePolicyContext({ [SENSITIVE_ACCESS_VARIABLE]: "   " })).toEqual(
      DEFAULT_POLICY_CONTEXT,
    );
  });

  it("reads the two defined values", () => {
    expect(resolvePolicyContext({ [SENSITIVE_ACCESS_VARIABLE]: "deny" })).toEqual({
      usage: "retrieval",
      sensitiveAccess: "deny",
    });
    expect(resolvePolicyContext({ [SENSITIVE_ACCESS_VARIABLE]: "allow" })).toEqual({
      usage: "retrieval",
      sensitiveAccess: "allow",
    });
  });

  it.each(["Allow", "ALLOW", "yes", "true", "1", "permit", "deny,allow"])(
    "refuses %j instead of reading it as the default",
    (value) => {
      let caught: unknown;
      try {
        resolvePolicyContext({ [SENSITIVE_ACCESS_VARIABLE]: value });
      } catch (error: unknown) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(PolicyContextConfigurationError);
      const failure = caught as PolicyContextConfigurationError;
      expect(failure.code).toBe("sensitive_access_invalid");
      expect(failure.message).toContain(SENSITIVE_ACCESS_VARIABLE);
      expect(failure.message).toContain(JSON.stringify(value));
    },
  );

  it("never lets the usage be configured", () => {
    // The only variable is about sensitivity; usage stays the literal the
    // domain fixes, whatever else the environment says.
    expect(
      resolvePolicyContext({
        [SENSITIVE_ACCESS_VARIABLE]: "allow",
        CONTEXTCTL_USAGE: "summary",
        CONTEXTCTL_POLICY_USAGE: "summary",
      }).usage,
    ).toBe("retrieval");
  });
});
