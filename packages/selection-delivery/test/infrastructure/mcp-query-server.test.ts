import { describe, expect, it } from "vitest";

import type { DeliveryResult, SelectContextPorts } from "../../src/application/select-context.js";
import { FixtureDocumentRetriever } from "../../src/infrastructure/fixture-document-retriever.js";
import { InMemoryCardCatalog } from "../../src/infrastructure/in-memory-card-catalog.js";
import {
  createMcpQueryServer,
  SELECTION_MCP_TOOL_NAMES,
  type McpQueryServer,
} from "../../src/infrastructure/mcp/mcp-query-server.js";
import { createDemoCardSet } from "../fixtures/approved-card.fixture.js";
import { createRefundPolicyChunkMap } from "../fixtures/document-chunk.fixture.js";

/** The demo question: it names refund wording and stock wording at once. */
const DEMO_QUERY = "환불할 수 없는 상품과 현재 재고를 알려줘";

/** The tool name prefixes ADR 0003 forbids from ever reaching `tools/list`. */
const CONTROL_PLANE_WORDS = ["approve", "reject", "rollback", "sync", "edit"];

interface JsonRpcErrorBody {
  readonly code: number;
  readonly message: string;
}

interface JsonRpcEnvelope {
  readonly jsonrpc: string;
  readonly id: unknown;
  readonly result?: unknown;
  readonly error?: JsonRpcErrorBody;
}

interface ToolContentBlock {
  readonly type: string;
  readonly text: string;
}

interface ToolCallResult {
  readonly content: readonly ToolContentBlock[];
  readonly isError?: boolean;
}

interface McpToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

function createDemoServer(): McpQueryServer {
  const ports: SelectContextPorts = {
    catalog: new InMemoryCardCatalog(createDemoCardSet()),
    retriever: new FixtureDocumentRetriever(createRefundPolicyChunkMap()),
  };

  return createMcpQueryServer(ports);
}

/** Sends one message and asserts a response came back, returning it parsed. */
async function send(
  server: McpQueryServer,
  message: unknown,
): Promise<JsonRpcEnvelope> {
  const raw = await server.handleMessage(JSON.stringify(message));

  expect(raw).toBeTypeOf("string");
  return JSON.parse(raw as string) as JsonRpcEnvelope;
}

function readToolResult(envelope: JsonRpcEnvelope): ToolCallResult {
  expect(envelope.error).toBeUndefined();
  return envelope.result as ToolCallResult;
}

/** The text payload of a successful tool call, parsed back from JSON. */
function readToolPayload(envelope: JsonRpcEnvelope): unknown {
  const result = readToolResult(envelope);

  expect(result.isError).toBeUndefined();
  expect(result.content[0]?.type).toBe("text");
  return JSON.parse(result.content[0]?.text ?? "null");
}

function callTool(
  server: McpQueryServer,
  id: number,
  name: string,
  toolArguments: Readonly<Record<string, unknown>> = {},
): Promise<JsonRpcEnvelope> {
  return send(server, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: toolArguments },
  });
}

describe("createMcpQueryServer", () => {
  it("exposes exactly the two query tools and no control plane tool", async () => {
    const envelope = await send(createDemoServer(), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });

    const { tools } = envelope.result as { tools: readonly McpToolDescriptor[] };
    const names = tools.map((tool) => tool.name);

    expect(names).toEqual(["list_context_cards", "select_context"]);
    expect(names).toEqual([...SELECTION_MCP_TOOL_NAMES]);
    expect(tools).toHaveLength(2);

    // ADR 0003: the absence is the decision, so it is asserted rather than
    // trusted to review — a control plane tool added later has to delete this.
    for (const name of names) {
      for (const word of CONTROL_PLANE_WORDS) {
        expect(name).not.toContain(word);
      }
    }
  });

  it("answers initialize with a protocol version, capabilities, and server info", async () => {
    const envelope = await send(createDemoServer(), {
      jsonrpc: "2.0",
      id: "init-1",
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });

    expect(envelope.id).toBe("init-1");

    const result = envelope.result as {
      protocolVersion: string;
      capabilities: { tools?: unknown };
      serverInfo: { name: string; version: string };
    };

    expect(result.protocolVersion).toBe("2025-06-18");
    expect(result.capabilities.tools).toBeDefined();
    expect(result.serverInfo.name).toBe("contextctl-selection");
    expect(result.serverInfo.version).toBe("0.0.0");
  });

  it("lists the approved Cards with their Scope kinds", async () => {
    const envelope = await callTool(createDemoServer(), 2, "list_context_cards");

    const payload = readToolPayload(envelope) as {
      cards: readonly {
        cardId: string;
        description: string;
        keywords: readonly string[];
        scopeKinds: readonly string[];
      }[];
    };

    expect(payload.cards.map((card) => card.cardId)).toEqual([
      "card_refund_policy",
      "card_inventory",
      "card_payment_api",
    ]);
    expect(payload.cards[0]?.scopeKinds).toEqual(["managed_document"]);
    expect(payload.cards[1]?.scopeKinds).toEqual(["sql_source"]);
    expect(payload.cards[2]?.scopeKinds).toEqual(["http_source"]);
    expect(payload.cards[0]?.keywords).toContain("환불");
  });

  it("delivers evidence and contracts for the demo query", async () => {
    const envelope = await callTool(createDemoServer(), 3, "select_context", {
      query: DEMO_QUERY,
    });

    const delivery = readToolPayload(envelope) as DeliveryResult;

    expect(delivery.query).toBe(DEMO_QUERY);
    expect(delivery.evidence.chunks.length).toBeGreaterThan(0);
    expect(delivery.evidence.chunks[0]?.cardId).toBe("card_refund_policy");
    expect(delivery.contracts).toHaveLength(1);
    expect(delivery.contracts[0]).toMatchObject({
      kind: "sql",
      cardId: "card_inventory",
    });
  });

  it("rejects a select_context call that carries no query", async () => {
    const envelope = await callTool(createDemoServer(), 4, "select_context", {});

    expect(envelope.result).toBeUndefined();
    expect(envelope.error?.code).toBe(-32602);
  });

  it("reports an empty query as a tool error rather than a protocol error", async () => {
    const envelope = await callTool(createDemoServer(), 5, "select_context", {
      query: "",
    });

    const result = readToolResult(envelope);

    expect(envelope.error).toBeUndefined();
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("EmptyQueryError");
  });

  it("applies a caller's evidence character ceiling", async () => {
    const envelope = await callTool(createDemoServer(), 6, "select_context", {
      query: DEMO_QUERY,
      maxEvidenceCharacters: 1,
    });

    const delivery = readToolPayload(envelope) as DeliveryResult;

    expect(delivery.evidence.budget.maxTotalCharacters).toBe(1);
    expect(delivery.evidence.chunks).toEqual([]);
    expect(delivery.evidence.truncated).toBe(true);
  });

  it("rejects an unknown tool name", async () => {
    const envelope = await callTool(createDemoServer(), 7, "approve_card", {});

    expect(envelope.result).toBeUndefined();
    expect(envelope.error?.code).toBe(-32602);
  });

  it("answers unparsable JSON with a parse error on a null id", async () => {
    const raw = await createDemoServer().handleMessage('{"jsonrpc": "2.0"');

    expect(raw).toBeTypeOf("string");
    const envelope = JSON.parse(raw as string) as JsonRpcEnvelope;

    expect(envelope.id).toBeNull();
    expect(envelope.error?.code).toBe(-32700);
  });

  it("rejects a message that omits the jsonrpc field", async () => {
    const envelope = await send(createDemoServer(), {
      id: 8,
      method: "tools/list",
    });

    expect(envelope.id).toBe(8);
    expect(envelope.error?.code).toBe(-32600);
  });

  it("rejects an unknown method", async () => {
    const envelope = await send(createDemoServer(), {
      jsonrpc: "2.0",
      id: 9,
      method: "cards/approve",
    });

    expect(envelope.error?.code).toBe(-32601);
  });

  it("stays silent on notifications", async () => {
    const server = createDemoServer();

    await expect(
      server.handleMessage(
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      server.handleMessage(
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/unknown" }),
      ),
    ).resolves.toBeUndefined();
  });

  it("reduces an unexpected port failure to internal_error", async () => {
    const server = createMcpQueryServer({
      catalog: {
        listApprovedCards: () => {
          throw new Error("connection refused to secret host:6333");
        },
      },
      retriever: { searchChunks: async () => [] },
    });

    const envelope = await callTool(server, 10, "select_context", {
      query: DEMO_QUERY,
    });
    const result = readToolResult(envelope);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("internal_error");
    expect(JSON.stringify(envelope)).not.toContain("secret host");
  });
});
