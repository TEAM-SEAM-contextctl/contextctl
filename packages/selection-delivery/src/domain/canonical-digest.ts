import { createHash } from "node:crypto";

import { CanonicalDigestInvariantError } from "./errors.js";

/**
 * The canonical digest every key in a Selection Plan is built with.
 *
 * A plan travels from Selection to the daemon and back into Delivery as three
 * separate values — a planned item, a search target, and the outcome that comes
 * back — and each of the three has to be re-joined to the others without any of
 * them carrying the others' payload. A digest over the thing itself is what
 * makes that join total: two runs that selected the same Scope under the same
 * bound produce the same key on any machine, and no counter, no ordinal, and no
 * position in an array has to survive the round trip.
 *
 * RFC 8785 rather than `JSON.stringify`: `JSON.stringify` serializes object
 * properties in insertion order, so the same guide built by two code paths that
 * assign fields in a different order would digest differently, and the join
 * would silently produce two items where there is one Scope.
 *
 * `sha256:` is carried in the value rather than assumed by the reader, so a
 * later change of hash is visible in the data instead of being a silent
 * reinterpretation of existing keys.
 */
export const CANONICAL_DIGEST_PREFIX = "sha256:";

/**
 * Digests a value under RFC 8785, as `sha256:<lowercase-hex>`.
 *
 * Lowercase hex rather than base32 or base64url: it is what the canonicalization
 * scheme's own examples use, and a key that appears in a log line is compared by
 * eye more often than it is parsed.
 */
export function canonicalDigest(value: unknown): string {
  return `${CANONICAL_DIGEST_PREFIX}${createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex")}`;
}

/**
 * Serializes a value under the JSON Canonicalization Scheme (RFC 8785).
 *
 * Written here rather than taken from a package, and deliberately not imported
 * from `ingestion-indexing` even though an equivalent function lives there: ADR
 * 0005 keeps this package free of runtime dependencies, and the boundary test
 * forbids one domain package from reaching into another. The scheme is small
 * enough that restating it costs less than either exception would.
 *
 * Three rules do the work. Object keys are sorted by their UTF-16 code units,
 * which is what `Array.prototype.sort` does by default and what RFC 8785 §3.2.3
 * specifies. Numbers are serialized by ECMAScript's own `JSON.stringify`, which
 * §3.2.2.3 adopts wholesale. Strings are escaped by `JSON.stringify` for the
 * same reason. Nothing else is emitted — no whitespace, no trailing separators.
 *
 * Three inputs are refused rather than approximated, because each one has no
 * canonical form and would otherwise produce a key that is stable only by
 * accident: a non-finite number (`JSON.stringify` answers `null` for it, so
 * `NaN` and `Infinity` would collide), a `bigint` (which `JSON.stringify`
 * throws on anyway, but with a message that says nothing about digests), and a
 * function or symbol (which `JSON.stringify` drops silently, so a value would
 * digest as if the field were absent).
 */
export function canonicalJson(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    // An array element that would be dropped from an object — `undefined`, a
    // function — is `null` in JSON, and it is written as `null` here too rather
    // than omitted, because dropping it would shorten the array.
    return `[${value.map((element) => canonicalJson(element ?? null)).join(",")}]`;
  }
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new CanonicalDigestInvariantError(
          `a non-finite number has no canonical form, received ${String(value)}`,
        );
      }
      // `JSON.stringify` normalizes -0 to "0", which is what RFC 8785 requires:
      // the two are the same number and must not digest differently.
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object":
      return canonicalObject(value as Readonly<Record<string, unknown>>);
    default:
      throw new CanonicalDigestInvariantError(
        `a value of type ${typeof value} has no canonical form`,
      );
  }
}

/**
 * `{"a":1,"b":2}` with keys in UTF-16 code unit order and absent values gone.
 *
 * A property whose value is `undefined` is omitted rather than written as
 * `null`, matching `JSON.stringify`: under `exactOptionalPropertyTypes` an
 * optional field that was never set and one explicitly set to `undefined` are
 * the same absence, and they must digest the same way.
 */
function canonicalObject(record: Readonly<Record<string, unknown>>): string {
  const entries = Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);

  return `{${entries.join(",")}}`;
}
