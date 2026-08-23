/** Absolute UTF-8 wire ceilings shared by every public query surface. */
export const RESOLVE_REQUEST_MAXIMUM_BYTES = 64 * 1024;
export const CONTEXT_RESOLUTION_MAXIMUM_BYTES = 2 * 1024 * 1024;

/** Counts the bytes that a UTF-8 transport will actually carry. */
export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
