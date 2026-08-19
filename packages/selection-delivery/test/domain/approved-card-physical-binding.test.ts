import { describe, expect, it } from "vitest";

import type {
  ApprovedCard,
  ApprovedDocumentIndexRef,
} from "../../src/domain/card-catalog.js";
import { buildCardSelectionEntry } from "../../src/domain/card-selection-text.js";
import { buildRetrievalGuide } from "../../src/domain/retrieval-guide.js";

/**
 * The approved Card read model carries no physical binding, at any depth.
 *
 * ADR 0006 excluded four fields from the public guide and noted that omitting a
 * field leaves nothing to stop a later edit from putting it back. That was true
 * while `connectorId` and `accessHandle` still existed one layer up, in the
 * catalog read model: the guard could only ever be "we chose not to copy them".
 * They are gone from the read model now, so a stronger statement is available
 * and this file makes it — not "we do not project them" but "there is nothing
 * to project".
 *
 * Three layers, because each one fails differently. The type check fails at
 * compile time and catches the field being restored. The key walk fails at run
 * time and catches a value that arrives through an `unknown` cast or a widened
 * adapter. The derived-artifact check catches the case where neither of those
 * fires because the leak went into something computed from the model rather
 * than into the model itself.
 */

/** Names that must never appear as a key anywhere in this read model. */
const PHYSICAL_BINDING_KEYS = ["connectorId", "accessHandle"] as const;

/**
 * A representative approved Card, written out here rather than imported.
 *
 * The shared fixture is edited whenever a test needs another shape, and this
 * file's subject is precisely the shape. A local literal means the assertions
 * below are about the type as declared, not about whatever the fixture happens
 * to hold this week.
 */
const approvedCard: ApprovedCard = {
  cardId: "card_payments",
  versionId: "crv_aaaa",
  meaning: {
    description: "결제 재시도 정책",
    representativeQuestions: ["결제는 몇 번 재시도하나요?"],
    aliases: ["payments"],
    keywords: ["payment", "retry"],
  },
  policy: { sensitive: false, allowedUsage: ["retrieval"] },
  scopes: [
    {
      kind: "managed_document",
      reference: { scopeId: "scope_payments", scopeVersion: "scpv_aaaa" },
      documentIndex: {
        documentIndexId: "didx_payments",
        sourceId: "src_payments",
        documentId: "doc_payments",
        indexVersion: "idxv_aaaa",
      },
      selection: { kind: "document" },
    },
    {
      kind: "sql_source",
      reference: { scopeId: "scope_ledger", scopeVersion: "scpv_aaaa" },
      connector: "postgres.main",
      schema: "public",
      table: "payments",
      columns: ["id", "status"],
    },
    {
      kind: "http_source",
      reference: { scopeId: "scope_status", scopeVersion: "scpv_aaaa" },
      connector: "billing.api",
      method: "GET",
      path: "/payments/{id}",
      operationId: "getPaymentStatus",
      parameters: [{ location: "path", name: "id", required: true }],
    },
  ],
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

describe("approved Card read model physical binding", () => {
  it("declares exactly the four logical index coordinates", () => {
    const documentScope = approvedCard.scopes[0];
    if (documentScope?.kind !== "managed_document") {
      throw new Error("the fixture's first scope must be a managed document");
    }

    // Exhaustive rather than a containment check. `toContain` would pass for a
    // model that gained a fifth coordinate, and the whole claim of this file is
    // about what is absent.
    expect(Object.keys(documentScope.documentIndex).sort()).toEqual([
      "documentId",
      "documentIndexId",
      "indexVersion",
      "sourceId",
    ]);
  });

  it("refuses a physical binding at compile time", () => {
    // The directive sits on the offending property, not on the declaration:
    // an excess property is reported where it is written, so a directive on
    // the `const` line would be unused — a compile error saying the opposite
    // of what this test claims.
    const withConnector: ApprovedDocumentIndexRef = {
      documentIndexId: "didx_payments",
      sourceId: "src_payments",
      documentId: "doc_payments",
      indexVersion: "idxv_aaaa",
      // @ts-expect-error `connectorId` is not part of the approved read model.
      connectorId: "vector.local",
    };
    const withHandle: ApprovedDocumentIndexRef = {
      documentIndexId: "didx_payments",
      sourceId: "src_payments",
      documentId: "doc_payments",
      indexVersion: "idxv_aaaa",
      // @ts-expect-error `accessHandle` is not part of the approved read model.
      accessHandle: "documents/payments/indexes/aaaa",
    };

    // The assertion that matters is the pair of `@ts-expect-error` directives
    // above: restoring either field makes them unused, which is itself a
    // compile error, so this case fails the build rather than the run. The
    // values are read here only so the bindings are not dead code.
    expect(withConnector.documentIndexId).toBe(withHandle.documentIndexId);
  });

  it.each(PHYSICAL_BINDING_KEYS)(
    "carries no %s key anywhere in the model",
    (forbidden) => {
      // Walked rather than checked on `documentIndex` alone. A binding added to
      // a SQL Scope, to the Card root, or to a nested selection would be just as
      // much of a leak and would pass a check that only looked where the field
      // used to live.
      expect([...collectKeys(approvedCard)]).not.toContain(forbidden);
    },
  );

  it.each(PHYSICAL_BINDING_KEYS)(
    "keeps %s out of everything derived from the model",
    (forbidden) => {
      // The two artifacts a Card produces that outlive the request it was built
      // for: the guide a consumer receives, and the text a Card is embedded
      // from. A vector is the worse of the two — it is written to an index and
      // survives every later redaction — which is why the payload is checked as
      // bytes rather than by key.
      const guides = approvedCard.scopes.map((scope) => buildRetrievalGuide(scope, 4));
      const entry = buildCardSelectionEntry(approvedCard);

      expect([...collectKeys(guides)]).not.toContain(forbidden);
      expect(entry.payload).not.toContain(forbidden);
    },
  );
});
