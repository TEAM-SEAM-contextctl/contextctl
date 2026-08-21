import { randomBytes } from "node:crypto";

export interface UuidV7Options {
  readonly now?: () => number;
  readonly random?: (size: number) => Uint8Array;
}

/** Generates a lowercase RFC 9562 UUIDv7. Time is encoded for sorting only. */
export class UuidV7Generator {
  readonly #now: () => number;
  readonly #random: (size: number) => Uint8Array;

  constructor(options: UuidV7Options = {}) {
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? randomBytes;
  }

  nextUuid(): string {
    const timestamp = this.#now();
    if (
      !Number.isSafeInteger(timestamp) ||
      timestamp < 0 ||
      timestamp > 0xffff_ffff_ffff
    ) {
      throw new RangeError("UUIDv7 timestamp must fit the unsigned 48-bit field");
    }
    const random = this.#random(10);
    if (random.byteLength !== 10) {
      throw new RangeError("UUIDv7 random source must return 10 bytes");
    }
    const bytes = new Uint8Array(16);
    let remaining = BigInt(timestamp);
    for (let index = 5; index >= 0; index -= 1) {
      bytes[index] = Number(remaining & 0xffn);
      remaining >>= 8n;
    }
    bytes[6] = 0x70 | (requiredByte(random, 0) & 0x0f);
    bytes[7] = requiredByte(random, 1);
    bytes[8] = 0x80 | (requiredByte(random, 2) & 0x3f);
    for (let index = 9; index < 16; index += 1) {
      bytes[index] = requiredByte(random, index - 6);
    }
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
      .slice(6, 8)
      .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
  }
}

function requiredByte(bytes: Uint8Array, index: number): number {
  const value = bytes[index];
  if (value === undefined) {
    throw new RangeError("UUIDv7 random source returned too few bytes");
  }
  return value;
}
