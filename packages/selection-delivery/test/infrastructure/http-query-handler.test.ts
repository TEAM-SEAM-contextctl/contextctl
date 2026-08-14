import { describe, expect, it } from "vitest";

import type { ResolveContextPorts } from "../../src/application/resolve-context.js";
import type {
  ContextResolution,
  ResolutionItem,
} from "../../src/domain/context-resolution.js";
import {
  DocumentRetrievalFault,
  type DocumentRetrievalFaultCode,
  type ManagedDocumentRetriever,
} from "../../src/ports/managed-document-retriever.js";
import {
  createHttpQueryHandler,
  type DeliveryHttpHandler,
  type DeliveryHttpResponse,
} from "../../src/infrastructure/http/http-query-handler.js";
import { FixtureDocumentRetriever } from "../../src/infrastructure/fixture-document-retriever.js";
import { InMemoryCardCatalog } from "../../src/infrastructure/in-memory-card-catalog.js";
import {
  createDemoCardSet,
  createRefundPolicyCard,
  DEMO_QUERY,
} from "../fixtures/approved-card.fixture.js";
import { createRefundPolicyChunkMap } from "../fixtures/document-chunk.fixture.js";

/**
 * The physical binding the refund policy Card's Scope carries.
 *
 * Named here so the leak tests can assert on the actual values rather than on
 * field names alone: a surface that renamed the field but still shipped the
 * value would pass a name-only check.
 */
const DOCUMENT_CONNECTOR_ID = "vector.local";
const DOCUMENT_ACCESS_HANDLE = "documents/policies/indexes/refund";

function createDemoPorts(): ResolveContextPorts {
  return {
    catalog: new InMemoryCardCatalog(createDemoCardSet()),
    retriever: new FixtureDocumentRetriever(createRefundPolicyChunkMap()),
  };
}

function createDemoHandler(): DeliveryHttpHandler {
  return createHttpQueryHandler(createDemoPorts());
}

/** A retriever that fails every read with one declared port fault. */
function createFaultingHandler(
  code: DocumentRetrievalFaultCode,
): DeliveryHttpHandler {
  const retriever: ManagedDocumentRetriever = {
    searchChunks: () => Promise.reject(new DocumentRetrievalFault(code)),
  };

  return createHttpQueryHandler({
    catalog: new InMemoryCardCatalog(createDemoCardSet()),
    retriever,
  });
}

function post(
  handler: DeliveryHttpHandler,
  body: string,
  path = "/v1/context/selection",
): Promise<DeliveryHttpResponse> {
  return handler({ method: "POST", path, body });
}

function get(
  handler: DeliveryHttpHandler,
  path: string,
): Promise<DeliveryHttpResponse> {
  return handler({ method: "GET", path, body: "" });
}

function errorCodeOf(response: DeliveryHttpResponse): unknown {
  return (JSON.parse(response.body) as { error?: { code?: unknown } }).error
    ?.code;
}

function resolutionOf(response: DeliveryHttpResponse): ContextResolution {
  return JSON.parse(response.body) as ContextResolution;
}

function itemForCard(
  resolution: ContextResolution,
  cardId: string,
): ResolutionItem {
  const item = resolution.items.find((candidate) => candidate.cardId === cardId);
  if (item === undefined) {
    throw new Error(`no resolved item for ${cardId}`);
  }
  return item;
}

describe("createHttpQueryHandler", () => {
  it("resolves the demo query into one item per selected Scope", async () => {
    const response = await post(
      createDemoHandler(),
      JSON.stringify({ query: DEMO_QUERY }),
    );

    expect(response.status).toBe(200);

    const resolution = resolutionOf(response);
    expect(resolution.query).toBe(DEMO_QUERY);
    expect(resolution.policy.payloadSchemaVersion).toBe(2);
    expect(resolution.items.map((item) => item.cardId)).toEqual([
      "card_payment_api",
      "card_payments_table",
      "card_refund_policy",
    ]);

    const document = itemForCard(resolution, "card_refund_policy");
    expect(document.fulfillment).toBe("fulfilled");
    if (document.fulfillment !== "fulfilled") {
      throw new Error("expected the document Scope to be fulfilled");
    }
    expect(document.context.chunks.length).toBeGreaterThan(0);

    const sql = itemForCard(resolution, "card_payments_table");
    expect(sql.guide).toMatchObject({ kind: "sql", table: "payments" });
  });

  it("carries items and policy at the root, and none of the split channels", async () => {
    const response = await post(
      createDemoHandler(),
      JSON.stringify({ query: DEMO_QUERY }),
    );

    const payload = JSON.parse(response.body) as Record<string, unknown>;

    expect(Object.keys(payload).sort()).toEqual([
      "candidates",
      "items",
      "policy",
      "query",
      "selection",
    ]);
    for (const retired of ["evidence", "contracts", "retrievalFailures"]) {
      expect(payload).not.toHaveProperty(retired);
    }
  });

  /**
   * The premise the two leak tests below rest on.
   *
   * Asserted separately and first: if the fixture ever stopped carrying a
   * connector id and an access handle, "the response does not contain them"
   * would still pass while proving nothing at all.
   */
  it("selects over a Card that really carries a physical binding", () => {
    const [scope] = createRefundPolicyCard().scopes;

    expect(scope?.kind).toBe("managed_document");
    if (scope?.kind !== "managed_document") {
      throw new Error("expected the refund policy Scope to be a document");
    }
    expect(scope.documentIndex.connectorId).toBe(DOCUMENT_CONNECTOR_ID);
    expect(scope.documentIndex.accessHandle).toBe(DOCUMENT_ACCESS_HANDLE);
  });

  it("publishes no physical retrieval coordinate on either route", async () => {
    // The handler runs under the thresholds the package ships. This test and
    // the one below used to build a handler with the band forced open, because
    // the old demo query admitted only two Scope kinds and a leak check that
    // never sees an HTTP guide cannot say whether an HTTP guide leaks. The demo
    // Cards now answer the demo query on their own, so the checks run on the
    // path a consumer actually takes rather than on a widened one.
    const handler = createDemoHandler();

    const bodies = [
      (await post(handler, JSON.stringify({ query: DEMO_QUERY }))).body,
      (await get(handler, "/v1/context/cards")).body,
    ];

    for (const body of bodies) {
      for (const field of [
        "connectorId",
        "accessHandle",
        "collection",
        "credential",
      ]) {
        expect(body).not.toContain(field);
      }
      // The values too, so a rename cannot smuggle the same binding out under
      // a field name this test does not know about.
      expect(body).not.toContain(DOCUMENT_CONNECTOR_ID);
      expect(body).not.toContain(DOCUMENT_ACCESS_HANDLE);
    }
  });

  it("keeps the consumer's own SQL and HTTP coordinates", async () => {
    const response = await post(
      createDemoHandler(),
      JSON.stringify({ query: DEMO_QUERY }),
    );

    // `connector` is the consumer's datasource name and has to survive, while
    // the document index's `connectorId` above is ours and must not. The two
    // read alike and are opposite obligations, so both are asserted on one body.
    for (const coordinate of [
      "table",
      "columns",
      "allowedOperations",
      "method",
      "path",
      "connector",
      "postgres.main",
      "payments.api",
    ]) {
      expect(response.body).toContain(coordinate);
    }

    const resolution = resolutionOf(response);
    expect(itemForCard(resolution, "card_payment_api").guide).toMatchObject({
      kind: "http",
      connector: "payments.api",
      method: "GET",
      path: "/payments/{paymentId}",
    });
    expect(itemForCard(resolution, "card_payments_table").guide).toMatchObject({
      kind: "sql",
      connector: "postgres.main",
      table: "payments",
      columns: ["created_at", "failed_reason", "payment_id", "status"],
      allowedOperations: ["select"],
    });
  });

  it("marks a delegated Scope as delegated and attaches no failure to it", async () => {
    const resolution = resolutionOf(
      await post(createDemoHandler(), JSON.stringify({ query: DEMO_QUERY })),
    );

    for (const cardId of ["card_payments_table", "card_payment_api"]) {
      const item = itemForCard(resolution, cardId);

      expect(item.fulfillment).toBe("delegated");
      // We never ran the consumer's database or endpoint, so we are in no
      // position to report how it went.
      expect(item).not.toHaveProperty("code");
      expect(item).not.toHaveProperty("context");
    }
  });

  it("reports each retrieval fault as a failed item carrying its code", async () => {
    const codes: readonly DocumentRetrievalFaultCode[] = [
      "index_unavailable",
      "index_version_mismatch",
      "access_denied",
    ];

    for (const code of codes) {
      const response = await post(
        createFaultingHandler(code),
        JSON.stringify({ query: DEMO_QUERY }),
      );

      expect(response.status).toBe(200);

      const item = itemForCard(resolutionOf(response), "card_refund_policy");
      expect(item.fulfillment).toBe("failed");
      if (item.fulfillment !== "failed") {
        throw new Error(`expected ${code} to fail the document Scope`);
      }
      expect(item.code).toBe(code);
      expect(item.guide.kind).toBe("managed_document");
    }
  });

  it("answers empty_query for a query that selects nothing", async () => {
    const response = await post(
      createDemoHandler(),
      JSON.stringify({ query: "" }),
    );

    expect(response.status).toBe(400);
    expect(errorCodeOf(response)).toBe("empty_query");
  });

  it("answers invalid_query for a missing or non-string query", async () => {
    const handler = createDemoHandler();

    for (const body of ["{}", JSON.stringify({ query: 42 })]) {
      const response = await post(handler, body);

      expect(response.status).toBe(400);
      expect(errorCodeOf(response)).toBe("invalid_query");
    }
  });

  it("answers invalid_json for a body that does not parse", async () => {
    const response = await post(createDemoHandler(), '{"query": ');

    expect(response.status).toBe(400);
    expect(errorCodeOf(response)).toBe("invalid_json");
  });

  it("narrows the evidence budget on request and refuses an impossible one", async () => {
    const handler = createDemoHandler();

    const narrowed = await post(
      handler,
      JSON.stringify({ query: DEMO_QUERY, maxEvidenceCharacters: 1 }),
    );
    expect(narrowed.status).toBe(200);

    const resolution = resolutionOf(narrowed);
    // The ceiling is a property of the response as a whole, so it is reported
    // once on `policy` rather than repeated on every item.
    expect(resolution.policy.budget.maxTotalCharacters).toBe(1);

    const document = itemForCard(resolution, "card_refund_policy");
    if (document.fulfillment !== "fulfilled") {
      throw new Error("expected the document Scope to be fulfilled");
    }
    expect(document.context.truncated).toBe(true);

    const impossible = await post(
      handler,
      JSON.stringify({ query: DEMO_QUERY, maxEvidenceCharacters: 0 }),
    );
    expect(impossible.status).toBe(400);
    expect(errorCodeOf(impossible)).toBe("invalid_budget");
  });

  it("lists every approved Card with its distinct Scope kinds", async () => {
    const response = await get(createDemoHandler(), "/v1/context/cards");

    expect(response.status).toBe(200);

    const { cards } = JSON.parse(response.body) as {
      readonly cards: readonly {
        readonly cardId: string;
        readonly description: string;
        readonly keywords: readonly string[];
        readonly scopeKinds: readonly string[];
      }[];
    };

    expect(cards).toHaveLength(3);
    expect(cards.map((card) => card.cardId)).toEqual([
      "card_refund_policy",
      "card_payments_table",
      "card_payment_api",
    ]);
    expect(cards.map((card) => card.scopeKinds)).toEqual([
      ["managed_document"],
      ["sql_source"],
      ["http_source"],
    ]);
    expect(cards[1]?.keywords).toEqual(["결제 실패", "실패 내역"]);
    expect(cards[0]?.description.length).toBeGreaterThan(0);
  });

  it("answers method_not_allowed when a known route is reached with the wrong method", async () => {
    const handler = createDemoHandler();

    const readSelection = await get(handler, "/v1/context/selection");
    expect(readSelection.status).toBe(405);
    expect(errorCodeOf(readSelection)).toBe("method_not_allowed");

    const writeCards = await post(handler, "{}", "/v1/context/cards");
    expect(writeCards.status).toBe(405);
    expect(errorCodeOf(writeCards)).toBe("method_not_allowed");
  });

  it("answers not_found for an unknown path", async () => {
    const response = await get(createDemoHandler(), "/v1/unknown");

    expect(response.status).toBe(404);
    expect(errorCodeOf(response)).toBe("not_found");
  });

  it("routes on the path alone and ignores a query string", async () => {
    const response = await get(createDemoHandler(), "/v1/context/cards?x=1");

    expect(response.status).toBe(200);
    expect(
      (JSON.parse(response.body) as { readonly cards: readonly unknown[] })
        .cards,
    ).toHaveLength(3);
  });

  it("reduces an unexpected port failure to internal_error without its detail", async () => {
    const handler = createHttpQueryHandler({
      catalog: {
        listApprovedCards: () => {
          throw new Error("secret-host details");
        },
      },
      retriever: new FixtureDocumentRetriever({}),
    });

    const response = await post(handler, JSON.stringify({ query: DEMO_QUERY }));

    expect(response.status).toBe(500);
    expect(errorCodeOf(response)).toBe("internal_error");
    expect(response.body).not.toContain("secret-host");
  });
});
