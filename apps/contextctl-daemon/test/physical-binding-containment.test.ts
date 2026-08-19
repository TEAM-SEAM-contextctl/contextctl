import type {
  ApprovedCardCatalogSnapshot,
  CardStore,
  RetrievalScope,
} from "@contextctl/registry-lifecycle";
import { describe, expect, it } from "vitest";

import { RegistryApprovedCardCatalog } from "../src/adapters/registry-approved-card-catalog.js";

/**
 * The physical binding is now absent from both sides of this boundary.
 *
 * This file was written when Registry still consumed Publication v1 and still
 * carried `connectorId` and `accessHandle` on its `DocumentIndexRef`. The proof
 * it needed then was behavioural — "the daemon was handed a credential-bearing
 * coordinate and did not pass it on" — and its own comment warned that deleting
 * the fields from the fixture would leave a test passing because nothing was
 * ever there.
 *
 * Registry consuming v2 is not that deletion. The values are gone from the
 * contract, from Registry's read model, and from Selection's, so there is no
 * fixture that can carry them and no adapter line that could forward them. What
 * replaces the behavioural proof is a structural one, which is why the two
 * assertions below are about the shape of the types rather than about a value
 * surviving a copy: a future edit that puts either field back has to fail the
 * build, and `@ts-expect-error` is what makes that a test rather than a hope.
 *
 * The serialized-output checks are kept. They are the ones that still catch
 * something a type cannot: a binding smuggled through under another name.
 */

const registryScope: RetrievalScope = {
  kind: "managed_document",
  reference: { scopeId: "scope_payments", scopeVersion: "scpv_aaaa" },
  documentIndex: {
    documentIndexId: "didx_payments",
    sourceId: "src_payments",
    documentId: "doc_payments",
    indexVersion: "idxv_aaaa",
  },
  selection: { kind: "document" },
};

const snapshot: ApprovedCardCatalogSnapshot = {
  catalogSnapshotVersion: "cat_aaaa",
  cards: [
    {
      cardId: "card_payments",
      versionId: "crv_aaaa",
      meaning: {
        description: "결제 재시도 정책",
        representativeQuestions: ["결제는 몇 번 재시도하나요?"],
        aliases: ["payments"],
        keywords: ["payment"],
      },
      policy: { sensitive: false, allowedUsage: ["retrieval"] },
      scopes: [registryScope],
    },
  ],
};

/**
 * Answers with the snapshot above and refuses everything else.
 *
 * The unused methods throw rather than returning a benign empty value: a stub
 * that quietly answered a call this test did not intend would let the adapter
 * take a path nobody is asserting about.
 */
const cards: CardStore = {
  listApprovedCards: async () => snapshot,
  findCard: () => {
    throw new Error("findCard is not part of this test");
  },
  listCurrentVersions: () => {
    throw new Error("listCurrentVersions is not part of this test");
  },
  saveCard: () => {
    throw new Error("saveCard is not part of this test");
  },
};

/** Every key name reachable from `value`, objects and arrays alike. */
function collectKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
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

describe("physical binding containment at the Registry boundary", () => {
  it("cannot be given a connector or an access handle by Registry", () => {
    if (registryScope.kind !== "managed_document") {
      throw new Error("fixture must be a managed document Scope");
    }

    // Restoring either field must break the build. If one is ever added back to
    // `DocumentIndexRef`, these directives stop erroring and TS2578 fails this
    // test — which is the same signal, arriving from the other direction.
    // @ts-expect-error the physical binding is absent from Registry's read model
    expect(registryScope.documentIndex.connectorId).toBeUndefined();
    // @ts-expect-error the physical binding is absent from Registry's read model
    expect(registryScope.documentIndex.accessHandle).toBeUndefined();
  });

  it("returns the four logical coordinates and nothing else", async () => {
    const [card] = await new RegistryApprovedCardCatalog(cards).listApprovedCards();
    const scope = card?.scopes[0];
    if (scope?.kind !== "managed_document") {
      throw new Error("the adapter must return one managed document Scope");
    }

    expect(Object.keys(scope.documentIndex).sort()).toEqual([
      "documentId",
      "documentIndexId",
      "indexVersion",
      "sourceId",
    ]);
  });

  it.each(["connectorId", "accessHandle"])(
    "carries no %s key at any depth of the translated Card",
    async (forbidden) => {
      const translated = await new RegistryApprovedCardCatalog(cards).listApprovedCards();

      // Walked rather than checked where the field used to sit. An adapter that
      // relocated the binding onto the Card root, or onto a Scope of another
      // kind, would satisfy a positional check and leak just as much.
      expect([...collectKeys(translated)]).not.toContain(forbidden);
    },
  );

  it.each(["vector.local", "documents/payments/indexes/aaaa"])(
    "carries the value %s nowhere in the serialized Card",
    async (forbidden) => {
      const translated = await new RegistryApprovedCardCatalog(cards).listApprovedCards();

      // By value and against the serialized form, because the key check above
      // cannot see a binding smuggled into a differently named field — and a
      // Selection Card is serialized into responses and embedded into vectors,
      // both of which outlive the request that produced them.
      expect(JSON.stringify(translated)).not.toContain(forbidden);
    },
  );
});
