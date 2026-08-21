import { describe, expect, it } from "vitest";

import { UuidV7StructuralIdGenerator } from "../src/index.js";

const UUID_V7_STRUCTURAL_ID =
  /^(blk|unit|chk)_[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

describe("UUIDv7 structural identity generator", () => {
  it("issues distinct Block, Semantic Unit and Managed Chunk identities", () => {
    let nextByte = 0;
    const ids = new UuidV7StructuralIdGenerator({
      now: () => Number.parseInt("01890f5c7b1a", 16),
      random: (size) =>
        Uint8Array.from({ length: size }, () => nextByte++ % 256),
    });

    const generated = [
      ids.nextBlockId(),
      ids.nextUnitId(),
      ids.nextChunkId(),
    ];

    expect(generated.every((value) => UUID_V7_STRUCTURAL_ID.test(value))).toBe(
      true,
    );
    expect(new Set(generated).size).toBe(generated.length);
  });

  it("rejects invalid clocks and entropy providers", () => {
    expect(() =>
      new UuidV7StructuralIdGenerator({ now: () => -1 }).nextBlockId(),
    ).toThrow(RangeError);
    expect(() =>
      new UuidV7StructuralIdGenerator({ random: () => new Uint8Array(9) })
        .nextChunkId(),
    ).toThrow(RangeError);
  });
});
