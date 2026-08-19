import { describe, expect, it } from "vitest";

import type {
  ContextResolution,
  ContextResolutionItem,
} from "../../src/domain/context-resolution.js";
import {
  createHttpQueryHandler,
  RESOLVE_PATH,
  type DeliveryHttpHandler,
  type DeliveryHttpResponse,
} from "../../src/infrastructure/http/http-query-handler.js";
import {
  createDemoCardSet,
  createRefundPolicyCard,
  DEMO_QUERY,
} from "../fixtures/approved-card.fixture.js";
import { createFixtureContextApplication } from "../fixtures/context-application.fixture.js";
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

function createDemoHandler(): DeliveryHttpHandler {
  return createHttpQueryHandler(
    createFixtureContextApplication({
      cards: createDemoCardSet(),
      chunks: createRefundPolicyChunkMap(),
    }),
  );
}

/** An executor that fails every read with one code and nothing else. */
function createFailingHandler(code: string): DeliveryHttpHandler {
  return createHttpQueryHandler(
    createFixtureContextApplication({
      cards: createDemoCardSet(),
      execute: (_queryText, targets) =>
        targets.map((target) => ({
          targetKey: target.targetKey,
          status: "failed" as const,
          failure: {
            stage: "managed_search" as const,
            code,
            retriable: false,
          },
        })),
    }),
  );
}

function post(
  handler: DeliveryHttpHandler,
  body: string,
  path = RESOLVE_PATH,
): Promise<DeliveryHttpResponse> {
  return handler({ method: "POST", path, body });
}

function get(
  handler: DeliveryHttpHandler,
  path: string,
): Promise<DeliveryHttpResponse> {
  return handler({ method: "GET", path, body: "" });
}

function errorOf(response: DeliveryHttpResponse): unknown {
  return (JSON.parse(response.body) as { error?: unknown }).error;
}

function errorCodeOf(response: DeliveryHttpResponse): unknown {
  return (JSON.parse(response.body) as { error?: { code?: unknown } }).error
    ?.code;
}

function resolutionOf(response: DeliveryHttpResponse): ContextResolution {
  return JSON.parse(response.body) as ContextResolution;
}

/**
 * The item a Card selected, found through `selectedBy`.
 *
 * An item is one Scope under one bound rather than one (Card, Scope) pair, so a
 * Card is one of possibly several that selected it. No two demo Cards share a
 * Scope, so this lookup stays unambiguous.
 */
function itemForCard(
  resolution: ContextResolution,
  cardId: string,
): ContextResolutionItem {
  const item = resolution.items.find((candidate) =>
    candidate.selectedBy.some((reference) => reference.cardId === cardId),
  );
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
    expect(resolution.policy.payloadSchemaVersion).toBe(3);
    // Ordered by Scope identity rather than by rank, so two responses over one
    // catalog list the same Scopes in the same sequence whatever the scores did.
    expect(
      resolution.items.map((item) => item.guide.scopeRef.scopeId),
    ).toEqual([
      "scope_payment_get",
      "scope_payments_table",
      "scope_refund_policy_doc",
    ]);
    expect(
      resolution.items.map((item) => item.selectedBy.map((card) => card.cardId)),
    ).toEqual([
      ["card_payment_api"],
      ["card_payments_table"],
      ["card_refund_policy"],
    ]);

    const document = itemForCard(resolution, "card_refund_policy");
    expect(document.fulfillment.status).toBe("fulfilled");
    if (document.fulfillment.status !== "fulfilled") {
      throw new Error("expected the document Scope to be fulfilled");
    }
    expect(document.fulfillment.context.chunks.length).toBeGreaterThan(0);

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
      "items",
      "policy",
      "query",
      "selection",
    ]);
    // Absence, not `undefined`: a payload that still carried these keys with an
    // undefined value would be a previous contract, and an equality check
    // against `undefined` could not tell the two apart. `candidates` is on the
    // list because v2 published every Card the query was scored against.
    for (const retired of [
      "candidates",
      "evidence",
      "contracts",
      "retrievalFailures",
    ]) {
      expect(Object.hasOwn(payload, retired)).toBe(false);
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

  it("publishes no physical retrieval coordinate on the one route it serves", async () => {
    // The handler runs under the thresholds the package ships. This test and
    // the one below used to build a handler with the band forced open, because
    // the old demo query admitted only two Scope kinds and a leak check that
    // never sees an HTTP guide cannot say whether an HTTP guide leaks. The demo
    // Cards now answer the demo query on their own, so the checks run on the
    // path a consumer actually takes rather than on a widened one.
    const handler = createDemoHandler();

    const { body } = await post(handler, JSON.stringify({ query: DEMO_QUERY }));

    for (const field of [
      "connectorId",
      "accessHandle",
      "collection",
      "credential",
    ]) {
      expect(body).not.toContain(field);
    }
    // The values too, so a rename cannot smuggle the same binding out under a
    // field name this test does not know about.
    expect(body).not.toContain(DOCUMENT_CONNECTOR_ID);
    expect(body).not.toContain(DOCUMENT_ACCESS_HANDLE);
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

      // We never ran the consumer's database or endpoint, so we are in no
      // position to report how it went — and `executor` says whose work it is.
      expect(item.fulfillment).toEqual({
        status: "delegated",
        executor: "consumer",
      });
    }
  });

  it("reports each read failure as a failed item carrying the executor's code", async () => {
    // None of these four is declared anywhere in this package, which is the
    // assertion: the code crosses by name rather than being folded into a
    // vocabulary Delivery invented.
    const codes = [
      "index_binding_unavailable",
      "scope_not_published",
      "vector_search_unavailable",
      "embedding_provider_not_allowed",
    ];

    for (const code of codes) {
      const response = await post(
        createFailingHandler(code),
        JSON.stringify({ query: DEMO_QUERY }),
      );

      expect(response.status).toBe(200);

      const item = itemForCard(resolutionOf(response), "card_refund_policy");
      expect(item.fulfillment.status).toBe("failed");
      if (item.fulfillment.status !== "failed") {
        throw new Error(`expected ${code} to fail the document Scope`);
      }
      expect(item.fulfillment.failure).toEqual({
        stage: "managed_search",
        code,
        retriable: false,
      });
      // An item-level failure never becomes a request-level error: the SQL and
      // HTTP Scopes the same query selected were not affected by a document
      // search that failed, and a 200 is what says so.
      expect(item.fulfillment.executor).toBe("contextctl");
      expect(item.guide.kind).toBe("managed_document");
    }
  });

  it("answers empty_query for a query that selects nothing", async () => {
    const response = await post(
      createDemoHandler(),
      JSON.stringify({ query: "" }),
    );

    expect(response.status).toBe(400);
    // The whole error record, not just the code: `retriable` is what a client
    // branches on, and an empty query never becomes non-empty on a retry.
    expect(errorOf(response)).toEqual({
      code: "empty_query",
      retriable: false,
    });
  });

  it("answers invalid_request for a body that is not a question", async () => {
    const handler = createDemoHandler();

    // A body that does not parse, one that parses to a non-object, and one that
    // parses but carries no string `query` are the same defect from a caller's
    // side: nothing was asked. They used to answer under three different codes.
    for (const body of ['{"query": ', '"just a string"', "[]", "{}", JSON.stringify({ query: 42 })]) {
      const response = await post(handler, body);

      expect(response.status).toBe(400);
      expect(errorOf(response)).toEqual({
        code: "invalid_request",
        retriable: false,
      });
    }
  });

  it("narrows the context budget on request and refuses an impossible one", async () => {
    const handler = createDemoHandler();

    const narrowed = await post(
      handler,
      JSON.stringify({ query: DEMO_QUERY, maxContextCharacters: 1 }),
    );
    expect(narrowed.status).toBe(200);

    const resolution = resolutionOf(narrowed);
    // The ceiling is a property of the response as a whole, so it is reported
    // once on `policy` rather than repeated on every item.
    expect(resolution.policy.budget.maxTotalCharacters).toBe(1);

    const document = itemForCard(resolution, "card_refund_policy");
    if (document.fulfillment.status !== "fulfilled") {
      throw new Error("expected the document Scope to be fulfilled");
    }
    expect(document.fulfillment.context.truncated).toBe(true);
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 12.5],
    ["not finite", Number.POSITIVE_INFINITY],
    ["beyond a safe integer", Number.MAX_SAFE_INTEGER + 2],
    ["above the configured ceiling", 8001],
  ])("refuses a %s ceiling as invalid_context_budget", async (_label, value) => {
    // 8001 is one above `DEFAULT_CONTEXT_BUDGET.maxTotalCharacters`. It is
    // refused rather than clamped: a caller that asked for more and silently
    // received the default has no way to know its request was not honoured.
    const response = await post(
      createDemoHandler(),
      JSON.stringify({ query: DEMO_QUERY, maxContextCharacters: value }),
    );

    expect(response.status).toBe(400);
    expect(errorOf(response)).toEqual({
      code: "invalid_context_budget",
      retriable: false,
    });
  });

  it("refuses a non-numeric ceiling under the same code", async () => {
    const response = await post(
      createDemoHandler(),
      JSON.stringify({ query: DEMO_QUERY, maxContextCharacters: "8000" }),
    );

    expect(response.status).toBe(400);
    expect(errorCodeOf(response)).toBe("invalid_context_budget");
  });

  it("applies the lower of the configured ceiling and the requested one", async () => {
    const response = await post(
      createDemoHandler(),
      JSON.stringify({ query: DEMO_QUERY, maxContextCharacters: 8000 }),
    );

    // Equal to the configured ceiling, so `min` picks either and the response
    // has to state the same number rather than a widened one.
    expect(resolutionOf(response).policy.budget.maxTotalCharacters).toBe(8000);
  });

  it("serves exactly one route", async () => {
    const handler = createDemoHandler();

    // The catalog listing is gone: an agent that can enumerate every approved
    // Card can map the catalog without asking a question. `not_found`, not
    // `method_not_allowed` — the route does not exist at all.
    for (const retired of ["/v1/context/cards", "/v1/context/selection"]) {
      expect((await get(handler, retired)).status).toBe(404);
      expect((await post(handler, "{}", retired)).status).toBe(404);
    }
  });

  it("answers method_not_allowed when the route is reached with the wrong method", async () => {
    const response = await get(createDemoHandler(), RESOLVE_PATH);

    expect(response.status).toBe(405);
    expect(errorOf(response)).toEqual({
      code: "method_not_allowed",
      retriable: false,
    });
  });

  it("answers not_found for an unknown path", async () => {
    const response = await get(createDemoHandler(), "/v1/unknown");

    expect(response.status).toBe(404);
    expect(errorOf(response)).toEqual({
      code: "not_found",
      retriable: false,
    });
  });

  it("routes on the path alone and ignores a query string", async () => {
    const response = await post(
      createDemoHandler(),
      JSON.stringify({ query: DEMO_QUERY }),
      `${RESOLVE_PATH}?x=1`,
    );

    expect(response.status).toBe(200);
    expect(resolutionOf(response).query).toBe(DEMO_QUERY);
  });

  it("reduces an unexpected port failure to unexpected_failure without its detail", async () => {
    const handler = createHttpQueryHandler(
      createFixtureContextApplication({
        catalog: {
          listApprovedCards: () => {
            throw new Error("secret-host details");
          },
        },
      }),
    );

    const response = await post(handler, JSON.stringify({ query: DEMO_QUERY }));

    expect(response.status).toBe(500);
    expect(errorOf(response)).toEqual({
      code: "unexpected_failure",
      retriable: false,
    });
    expect(response.body).not.toContain("secret-host");
  });
});
