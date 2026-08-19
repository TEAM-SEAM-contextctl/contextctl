import { describe, expect, it } from "vitest";

import {
  CONSUMPTION_DIAGNOSTIC_CODE_PATTERN,
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
      diagnostic: {
        code: "publication_chain_gap",
        detail:
          "publication pub_third follows pub_fourth, which has not been consumed",
      },
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

  /**
   * Every refusal has to carry a code a program can act on.
   *
   * The design requires an operator diagnostic on a refused Publication, and it
   * defines one as a bounded machine-readable code with the logical ids — not a
   * sentence. A sentence cannot be grouped or keyed on, so a daemon receiving it
   * could not tell which lane to degrade or which refusals share a cause.
   */
  describe("diagnostics", () => {
    function diagnose(position: ReturnType<typeof locateInChain>) {
      if (position.kind !== "gap" && position.kind !== "fork") {
        throw new Error(`expected a refusal, got ${position.kind}`);
      }
      return position.diagnostic;
    }

    it("codes a missing predecessor as a gap", () => {
      expect(
        diagnose(locateInChain(cursor, link({ previousPublicationId: "pub_fourth" })))
          .code,
      ).toBe("publication_chain_gap");
    });

    it.each([
      ["a second chain start", link({ previousPublicationId: undefined })],
      ["another Source", link({ sourceId: "src_other" })],
    ])("codes %s as a fork", (_case, forking) => {
      expect(diagnose(locateInChain(cursor, forking)).code).toBe(
        "publication_chain_forked",
      );
    });

    it("keeps every code inside the grammar the daemon can rely on", () => {
      // Asserted for both refusals rather than for the constant, because the
      // grammar only buys anything if the codes actually produced satisfy it.
      const codes = [
        diagnose(locateInChain(cursor, link({ previousPublicationId: "pub_fourth" })))
          .code,
        diagnose(locateInChain(cursor, link({ sourceId: "src_other" }))).code,
      ];

      for (const code of codes) {
        expect(code).toMatch(CONSUMPTION_DIAGNOSTIC_CODE_PATTERN);
      }
    });

    it("names the colliding Publications in the detail, not in the code", () => {
      // The specific ids are what an operator needs to resolve a fork by hand,
      // and no fixed code can carry them. They belong on the other field, so a
      // consumer grouping by code does not end up with one group per collision.
      const diagnostic = diagnose(
        locateInChain(cursor, link({ sourceId: "src_other" })),
      );

      expect(diagnostic.detail).toContain("src_payments");
      expect(diagnostic.detail).toContain("src_other");
      expect(diagnostic.code).not.toContain("src_");
    });
  });
});
