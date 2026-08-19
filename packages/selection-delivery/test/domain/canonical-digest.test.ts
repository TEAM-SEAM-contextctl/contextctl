import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  canonicalDigest,
  canonicalJson,
} from "../../src/domain/canonical-digest.js";
import { CanonicalDigestInvariantError } from "../../src/domain/errors.js";

describe("canonicalJson", () => {
  it("sorts object keys rather than preserving insertion order", () => {
    // The property the whole key scheme rests on: two code paths that assign
    // the same fields in a different order must produce one string.
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
  });

  it("sorts keys by UTF-16 code units, not by a locale collation", () => {
    // `localeCompare` puts "a" before "B" under most locales; RFC 8785 does not,
    // and a digest that depended on the runtime's locale would not be a digest.
    expect(canonicalJson({ a: 1, B: 2 })).toBe('{"B":2,"a":1}');
  });

  it("sorts nested objects too", () => {
    expect(canonicalJson({ outer: { z: 1, a: 2 } })).toBe(
      '{"outer":{"a":2,"z":1}}',
    );
  });

  it("preserves array order, which is part of the value", () => {
    expect(canonicalJson(["b", "a"])).toBe('["b","a"]');
    expect(canonicalJson(["a", "b"])).toBe('["a","b"]');
  });

  it("emits no whitespace", () => {
    expect(canonicalJson({ a: [1, 2], b: "x" })).toBe('{"a":[1,2],"b":"x"}');
  });

  it("omits an undefined property rather than writing it as null", () => {
    // Under `exactOptionalPropertyTypes` an absent optional field and one set
    // to `undefined` are the same absence, so they have to digest alike.
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalDigest({ a: 1, b: undefined })).toBe(
      canonicalDigest({ a: 1 }),
    );
  });

  it("writes an undefined array element as null rather than shortening the array", () => {
    expect(canonicalJson([1, undefined, 2])).toBe("[1,null,2]");
  });

  it("normalizes negative zero to zero", () => {
    expect(canonicalJson(-0)).toBe("0");
    expect(canonicalDigest(-0)).toBe(canonicalDigest(0));
  });

  it("escapes strings the way JSON does", () => {
    expect(canonicalJson('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(canonicalJson("\n")).toBe('"\\n"');
  });

  it("keeps non-ASCII text as itself, since the digest is over UTF-8 bytes", () => {
    expect(canonicalJson("환불")).toBe('"환불"');
  });

  it("writes null, booleans and integers plainly", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(false)).toBe("false");
    expect(canonicalJson(8)).toBe("8");
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "refuses %s rather than writing it as null",
    (value) => {
      // `JSON.stringify` answers `null` for all three, which would make them
      // digest identically to each other and to a real null.
      expect(() => canonicalJson(value)).toThrow(CanonicalDigestInvariantError);
    },
  );

  it("refuses a bigint and a symbol, which have no canonical form", () => {
    expect(() => canonicalJson(1n)).toThrow(CanonicalDigestInvariantError);
    expect(() => canonicalJson(Symbol("x"))).toThrow(
      CanonicalDigestInvariantError,
    );
  });
});

describe("canonicalDigest", () => {
  it("is sha256 over the canonical form, prefixed and lowercase hex", () => {
    const value = { b: 1, a: "환불" };
    const expected = createHash("sha256")
      .update(canonicalJson(value), "utf8")
      .digest("hex");

    expect(canonicalDigest(value)).toBe(`sha256:${expected}`);
    expect(canonicalDigest(value)).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("is equal for two values that differ only in key order", () => {
    expect(canonicalDigest({ x: 1, y: 2 })).toBe(canonicalDigest({ y: 2, x: 1 }));
  });

  it("differs for values that differ at all", () => {
    expect(canonicalDigest({ limit: 8 })).not.toBe(canonicalDigest({ limit: 9 }));
  });
});
