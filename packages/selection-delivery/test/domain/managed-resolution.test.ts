import { describe, expect, it } from "vitest";

import { ManagedResolutionInvariantError } from "../../src/domain/errors.js";
import {
  assertOpaqueFailure,
  MANAGED_FAILURE_CODE_PATTERN,
  type ManagedResolutionFailure,
} from "../../src/domain/managed-resolution.js";

function failure(
  overrides: Partial<ManagedResolutionFailure> = {},
): ManagedResolutionFailure {
  return {
    stage: "managed_search",
    code: "index_binding_unavailable",
    retriable: true,
    ...overrides,
  };
}

describe("assertOpaqueFailure", () => {
  /**
   * The seventeen codes Indexing's batch search declares.
   *
   * Listed here as data a test reads rather than as a union this package
   * declares, which is the difference the whole rule turns on: Delivery accepts
   * them because they fit the token grammar, not because it recognises them.
   * A code added upstream has to pass without this file changing.
   */
  const UPSTREAM_CODES = [
    "cancelled",
    "embedding_artifact_unavailable",
    "embedding_provider_not_allowed",
    "index_binding_invalid",
    "index_binding_unavailable",
    "index_catalog_corrupt",
    "index_catalog_unavailable",
    "index_schema_unsupported",
    "invalid_request",
    "query_embedding_failed",
    "query_embedding_invalid",
    "query_input_limit_exceeded",
    "scope_not_published",
    "search_result_invalid",
    "security_domain_mismatch",
    "unexpected_failure",
    "vector_search_unavailable",
  ];

  it.each(UPSTREAM_CODES)("accepts %s without recognising it", (code) => {
    expect(() => assertOpaqueFailure(failure({ code }))).not.toThrow();
  });

  it("accepts a code no upstream has declared yet", () => {
    // The property that makes this a grammar rather than a copied list: a code
    // invented next week is accepted today, and is printed as itself.
    expect(() =>
      assertOpaqueFailure(failure({ code: "a_code_nobody_has_written_yet" })),
    ).not.toThrow();
  });

  it("accepts both stages", () => {
    expect(() => assertOpaqueFailure(failure({ stage: "deadline" }))).not.toThrow();
    expect(() =>
      assertOpaqueFailure(failure({ stage: "managed_search" })),
    ).not.toThrow();
  });

  it.each([
    ["an empty code", ""],
    ["a leading digit", "1_broken"],
    ["a leading underscore", "_broken"],
    ["an uppercase letter", "Index_Unavailable"],
    ["a hyphen", "index-unavailable"],
    ["a space", "index unavailable"],
    ["a dot", "index.unavailable"],
    ["a newline", "index\nunavailable"],
  ])("refuses %s", (_name, code) => {
    expect(() => assertOpaqueFailure(failure({ code }))).toThrow(
      ManagedResolutionInvariantError,
    );
  });

  it("accepts a code of exactly 64 characters and refuses 65", () => {
    const boundary = `a${"b".repeat(63)}`;

    expect(boundary).toHaveLength(64);
    expect(() => assertOpaqueFailure(failure({ code: boundary }))).not.toThrow();
    expect(() =>
      assertOpaqueFailure(failure({ code: `${boundary}c` })),
    ).toThrow(ManagedResolutionInvariantError);
  });

  it("refuses a retriable flag that is not a boolean", () => {
    expect(() =>
      assertOpaqueFailure(
        failure({ retriable: "yes" as unknown as boolean }),
      ),
    ).toThrow(ManagedResolutionInvariantError);
  });

  it("names the offending code in the error, for whoever wrote the adapter", () => {
    expect(() => assertOpaqueFailure(failure({ code: "Bad Code" }))).toThrow(
      /"Bad Code"/u,
    );
  });
});

describe("MANAGED_FAILURE_CODE_PATTERN", () => {
  it("is anchored at both ends, so no prefix or suffix slips past", () => {
    expect(MANAGED_FAILURE_CODE_PATTERN.test("ok_code")).toBe(true);
    expect(MANAGED_FAILURE_CODE_PATTERN.test("ok_code!")).toBe(false);
    expect(MANAGED_FAILURE_CODE_PATTERN.test("!ok_code")).toBe(false);
  });

  it("carries no global flag, so repeated tests do not alternate", () => {
    // A `g` flag would make `test` stateful and every second call answer false.
    expect(MANAGED_FAILURE_CODE_PATTERN.global).toBe(false);
    expect(MANAGED_FAILURE_CODE_PATTERN.test("ok_code")).toBe(true);
    expect(MANAGED_FAILURE_CODE_PATTERN.test("ok_code")).toBe(true);
  });
});
