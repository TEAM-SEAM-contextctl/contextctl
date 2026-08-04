import { describe, expect, it } from "vitest";

import {
  createHttpQueryHandler,
  createMcpQueryServer,
  FixtureDocumentRetriever,
  InMemoryCardCatalog,
  MCP_PROTOCOL_VERSION,
  SELECTION_MCP_TOOL_NAMES,
  selectContext,
  type DeliveryHttpHandler,
  type DeliveryResult,
  type McpQueryServer,
  type SelectContextPorts,
  type SelectionVerdict,
} from "../src/index.js";
import { createDemoCardSet } from "./fixtures/approved-card.fixture.js";
import { createRefundPolicyChunkMap } from "./fixtures/document-chunk.fixture.js";

/**
 * The demo path, driven only through what `src/index.ts` publishes.
 *
 * Every import above comes from the package entry point on purpose: the other
 * suites reach into `src/` directly and would still pass if a symbol never made
 * it onto the public surface. This one fails in that case, which is what makes
 * it the check that the demo is runnable by a consumer rather than only by us.
 */

/** The demo question: it names refund wording and stock wording at once. */
const DEMO_QUERY = "환불할 수 없는 상품과 현재 재고를 알려줘";

interface JsonRpcEnvelope {
  readonly jsonrpc: string;
  readonly id: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

interface ToolCallResult {
  readonly content: readonly { readonly type: string; readonly text: string }[];
  readonly isError?: boolean;
}

function createDemoPorts(): SelectContextPorts {
  return {
    catalog: new InMemoryCardCatalog(createDemoCardSet()),
    retriever: new FixtureDocumentRetriever(createRefundPolicyChunkMap()),
  };
}

function verdictOf(delivery: DeliveryResult, cardId: string): SelectionVerdict {
  const outcome = delivery.selection.outcomes.find(
    (candidate) => candidate.cardId === cardId,
  );

  expect(outcome, `no outcome for ${cardId}`).toBeDefined();
  return (outcome as { readonly verdict: SelectionVerdict }).verdict;
}

/**
 * The three facts every surface has to reproduce for the demo query: the same
 * two Cards admitted, evidence assembled from the document index, and the SQL
 * Card answered with a coordinate rather than with rows.
 */
function expectDemoDelivery(delivery: DeliveryResult): void {
  expect(verdictOf(delivery, "card_refund_policy")).toBe("admit");
  expect(verdictOf(delivery, "card_inventory")).toBe("admit");
  expect(delivery.evidence.chunks.length).toBeGreaterThan(0);
  expect(delivery.contracts).toHaveLength(1);
  expect(delivery.contracts[0]?.kind).toBe("sql");
}

async function send(
  server: McpQueryServer,
  message: unknown,
): Promise<JsonRpcEnvelope> {
  const raw = await server.handleMessage(JSON.stringify(message));

  expect(raw).toBeTypeOf("string");
  return JSON.parse(raw as string) as JsonRpcEnvelope;
}

async function post(
  handler: DeliveryHttpHandler,
  path: string,
  payload: unknown,
): Promise<{ status: number; body: unknown }> {
  const response = await handler({
    method: "POST",
    path,
    body: JSON.stringify(payload),
  });

  return { status: response.status, body: JSON.parse(response.body) };
}

describe("select context end to end", () => {
  it("selects, assembles evidence, and returns contracts for the demo query", async () => {
    const delivery = await selectContext(createDemoPorts(), DEMO_QUERY);

    expect(verdictOf(delivery, "card_refund_policy")).toBe("admit");
    expect(verdictOf(delivery, "card_inventory")).toBe("admit");
    expect(verdictOf(delivery, "card_payment_api")).toBe("reject");

    expect(delivery.evidence.chunks.length).toBeGreaterThan(0);
    // Every chunk is cited back to the one Scope that authorised it: evidence
    // that cannot name an approved source is worse than no evidence.
    for (const chunk of delivery.evidence.chunks) {
      expect(chunk.scopeRef.scopeId).toBe("scope_refund_policy_doc");
      expect(chunk.cardId).toBe("card_refund_policy");
    }

    expect(delivery.contracts).toHaveLength(1);
    const contract = delivery.contracts[0];
    expect(contract?.kind).toBe("sql");
    // Narrowed rather than cast, so the fields below are read off the union
    // member the assertion above already established.
    if (contract?.kind !== "sql") {
      throw new Error("expected a sql retrieval contract");
    }
    expect(contract.table).toBe("inventory");
    expect(contract.columns).toHaveLength(4);
    expect(contract.allowedOperations).toEqual(["select"]);

    expect(delivery.retrievalFailures).toEqual([]);
    expect(delivery.selection.provenance.policyVersion).toBe(
      "selection-ranking-v1",
    );
  });

  it("ranks the refund exclusion chunk first", async () => {
    const delivery = await selectContext(createDemoPorts(), DEMO_QUERY);

    expect(delivery.evidence.chunks[0]?.chunkId).toBe("chunk_refund_excluded");
  });

  it("delivers the same result over an MCP round trip", async () => {
    const server = createMcpQueryServer(createDemoPorts());

    const initialized = await send(server, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: MCP_PROTOCOL_VERSION },
    });
    expect(
      (initialized.result as { readonly protocolVersion: string }).protocolVersion,
    ).toBe(MCP_PROTOCOL_VERSION);

    const listed = await send(server, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const { tools } = listed.result as {
      readonly tools: readonly { readonly name: string }[];
    };
    expect(tools.map((tool) => tool.name)).toEqual([...SELECTION_MCP_TOOL_NAMES]);

    const called = await send(server, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "select_context", arguments: { query: DEMO_QUERY } },
    });
    const result = called.result as ToolCallResult;

    expect(called.error).toBeUndefined();
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.type).toBe("text");

    const delivery = JSON.parse(result.content[0]?.text ?? "null") as DeliveryResult;

    expect(delivery.query).toBe(DEMO_QUERY);
    expectDemoDelivery(delivery);
  });

  it("delivers the same result over an HTTP round trip", async () => {
    const handler = createHttpQueryHandler(createDemoPorts());

    const selection = await post(handler, "/v1/context/selection", {
      query: DEMO_QUERY,
    });

    expect(selection.status).toBe(200);
    const delivery = selection.body as DeliveryResult;
    expect(delivery.query).toBe(DEMO_QUERY);
    expectDemoDelivery(delivery);

    const listed = await handler({
      method: "GET",
      path: "/v1/context/cards",
      body: "",
    });

    expect(listed.status).toBe(200);
    const { cards } = JSON.parse(listed.body) as {
      readonly cards: readonly { readonly cardId: string }[];
    };
    expect(cards).toHaveLength(3);
  });
});
