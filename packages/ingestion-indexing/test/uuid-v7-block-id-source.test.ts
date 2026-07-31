import { describe, expect, it } from "vitest";

import { UuidV7BlockIdSource } from "../src/index.js";

describe("UUIDv7 Block IDs", () => {
  it("emits a deterministic RFC 9562 version and variant shape through injected seams", () => {
    const ids = new UuidV7BlockIdSource({
      now: () => 1_700_000_000_000,
      random: (size) => Uint8Array.from({ length: size }, (_, index) => index),
    });

    expect(ids.nextBlockId()).toBe(
      "blk_018bcfe5-6800-7001-8203-040506070809",
    );
  });

  it("rejects invalid clocks and random sources", () => {
    expect(() =>
      new UuidV7BlockIdSource({ now: () => -1 }).nextBlockId(),
    ).toThrow("UUIDv7 timestamp must fit the unsigned 48-bit field");
    expect(() =>
      new UuidV7BlockIdSource({
        now: () => 0x1_0000_0000_0000,
      }).nextBlockId(),
    ).toThrow("UUIDv7 timestamp must fit the unsigned 48-bit field");
    expect(() =>
      new UuidV7BlockIdSource({
        random: () => new Uint8Array(9),
      }).nextBlockId(),
    ).toThrow("UUIDv7 random source must return 10 bytes");
  });
});
