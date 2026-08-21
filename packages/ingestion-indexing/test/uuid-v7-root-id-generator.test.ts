import { describe, expect, it } from "vitest";

import { UuidV7RootIdGenerator } from "../src/index.js";

const UUID_V7_ID = /^(src|doc|obs|pub)_[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

describe("UUIDv7 root identity generator", () => {
  it("issues distinct correctly-prefixed UUIDv7 identities", () => {
    let nextByte = 0;
    const ids = new UuidV7RootIdGenerator({
      now: () => Number.parseInt("01890f5c7b1a", 16),
      random: (size) =>
        Uint8Array.from({ length: size }, () => nextByte++ % 256),
    });

    const generated = [
      ids.nextSourceId(),
      ids.nextDocumentId(),
      ids.nextObservationId(),
      ids.nextPublicationId(),
    ];

    expect(generated.every((value) => UUID_V7_ID.test(value))).toBe(true);
    expect(new Set(generated).size).toBe(generated.length);
  });

  it("rejects invalid clocks and entropy providers before issuing an ID", () => {
    expect(() =>
      new UuidV7RootIdGenerator({ now: () => -1 }).nextSourceId(),
    ).toThrow(RangeError);
    expect(() =>
      new UuidV7RootIdGenerator({ random: () => new Uint8Array(9) })
        .nextPublicationId(),
    ).toThrow(RangeError);
  });
});
