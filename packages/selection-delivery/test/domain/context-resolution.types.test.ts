import { describe, expect, it } from "vitest";

import type {
  ContextResolutionItem,
  ManagedFulfillmentFailure,
  RetrievedDocumentChunk,
  RetrievedDocumentContext,
} from "../../src/domain/context-resolution.js";
import type {
  HttpRetrievalGuide,
  ManagedDocumentGuide,
  SqlRetrievalGuide,
} from "../../src/domain/retrieval-guide.js";
import type { SelectedByList } from "../../src/domain/selection-plan.js";

/**
 * Compile-time tests for the states `ContextResolutionItem` and `SelectedByList` make
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

function selectedBy(): SelectedByList {
  return [{ cardId: "card_refund_policy", versionId: "cardv_refund_policy_v1" }];
}

function documentGuide(): ManagedDocumentGuide {
  return {
    kind: "managed_document",
    scopeRef: { scopeId: "scope_refund_policy_doc", scopeVersion: "scopev_0001" },
    documentIndexId: "docidx_refund_policy",
    sourceId: "src_policy_docs",
    documentId: "doc_refund_policy",
    indexVersion: "idxv_0001",
    selector: { kind: "document" },
    limit: 8,
  };
}

function sqlGuide(): SqlRetrievalGuide {
  return {
    kind: "sql",
    scopeRef: { scopeId: "scope_payments_table", scopeVersion: "scopev_0001" },
    connector: "postgres.main",
    schema: "public",
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
    operationId: "getPayment",
    parameters: [{ location: "path", name: "paymentId", required: true }],
  };
}

function failure(): ManagedFulfillmentFailure {
  return {
    stage: "managed_search",
    code: "index_binding_unavailable",
    retriable: true,
  };
}

function emptyContext(): RetrievedDocumentContext {
  return { contentTrust: "untrusted", chunks: [], omitted: [], truncated: false };
}

function retrievedChunk(): RetrievedDocumentChunk {
  return {
    contextRank: 1,
    chunkId: "chk_0001",
    chunkRevisionId: "chkrev_0001",
    semanticUnitId: "unit_0001",
    documentId: "doc_refund_policy",
    text: "refunds are issued within 5 business days",
    contentDigest: "sha256:aaaa",
  };
}

describe("ManagedDocumentGuide rejects a physical binding at compile time", () => {
  it("refuses a connector id on a guide", () => {
    const guide: ManagedDocumentGuide = {
      ...documentGuide(),
      // @ts-expect-error our own store coordinates are not a citation, and a
      // guide is handed to a consumer whole.
      connectorId: "vector.local",
    };

    expect(guide.kind).toBe("managed_document");
  });

  it("refuses an access handle on a guide", () => {
    const guide: ManagedDocumentGuide = {
      ...documentGuide(),
      // @ts-expect-error see above; the handle is the part a consumer could
      // actually act on, which is exactly why it may not travel.
      accessHandle: "documents/policies/indexes/refund",
    };

    expect(guide.kind).toBe("managed_document");
  });

  it("requires the bound the read was made under", () => {
    // @ts-expect-error `limit` is part of a guide's identity: the same Scope
    // asked for five chunks and for fifty is two different requests.
    const guide: ManagedDocumentGuide = {
      kind: "managed_document",
      scopeRef: { scopeId: "scope_a", scopeVersion: "scopev_0001" },
      documentIndexId: "docidx_a",
      sourceId: "src_a",
      documentId: "doc_a",
      indexVersion: "idxv_0001",
      selector: { kind: "document" },
    };

    expect(guide.kind).toBe("managed_document");
  });
});

describe("SelectedByList refuses an item nobody selected", () => {
  it("refuses an empty list", () => {
    // @ts-expect-error an item exists because a Card selected it, so an empty
    // `selectedBy` is a contradiction rather than a sparse record.
    const cards: SelectedByList = [];

    expect(cards).toEqual([]);
  });
});

describe("ContextResolutionItem rejects impossible combinations at compile time", () => {
  it("refuses a failure on a delegated item", () => {
    const item: ContextResolutionItem = {
      selectedBy: selectedBy(),
      guide: sqlGuide(),
      fulfillment: {
        status: "delegated",
        executor: "consumer",
        // @ts-expect-error we never ran the consumer's source, so we cannot
        // report how it went. `delegated` carries no failure vocabulary.
        failure: failure(),
      },
    };

    expect(item.fulfillment.status).toBe("delegated");
  });

  it("refuses a fulfilled item that carries no retrieved context", () => {
    const item: ContextResolutionItem = {
      selectedBy: selectedBy(),
      guide: documentGuide(),
      // @ts-expect-error `context` is required on `fulfilled`: an item claiming
      // we answered it from our own index has to say what it answered with.
      fulfillment: { status: "fulfilled", executor: "contextctl" },
    };

    expect(item.fulfillment.status).toBe("fulfilled");
  });

  it("refuses a sql guide on a failed item", () => {
    // @ts-expect-error only a managed document can fail here — a SQL source is
    // handed to the consumer, and its outcome is not ours to state. TypeScript
    // reports the mismatch on the declaration rather than on `guide`, so the
    // directive sits here.
    const item: ContextResolutionItem = {
      selectedBy: selectedBy(),
      guide: sqlGuide(),
      fulfillment: {
        status: "failed",
        executor: "contextctl",
        failure: failure(),
      },
    };

    expect(item.fulfillment.status).toBe("failed");
  });

  it("refuses a managed document guide on a delegated item", () => {
    // @ts-expect-error ADR 0002 keeps managed document retrieval in this
    // domain, so a document is never delegated to the consumer.
    const item: ContextResolutionItem = {
      selectedBy: selectedBy(),
      guide: documentGuide(),
      fulfillment: { status: "delegated", executor: "consumer" },
    };

    expect(item.fulfillment.status).toBe("delegated");
  });

  it("refuses a read this process performed being credited to the consumer", () => {
    const item: ContextResolutionItem = {
      selectedBy: selectedBy(),
      guide: documentGuide(),
      // @ts-expect-error `executor` is not a free label. A managed document is
      // read here, so claiming the consumer executed it would tell a caller the
      // text arrived from a source it controls.
      fulfillment: {
        status: "fulfilled",
        executor: "consumer",
        context: emptyContext(),
      },
    };

    expect(item.fulfillment.status).toBe("fulfilled");
  });

  it("refuses a delegated coordinate being credited to this process", () => {
    const item: ContextResolutionItem = {
      selectedBy: selectedBy(),
      guide: httpGuide(),
      // @ts-expect-error ADR 0001: nothing here calls a consumer's endpoint, so
      // `delegated` can only ever name the consumer as its executor.
      fulfillment: {
        status: "delegated",
        executor: "contextctl",
      },
    };

    expect(item.fulfillment.status).toBe("delegated");
  });

  it("refuses a failed item that states no stage", () => {
    const item: ContextResolutionItem = {
      selectedBy: selectedBy(),
      guide: documentGuide(),
      fulfillment: {
        status: "failed",
        executor: "contextctl",
        // @ts-expect-error "the search said no" and "nothing answered" are
        // different facts, and a failure that names neither states nothing.
        failure: { code: "index_binding_unavailable", retriable: true },
      },
    };

    expect(item.fulfillment.status).toBe("failed");
  });

  it("refuses a stage outside the three that exist", () => {
    const item: ContextResolutionItem = {
      selectedBy: selectedBy(),
      guide: documentGuide(),
      fulfillment: {
        status: "failed",
        executor: "contextctl",
        failure: {
          // @ts-expect-error a read fails in the search, at the deadline or in
          // assembly; inventing a fourth stage would invent a pipeline step.
          stage: "selection",
          code: "index_binding_unavailable",
          retriable: true,
        },
      },
    };

    expect(item.fulfillment.status).toBe("failed");
  });

  it("accepts an assembly failure under the one code assembly owns", () => {
    const item: ContextResolutionItem = {
      selectedBy: selectedBy(),
      guide: documentGuide(),
      fulfillment: {
        status: "failed",
        executor: "contextctl",
        failure: {
          stage: "assembly",
          code: "resolution_outcome_invalid",
          retriable: false,
        },
      },
    };

    expect(item.fulfillment.status).toBe("failed");
  });

  it("refuses an assembly failure under an executor's code", () => {
    const item: ContextResolutionItem = {
      selectedBy: selectedBy(),
      guide: documentGuide(),
      fulfillment: {
        status: "failed",
        executor: "contextctl",
        // @ts-expect-error assembly reports one thing — the answer does not
        // hold together — and may not borrow a search's vocabulary to say it.
        failure: {
          stage: "assembly",
          code: "index_binding_unavailable",
          retriable: false,
        },
      },
    };

    expect(item.fulfillment.status).toBe("failed");
  });

  it("refuses a retriable assembly failure", () => {
    const item: ContextResolutionItem = {
      selectedBy: selectedBy(),
      guide: documentGuide(),
      fulfillment: {
        status: "failed",
        executor: "contextctl",
        // @ts-expect-error retrying does not change what was already answered.
        failure: {
          stage: "assembly",
          code: "resolution_outcome_invalid",
          retriable: true,
        },
      },
    };

    expect(item.fulfillment.status).toBe("failed");
  });

  it("refuses a deadline under any code but deadline_exceeded", () => {
    const item: ContextResolutionItem = {
      selectedBy: selectedBy(),
      guide: documentGuide(),
      fulfillment: {
        status: "failed",
        executor: "contextctl",
        // @ts-expect-error a deadline is one fact with one name; a search code
        // on it would claim the search answered when it never did.
        failure: { stage: "deadline", code: "cancelled", retriable: true },
      },
    };

    expect(item.fulfillment.status).toBe("failed");
  });

  it("refuses a deadline that is not retriable", () => {
    const item: ContextResolutionItem = {
      selectedBy: selectedBy(),
      guide: documentGuide(),
      fulfillment: {
        status: "failed",
        executor: "contextctl",
        // @ts-expect-error a target that merely ran out of time is always
        // worth asking again.
        failure: {
          stage: "deadline",
          code: "deadline_exceeded",
          retriable: false,
        },
      },
    };

    expect(item.fulfillment.status).toBe("failed");
  });

  it("refuses the plan's own item key travelling to a consumer", () => {
    const item: ContextResolutionItem = {
      selectedBy: selectedBy(),
      guide: documentGuide(),
      fulfillment: { status: "delegated", executor: "consumer" },
      // @ts-expect-error `itemKey` is the digest that merges two Cards onto one
      // read — our bookkeeping. A consumer correlates on `guide.scopeRef`.
      itemKey: "sha256:0000",
    };

    expect(item.fulfillment.status).toBe("delegated");
  });
});

describe("RetrievedDocumentChunk refuses the internal ordering signals", () => {
  it("refuses a per-target rank", () => {
    const chunk: RetrievedDocumentChunk = {
      ...retrievedChunk(),
      // @ts-expect-error a position inside one target's answer means nothing
      // once several targets have been fused; `contextRank` replaced it.
      rank: 1,
    };

    expect(chunk.contextRank).toBe(1);
  });

  it("refuses a fused score", () => {
    const chunk: RetrievedDocumentChunk = {
      ...retrievedChunk(),
      // @ts-expect-error the RRF sum is on a scale nobody outside this package
      // can interpret, and publishing it invites a consumer to re-sort.
      score: 0.032,
    };

    expect(chunk.contextRank).toBe(1);
  });

  it("requires a rank on every chunk a consumer receives", () => {
    // @ts-expect-error an unranked chunk cannot be ordered against a chunk in
    // another item, which is the whole reason the field exists.
    const chunk: RetrievedDocumentChunk = {
      chunkId: "chk_0001",
      chunkRevisionId: "chkrev_0001",
      semanticUnitId: "unit_0001",
      documentId: "doc_refund_policy",
      text: "refunds are issued within 5 business days",
      contentDigest: "sha256:aaaa",
    };

    expect(chunk.chunkId).toBe("chk_0001");
  });
});

describe("RetrievedDocumentContext pins the trust label", () => {
  it("refuses any other trust level", () => {
    const context: RetrievedDocumentContext = {
      ...emptyContext(),
      // @ts-expect-error retrieved document text is data a document happened to
      // contain, never instruction. There is no second value.
      contentTrust: "trusted",
    };

    expect(context.chunks).toEqual([]);
  });

  it("requires the label to be stated rather than implied", () => {
    // @ts-expect-error a model reading the payload has to be told in the
    // payload; an absent field would leave that to whoever wrote the client.
    const context: RetrievedDocumentContext = {
      chunks: [],
      omitted: [],
      truncated: false,
    };

    expect(context.truncated).toBe(false);
  });
});

describe("ContextResolutionItem accepts every legitimate combination", () => {
  it("accepts a fulfilled document with context", () => {
    const item: ContextResolutionItem = {
      selectedBy: selectedBy(),
      guide: documentGuide(),
      fulfillment: {
        status: "fulfilled",
        executor: "contextctl",
        context: emptyContext(),
      },
    };

    expect(item.fulfillment.status).toBe("fulfilled");
  });

  it("accepts a delegated sql source and a delegated http source", () => {
    const items: readonly ContextResolutionItem[] = [
      {
        selectedBy: selectedBy(),
        guide: sqlGuide(),
        fulfillment: { status: "delegated", executor: "consumer" },
      },
      {
        selectedBy: selectedBy(),
        guide: httpGuide(),
        fulfillment: { status: "delegated", executor: "consumer" },
      },
    ];

    expect(items.map((item) => item.guide.kind)).toEqual(["sql", "http"]);
  });

  it("accepts a failed document carrying any opaque code, checked at runtime", () => {
    const item: ContextResolutionItem = {
      selectedBy: selectedBy(),
      guide: documentGuide(),
      fulfillment: {
        status: "failed",
        executor: "contextctl",
        // A `string`, not a union: the executor's vocabulary is the executor's
        // to version, and a union here would be a copy that goes stale. The
        // grammar is enforced by `assertOpaqueFailure` instead.
        failure: {
          stage: "managed_search",
          code: "a_brand_new_code",
          retriable: false,
        },
      },
    };

    expect(item.fulfillment.status).toBe("failed");
  });

  it("accepts an item several Cards selected", () => {
    const item: ContextResolutionItem = {
      selectedBy: [
        { cardId: "card_one", versionId: "cardv_one" },
        { cardId: "card_two", versionId: "cardv_two" },
      ],
      guide: documentGuide(),
      fulfillment: {
        status: "fulfilled",
        executor: "contextctl",
        context: emptyContext(),
      },
    };

    expect(item.selectedBy).toHaveLength(2);
  });
});
