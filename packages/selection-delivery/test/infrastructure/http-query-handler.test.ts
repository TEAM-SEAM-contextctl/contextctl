import { describe, expect, it } from "vitest";

import type { DeliveryResult } from "../../src/application/select-context.js";
import type { SelectContextPorts } from "../../src/application/select-context.js";
import {
  createHttpQueryHandler,
  type DeliveryHttpHandler,
  type DeliveryHttpResponse,
} from "../../src/infrastructure/http/http-query-handler.js";
import { FixtureDocumentRetriever } from "../../src/infrastructure/fixture-document-retriever.js";
import { InMemoryCardCatalog } from "../../src/infrastructure/in-memory-card-catalog.js";
import { createDemoCardSet } from "../fixtures/approved-card.fixture.js";
import { createRefundPolicyChunkMap } from "../fixtures/document-chunk.fixture.js";

/** The demo question: it names refund wording and stock wording at once. */
const DEMO_QUERY = "환불할 수 없는 상품과 현재 재고를 알려줘";

function createDemoPorts(): SelectContextPorts {
  return {
    catalog: new InMemoryCardCatalog(createDemoCardSet()),
    retriever: new FixtureDocumentRetriever(createRefundPolicyChunkMap()),
  };
}

function createDemoHandler(): DeliveryHttpHandler {
  return createHttpQueryHandler(createDemoPorts());
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

describe("createHttpQueryHandler", () => {
  it("delivers evidence and consumer contracts for the demo query", async () => {
    const response = await post(
      createDemoHandler(),
      JSON.stringify({ query: DEMO_QUERY }),
    );

    expect(response.status).toBe(200);

    const result = JSON.parse(response.body) as DeliveryResult;
    expect(result.query).toBe(DEMO_QUERY);
    expect(result.evidence.chunks.length).toBeGreaterThan(0);
    expect(result.contracts).toHaveLength(1);
    expect(result.contracts[0]).toMatchObject({
      kind: "sql",
      table: "inventory",
    });
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

    const result = JSON.parse(narrowed.body) as DeliveryResult;
    expect(result.evidence.budget.maxTotalCharacters).toBe(1);
    expect(result.evidence.truncated).toBe(true);

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
      "card_inventory",
      "card_payment_api",
    ]);
    expect(cards.map((card) => card.scopeKinds)).toEqual([
      ["managed_document"],
      ["sql_source"],
      ["http_source"],
    ]);
    expect(cards[1]?.keywords).toEqual(["재고", "품절", "stock", "수량"]);
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
