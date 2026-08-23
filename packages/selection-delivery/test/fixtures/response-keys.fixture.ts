/**
 * Key-walking helpers for tests about the shape of a serialized response.
 *
 * Shared because three surface suites and the domain suite each need to ask
 * "which key names appear anywhere in this payload?", and four private copies
 * of the same walk would be four places for one of them to stop descending
 * into arrays.
 */

export type JsonObject = Readonly<Record<string, unknown>>;

/** Every key name reachable from `value`, through objects and arrays alike. */
export function collectKeys(
  value: unknown,
  into: Set<string> = new Set(),
): Set<string> {
  if (Array.isArray(value)) {
    for (const element of value) {
      collectKeys(element, into);
    }
    return into;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, nested] of Object.entries(value)) {
      into.add(key);
      collectKeys(nested, into);
    }
  }
  return into;
}
