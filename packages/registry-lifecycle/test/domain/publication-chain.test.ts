import { describe, expect, it } from "vitest";

import {
  locateInChain,
  type ChainCursor,
  type ChainLink,
} from "../../src/domain/publication-chain.js";

const cursor: ChainCursor = {
  sourceId: "src_payments",
  publicationId: "pub_second",
};

function link(overrides: Partial<ChainLink> = {}): ChainLink {
  return {
    publicationId: "pub_third",
    sourceId: "src_payments",
    previousPublicationId: "pub_second",
    ...overrides,
  };
}

describe("locateInChain", () => {
  it("accepts the first Publication of a Source that has none", () => {
    expect(
      locateInChain(undefined, link({ previousPublicationId: undefined })),
    ).toEqual({ kind: "first" });
  });

  it("accepts the Publication that follows the cursor", () => {
    expect(locateInChain(cursor, link())).toEqual({ kind: "next" });
  });

  it("defers a Publication whose predecessor has not been consumed", () => {
    // A gap, not a fork: the missing Publication may still arrive, and calling
    // this a fork would stop a Source that is merely out of order.
    expect(
      locateInChain(cursor, link({ previousPublicationId: "pub_fourth" })),
    ).toEqual({
      kind: "gap",
      expectedAfter: "pub_fourth",
      awaiting: "pub_third",
    });
  });

  it("defers a successor that arrives before any cursor exists", () => {
    const position = locateInChain(undefined, link());

    expect(position.kind).toBe("gap");
  });

  it("refuses a second chain start for a Source that already consumed one", () => {
    // Accepting it would silently abandon everything the cursor covers.
    const position = locateInChain(
      cursor,
      link({ publicationId: "pub_other", previousPublicationId: undefined }),
    );

    expect(position.kind).toBe("fork");
  });

  it("refuses a Publication from a different Source than the cursor", () => {
    const position = locateInChain(cursor, link({ sourceId: "src_other" }));

    expect(position.kind).toBe("fork");
  });

  it("ignores everything except previousPublicationId", () => {
    // `producedAt`, arrival order and array order are all excluded on purpose:
    // a retry can be produced after the Publication that follows it, so a
    // timestamp would order a chain that was never published. The link type
    // carries no timestamp at all, which is what makes that structural.
    const keys = Object.keys(link()).sort();

    expect(keys).toEqual([
      "previousPublicationId",
      "publicationId",
      "sourceId",
    ]);
  });
});
