import { describe, expect, it } from "vitest";

import type {
  ApprovedCard,
  ApprovedDocumentIndexRef,
} from "../../src/domain/card-catalog.js";
import { buildCardSelectionEntry } from "../../src/domain/card-selection-text.js";
import { buildRetrievalGuide } from "../../src/domain/retrieval-guide.js";
import {
  collectKeys,
  unexpectedResponseKeys,
} from "../fixtures/response-keys.fixture.js";

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
 * Every key the approved Card read model declares, at any depth.
 *
 * The read model is Registry's projection of an approved Card as Selection
 * reads it; it is not itself public, but everything a consumer receives is
 * derived from it, so a physical coordinate that got in here would have to be
 * kept out again by every projection downstream. Holding the model to a
 * whitelist means there is nothing to keep out: a key is either declared here,
 * with the type, or it fails at the first read.
 */
const APPROVED_CARD_READ_MODEL_KEYS: ReadonlySet<string> = new Set([
  // Card identity and meaning
  "cardId",
  "versionId",
  "meaning",
  "description",
  "representativeQuestions",
  "aliases",
  "keywords",
  // Access policy, applied before any Card is scored
  "policy",
  "sensitive",
  "allowedUsage",
  // Scopes, every kind
  "scopes",
  "kind",
  "reference",
  "scopeId",
  "scopeVersion",
  // Managed document: the four logical index coordinates, and the selection
  "documentIndex",
  "documentIndexId",
  "sourceId",
  "documentId",
  "indexVersion",
  "selection",
  "semanticUnitIds",
  // SQL: the consumer's own datasource
  "connector",
  "schema",
  "table",
  "columns",
  // HTTP: the consumer's own endpoint
  "method",
  "path",
  "operationId",
  "parameters",
  "location",
  "name",
  "required",
]);

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

  it("carries exactly the keys the read model declares, at every depth", () => {
    // Walked rather than checked on `documentIndex` alone, and against a
    // whitelist rather than the two names that used to live there. A binding
    // added to a SQL Scope, to the Card root, or to a nested selection — under
    // `connectorId`, `accessHandle` or any name this file never heard of — is
    // just as much of a leak, and a field reaches the read model only by being
    // added here with the rest.
    const unexpected = [...collectKeys(approvedCard)]
      .filter((key) => !APPROVED_CARD_READ_MODEL_KEYS.has(key))
      .sort();

    expect(unexpected).toEqual([]);
    for (const forbidden of PHYSICAL_BINDING_KEYS) {
      expect(APPROVED_CARD_READ_MODEL_KEYS.has(forbidden)).toBe(false);
    }
  });

  it("derives guides that carry only keys a consumer may receive", () => {
    // The guide is the one artifact of the read model that is handed to a
    // consumer verbatim, so its keys are held to the response whitelist
    // directly. A field added to the read model and transcribed by
    // `buildRetrievalGuide` fails here before any surface test sees it.
    const guides = approvedCard.scopes.map((scope) => buildRetrievalGuide(scope, 4));

    expect(unexpectedResponseKeys(guides)).toEqual([]);
  });

  it.each(PHYSICAL_BINDING_KEYS)(
    "keeps %s out of the text a Card is embedded from",
    (forbidden) => {
      // A vector is written to an index and survives every later redaction,
      // which is why the payload is checked as bytes rather than by key: a
      // binding that reached the selection text would be embedded under
      // whatever wording carried it there.
      const entry = buildCardSelectionEntry(approvedCard);

      expect(entry.payload).not.toContain(forbidden);
    },
  );
});
