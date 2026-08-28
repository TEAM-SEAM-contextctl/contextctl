export const SUPPORTED_NODE_VERSION = {
  minimum: { major: 24, minor: 18, patch: 0 },
  maximumExclusive: { major: 25, minor: 0, patch: 0 },
  display: ">=24.18.0 <25",
} as const;

interface StableNodeVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/** True only for stable Node releases in the public package support range. */
export function isSupportedNodeVersion(value: string): boolean {
  const version = parseStableNodeVersion(value);
  if (version === undefined) return false;
  return (
    compareVersion(version, SUPPORTED_NODE_VERSION.minimum) >= 0 &&
    compareVersion(version, SUPPORTED_NODE_VERSION.maximumExclusive) < 0
  );
}

function parseStableNodeVersion(value: string): StableNodeVersion | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(value);
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
    return undefined;
  }
  const version = {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
  return Object.values(version).every(Number.isSafeInteger) ? version : undefined;
}

function compareVersion(left: StableNodeVersion, right: StableNodeVersion): number {
  return (
    left.major - right.major ||
    left.minor - right.minor ||
    left.patch - right.patch
  );
}
