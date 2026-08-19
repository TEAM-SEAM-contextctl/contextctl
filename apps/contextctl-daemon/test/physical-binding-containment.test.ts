import type {
  ApprovedCardCatalogSnapshot,
  CardStore,
  RetrievalScope,
} from "@contextctl/registry-lifecycle";
import { describe, expect, it } from "vitest";

import { RegistryApprovedCardCatalog } from "../src/adapters/registry-approved-card-catalog.js";

/**
 * The boundary where a physical binding actually exists, and stops.
 *
 * Selection's own tests can no longer prove containment: `connectorId` and
 * `accessHandle` are absent from its read model, so nothing there can even
 * construct the values it would then check for. The proof has to live where the
 * values are real, and that is here. Registry still consumes Publication v1 and
 * still carries both fields on `DocumentIndexRef`; this adapter is the one place
 * that reads a Registry Card and hands back a Selection Card, so it is the one
 * place where "the daemon received a credential-bearing coordinate and did not
 * pass it on" is a statement about behaviour rather than about a type.
 *
 * It matters that the fixture below keeps the two fields. Deleting them to make
 * the file shorter would leave a test that passes because nothing was ever there
 * — exactly the empty guard this replaces.
 */

const CONNECTOR_ID = "vector.local";
const ACCESS_HANDLE = "documents/payments/indexes/aaaa";

/** A Registry Scope as Registry really produces it: physical binding included. */
const registryScope: RetrievalScope = {
  kind: "managed_document",
  reference: { scopeId: "scope_payments", scopeVersion: "scpv_aaaa" },
  documentIndex: {
    documentIndexId: "didx_payments",
    sourceId: "src_payments",
    documentId: "doc_payments",
    indexVersion: "idxv_aaaa",
    connectorId: CONNECTOR_ID,
    accessHandle: ACCESS_HANDLE,
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
  it("is handed a connector and an access handle by Registry", async () => {
    // Asserted first, and about the input rather than the output. Without it
    // every assertion below would also hold for an adapter that was handed
    // nothing, and the file would prove containment of an empty set.
    expect(registryScope.kind).toBe("managed_document");
    if (registryScope.kind !== "managed_document") return;
    expect(registryScope.documentIndex.connectorId).toBe(CONNECTOR_ID);
    expect(registryScope.documentIndex.accessHandle).toBe(ACCESS_HANDLE);
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
    "drops the %s key at every depth of the translated Card",
    async (forbidden) => {
      const translated = await new RegistryApprovedCardCatalog(cards).listApprovedCards();

      // Walked rather than checked where the field used to sit. An adapter that
      // relocated the binding onto the Card root, or onto a Scope of another
      // kind, would satisfy a positional check and leak just as much.
      expect([...collectKeys(translated)]).not.toContain(forbidden);
    },
  );

  it.each([CONNECTOR_ID, ACCESS_HANDLE])(
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
