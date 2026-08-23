import { describe, expect, it } from "vitest";

import {
  assertContextResolutionCanFit,
  assertContextResolutionPayloadWithinLimit,
  assertResolveRequestPayloadWithinLimit,
  maximumContextResolutionBytes,
  serializeContextResolutionPayload,
} from "../../src/application/transport-payload.js";
import { SelectionPlanLimitExceededError } from "../../src/application/errors.js";
import { DEFAULT_CONTEXT_BUDGET } from "../../src/domain/context-assembly.js";
import {
  CONTEXT_RESOLUTION_MAXIMUM_BYTES,
  RESOLVE_REQUEST_MAXIMUM_BYTES,
  utf8ByteLength,
} from "../../src/domain/transport-policy.js";
import { selectContext } from "../../src/application/select-context.js";
import { InMemoryCardCatalog } from "../../src/infrastructure/in-memory-card-catalog.js";
import {
  createDemoCardSet,
  DEMO_QUERY,
} from "../fixtures/approved-card.fixture.js";

function jsonStringWithBytes(key: string, bytes: number): string {
  const empty = JSON.stringify({ [key]: "" });
  const available = bytes - utf8ByteLength(empty);
  if (available < 0) throw new Error("requested JSON size is too small");
  const multibyte = "가".repeat(Math.floor(available / 3));
  const remainder = "a".repeat(available % 3);
  const payload = JSON.stringify({ [key]: multibyte + remainder });
  if (utf8ByteLength(payload) !== bytes) {
    throw new Error("failed to construct exact UTF-8 fixture");
  }
  return payload;
}

describe("public query payload limits", () => {
  it("measures the 64 KiB request limit in UTF-8 bytes", () => {
    const boundary = jsonStringWithBytes("query", RESOLVE_REQUEST_MAXIMUM_BYTES);

    expect(() => assertResolveRequestPayloadWithinLimit(boundary)).not.toThrow();
    expect(() =>
      assertResolveRequestPayloadWithinLimit(`${boundary}a`),
    ).toThrowError(/byte limit/u);
  });

  it("accepts exactly 2 MiB and refuses the next response byte", () => {
    const boundary = jsonStringWithBytes(
      "value",
      CONTEXT_RESOLUTION_MAXIMUM_BYTES,
    );

    expect(() =>
      assertContextResolutionPayloadWithinLimit(boundary),
    ).not.toThrow();
    expect(() =>
      assertContextResolutionPayloadWithinLimit(`${boundary}a`),
    ).toThrowError(/byte limit/u);
  });

  it("applies the final guard while serializing a response", () => {
    const empty = JSON.stringify({ value: "" });
    const value = "x".repeat(
      CONTEXT_RESOLUTION_MAXIMUM_BYTES - utf8ByteLength(empty),
    );
    expect(
      utf8ByteLength(serializeContextResolutionPayload({ value })),
    ).toBe(CONTEXT_RESOLUTION_MAXIMUM_BYTES);
    expect(() =>
      serializeContextResolutionPayload({ value: `${value}x` }),
    ).toThrowError(/byte limit/u);
  });

  it("rejects a response budget that cannot fit before retrieval", async () => {
    const plan = await selectContext(
      { catalog: new InMemoryCardCatalog(createDemoCardSet()) },
      DEMO_QUERY,
    );

    expect(
      maximumContextResolutionBytes(plan, DEFAULT_CONTEXT_BUDGET),
    ).toBeLessThan(CONTEXT_RESOLUTION_MAXIMUM_BYTES);
    expect(() =>
      assertContextResolutionCanFit(plan, DEFAULT_CONTEXT_BUDGET),
    ).not.toThrow();

    try {
      assertContextResolutionCanFit(plan, {
        maxTotalCharacters: CONTEXT_RESOLUTION_MAXIMUM_BYTES,
        maxChunks: DEFAULT_CONTEXT_BUDGET.maxChunks,
      });
      throw new Error("expected response bound refusal");
    } catch (cause: unknown) {
      expect(cause).toBeInstanceOf(SelectionPlanLimitExceededError);
      expect(
        (cause as SelectionPlanLimitExceededError).violations,
      ).toEqual([
        expect.objectContaining({
          limit: "responseBytes",
          allowed: CONTEXT_RESOLUTION_MAXIMUM_BYTES,
        }),
      ]);
    }
  });
});
