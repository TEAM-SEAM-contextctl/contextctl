import { describe, expect, it } from "vitest";

import type {
  HttpRetrievalGuide,
  ManagedDocumentGuide,
  ResolutionItem,
  RetrievedDocumentContext,
  SqlRetrievalGuide,
} from "../../src/domain/context-resolution.js";

/**
 * Compile-time tests for the four states `ResolutionItem` makes
 * unrepresentable.
 *
 * `@ts-expect-error` is the assertion here, and it carries its own safety net:
 * if one of these combinations ever stops being an error, `tsc` fails with
 * "Unused '@ts-expect-error' directive" rather than passing quietly. The root
 * `tsconfig.check.json` includes every package's test tree, so `npm run
 * typecheck` really does check this file. Vitest transpiles without type
 * checking and would report all of it green.
 *
 * The runtime assertions exist only so `noUnusedLocals` stays satisfied and so
 * vitest reports the file; the compiler is what is under test.
 */

function documentGuide(): ManagedDocumentGuide {
  return {
    kind: "managed_document",
    scopeRef: { scopeId: "scope_refund_policy_doc", scopeVersion: "scopev_0001" },
    sourceId: "src_policy_docs",
    documentId: "doc_refund_policy",
    documentIndexId: "docidx_refund_policy",
    indexVersion: "idxv_0001",
    selection: { kind: "document" },
  };
}

function sqlGuide(): SqlRetrievalGuide {
  return {
    kind: "sql",
    scopeRef: { scopeId: "scope_payments_table", scopeVersion: "scopev_0001" },
    connector: "postgres.main",
    table: "payments",
    columns: ["payment_id"],
    allowedOperations: ["select"],
  };
}

function httpGuide(): HttpRetrievalGuide {
  return {
    kind: "http",
    scopeRef: { scopeId: "scope_payment_get", scopeVersion: "scopev_0001" },
    connector: "payments.api",
    method: "GET",
    path: "/payments/{paymentId}",
  };
}

function emptyContext(): RetrievedDocumentContext {
  return { chunks: [], omitted: [], truncated: false };
}

describe("ResolutionItem rejects impossible combinations at compile time", () => {
  it("refuses a failure code on a delegated item", () => {
    const item: ResolutionItem = {
      fulfillment: "delegated",
      cardId: "card_payments_table",
      versionId: "cardv_payments_table_v1",
      guide: sqlGuide(),
      // @ts-expect-error we never ran the consumer's source, so we cannot
      // report how it went. `delegated` carries no failure vocabulary.
      code: "index_unavailable",
    };

    expect(item.fulfillment).toBe("delegated");
  });

  it("refuses a fulfilled item that carries no retrieved context", () => {
    // @ts-expect-error `context` is required on `fulfilled`: an item claiming
    // we answered it from our own index has to say what it answered with.
    const item: ResolutionItem = {
      fulfillment: "fulfilled",
      cardId: "card_refund_policy",
      versionId: "cardv_refund_policy_v1",
      guide: documentGuide(),
    };

    expect(item.fulfillment).toBe("fulfilled");
  });

  it("refuses a sql guide on a failed item", () => {
    // @ts-expect-error only a managed document can fail here — a SQL source is
    // handed to the consumer, and its outcome is not ours to state. TypeScript
    // reports the mismatch on the declaration rather than on `guide`, so the
    // directive sits here.
    const item: ResolutionItem = {
      fulfillment: "failed",
      cardId: "card_payments_table",
      versionId: "cardv_payments_table_v1",
      guide: sqlGuide(),
      code: "index_unavailable",
    };

    expect(item.fulfillment).toBe("failed");
  });

  it("refuses a managed document guide on a delegated item", () => {
    // @ts-expect-error ADR 0002 keeps managed document retrieval in this
    // domain, so a document is never delegated to the consumer.
    const item: ResolutionItem = {
      fulfillment: "delegated",
      cardId: "card_refund_policy",
      versionId: "cardv_refund_policy_v1",
      guide: documentGuide(),
    };

    expect(item.fulfillment).toBe("delegated");
  });
});

describe("ResolutionItem accepts every legitimate combination", () => {
  it("accepts a fulfilled document with context", () => {
    const item: ResolutionItem = {
      fulfillment: "fulfilled",
      cardId: "card_refund_policy",
      versionId: "cardv_refund_policy_v1",
      guide: documentGuide(),
      context: emptyContext(),
    };

    expect(item.fulfillment).toBe("fulfilled");
  });

  it("accepts a delegated sql source and a delegated http source", () => {
    const items: readonly ResolutionItem[] = [
      {
        fulfillment: "delegated",
        cardId: "card_payments_table",
        versionId: "cardv_payments_table_v1",
        guide: sqlGuide(),
      },
      {
        fulfillment: "delegated",
        cardId: "card_payment_api",
        versionId: "cardv_payment_api_v1",
        guide: httpGuide(),
      },
    ];

    expect(items.map((item) => item.guide.kind)).toEqual(["sql", "http"]);
  });

  it("accepts a failed document carrying the retriever's own fault code", () => {
    const item: ResolutionItem = {
      fulfillment: "failed",
      cardId: "card_refund_policy",
      versionId: "cardv_refund_policy_v1",
      guide: documentGuide(),
      code: "index_version_mismatch",
    };

    expect(item.fulfillment).toBe("failed");
  });

  it("accepts a failed document whose adapter threw outside that vocabulary", () => {
    const item: ResolutionItem = {
      fulfillment: "failed",
      cardId: "card_refund_policy",
      versionId: "cardv_refund_policy_v1",
      guide: documentGuide(),
      code: "retriever_error",
    };

    expect(item.fulfillment).toBe("failed");
  });

  it("refuses a fault code the domain never produces", () => {
    const item: ResolutionItem = {
      fulfillment: "failed",
      cardId: "card_refund_policy",
      versionId: "cardv_refund_policy_v1",
      guide: documentGuide(),
      // @ts-expect-error the four codes are the whole vocabulary: three the
      // retriever port declares, plus the one that says it threw something else.
      code: "timeout",
    };

    expect(item.fulfillment).toBe("failed");
  });
});
