import { describe, expect, it } from "vitest";

import type { ResolveContextOptions, ResolveContextPorts } from "../../src/application/resolve-context.js";
import type { ApprovedCard } from "../../src/domain/card-catalog.js";
import type {
  ContextResolution,
  ResolutionItem,
} from "../../src/domain/context-resolution.js";
import { FixtureDocumentRetriever } from "../../src/infrastructure/fixture-document-retriever.js";
import { InMemoryCardCatalog } from "../../src/infrastructure/in-memory-card-catalog.js";
import {
  createMcpQueryServer,
  SELECTION_MCP_TOOL_NAMES,
  type McpQueryServer,
} from "../../src/infrastructure/mcp/mcp-query-server.js";
import {
  DocumentRetrievalFault,
  type DocumentRetrievalFaultCode,
  type ManagedDocumentRetriever,
} from "../../src/ports/managed-document-retriever.js";
import {
  createDemoCardSet,
  createRefundPolicyCard,
  DEMO_QUERY,
} from "../fixtures/approved-card.fixture.js";
import { createRefundPolicyChunkMap } from "../fixtures/document-chunk.fixture.js";

/** The tool name prefixes ADR 0003 forbids from ever reaching `tools/list`. */
const CONTROL_PLANE_WORDS = ["approve", "reject", "rollback", "sync", "edit"];

/**
 * Our own infrastructure coordinates on the refund Card's document index. They
 * are what `ManagedDocumentGuide` deliberately omits, so they are named here as
 * literals and asserted absent from the wire below.
 */
const INDEX_CONNECTOR_ID = "vector.local";
const INDEX_ACCESS_HANDLE = "documents/policies/indexes/refund";

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

function createServer(
  cards: readonly ApprovedCard[],
  retriever: ManagedDocumentRetriever,
  options?: ResolveContextOptions,
): McpQueryServer {
  const ports: ResolveContextPorts = {
    catalog: new InMemoryCardCatalog(cards),
    retriever,
  };

  return createMcpQueryServer(ports, options);
}

/**
 * The demo catalog under the server's own thresholds.
 *
 * Every test in this file uses it, including the serialization and leak tests,
 * which used to build a second server with the threshold band forced open. That
 * band existed only because the old demo query admitted two of the three Scope
 * kinds, and a check on what may cross the boundary is worth little if a whole
 * kind never reaches the boundary. The demo Cards now answer the demo query
 * under the shipped thresholds, so the checks run on the default path.
 */
function createDemoServer(): McpQueryServer {
  return createServer(
    createDemoCardSet(),
    new FixtureDocumentRetriever(createRefundPolicyChunkMap()),
  );
}

/** A one-Card server whose index always raises the given fault. */
function createFaultingServer(code: DocumentRetrievalFaultCode): McpQueryServer {
  return createServer([createRefundPolicyCard()], {
    searchChunks: () => Promise.reject(new DocumentRetrievalFault(code)),
  });
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

function readResolution(envelope: JsonRpcEnvelope): ContextResolution {
  return readToolPayload(envelope) as ContextResolution;
}

/** The one item a Card produced. Every demo Card declares exactly one Scope. */
function itemOf(resolution: ContextResolution, cardId: string): ResolutionItem {
  const item = resolution.items.find((candidate) => candidate.cardId === cardId);

  expect(item).toBeDefined();
  return item as ResolutionItem;
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

    expect(names).toEqual(["list_context_cards", "resolve_context"]);
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
      "card_payments_table",
      "card_payment_api",
    ]);
    expect(payload.cards[0]?.scopeKinds).toEqual(["managed_document"]);
    expect(payload.cards[1]?.scopeKinds).toEqual(["sql_source"]);
    expect(payload.cards[2]?.scopeKinds).toEqual(["http_source"]);
    expect(payload.cards[0]?.keywords).toContain("환불");
  });

  it("resolves the demo query into one item per selected Scope", async () => {
    const envelope = await callTool(createDemoServer(), 3, "resolve_context", {
      query: DEMO_QUERY,
    });

    const resolution = readResolution(envelope);

    expect(resolution.query).toBe(DEMO_QUERY);
    expect(resolution.policy.payloadSchemaVersion).toBe(2);
    expect(resolution.items.length).toBeGreaterThan(0);
    expect(resolution.items).toHaveLength(3);
    expect(resolution.items.map((item) => item.guide.kind).sort()).toEqual([
      "http",
      "managed_document",
      "sql",
    ]);

    const document = itemOf(resolution, "card_refund_policy");
    expect(document.fulfillment).toBe("fulfilled");
    expect(document.guide.kind).toBe("managed_document");
    if (document.fulfillment !== "fulfilled") {
      throw new Error("the refund policy Scope must resolve to retrieved context");
    }
    expect(document.context.chunks.length).toBeGreaterThan(0);
    expect(document.context.chunks[0]?.cardId).toBe("card_refund_policy");

    const table = itemOf(resolution, "card_payments_table");
    expect(table.fulfillment).toBe("delegated");
    expect(table.guide.kind).toBe("sql");
  });

  it("carries our own index coordinates on the fixture Card it must never publish", () => {
    const [scope] = createRefundPolicyCard().scopes;

    // The anti-void half of the leak test below: without this, that test would
    // still pass against a fixture that never held these values at all.
    expect(scope?.kind).toBe("managed_document");
    if (scope?.kind !== "managed_document") {
      throw new Error("the refund policy Card must declare a managed document Scope");
    }
    expect(scope.documentIndex.connectorId).toBe(INDEX_CONNECTOR_ID);
    expect(scope.documentIndex.accessHandle).toBe(INDEX_ACCESS_HANDLE);
  });

  it("never serializes our infrastructure coordinates, by name or by value", async () => {
    const envelope = await callTool(createDemoServer(), 11, "resolve_context", {
      query: DEMO_QUERY,
    });

    const wire = JSON.stringify(envelope);

    for (const field of ["connectorId", "accessHandle", "collection", "credential"]) {
      expect(wire).not.toContain(field);
    }
    // The values as well as the names: a leak that renamed the field would pass
    // a name-only check while still handing the consumer the handle.
    expect(wire).not.toContain(INDEX_CONNECTOR_ID);
    expect(wire).not.toContain(INDEX_ACCESS_HANDLE);
  });

  it("serializes the SQL and HTTP coordinates a consumer needs to act on", async () => {
    const envelope = await callTool(createDemoServer(), 12, "resolve_context", {
      query: DEMO_QUERY,
    });

    const resolution = readResolution(envelope);
    const wire = JSON.stringify(envelope);

    expect(itemOf(resolution, "card_payments_table").guide).toMatchObject({
      kind: "sql",
      connector: "postgres.main",
      table: "payments",
      columns: ["created_at", "failed_reason", "payment_id", "status"],
      allowedOperations: ["select"],
    });
    expect(itemOf(resolution, "card_payment_api").guide).toMatchObject({
      kind: "http",
      connector: "payments.api",
      method: "GET",
      path: "/payments/{paymentId}",
    });

    // `connector` here names the consumer's own datasource and has to cross;
    // `connectorId` above names our store and must not. The two are told apart
    // by what they point at, not by how they are spelled.
    for (const field of [
      "table",
      "columns",
      "allowedOperations",
      "method",
      "path",
      "connector",
    ]) {
      expect(wire).toContain(field);
    }
  });

  it("marks a delegated item as delegated and never as failed", async () => {
    const envelope = await callTool(createDemoServer(), 13, "resolve_context", {
      query: DEMO_QUERY,
    });

    const resolution = readResolution(envelope);
    const delegated = resolution.items.filter(
      (item) => item.guide.kind === "sql" || item.guide.kind === "http",
    );

    expect(delegated).toHaveLength(2);
    for (const item of delegated) {
      expect(item.fulfillment).toBe("delegated");
      // We never ran the consumer's source, so we are in no position to report
      // a failure for it — `code` must be absent, not merely undefined.
      expect(Object.hasOwn(item, "code")).toBe(false);
    }
  });

  it.each([
    "index_unavailable",
    "index_version_mismatch",
    "access_denied",
  ] as const)("reports a %s fault as a failed item", async (code) => {
    const envelope = await callTool(createFaultingServer(code), 14, "resolve_context", {
      query: DEMO_QUERY,
    });

    const resolution = readResolution(envelope);
    const item = itemOf(resolution, "card_refund_policy");

    expect(item.fulfillment).toBe("failed");
    expect(item.guide.kind).toBe("managed_document");
    if (item.fulfillment !== "failed") {
      throw new Error("a faulting index must resolve to a failed item");
    }
    expect(item.code).toBe(code);
    // The fault's own message is written for an operator, not a consumer.
    expect(JSON.stringify(envelope)).not.toContain("Document retrieval failed");
  });

  it("rejects a resolve_context call that carries no query", async () => {
    const envelope = await callTool(createDemoServer(), 4, "resolve_context", {});

    expect(envelope.result).toBeUndefined();
    expect(envelope.error?.code).toBe(-32602);
  });

  it("reports an empty query as a tool error rather than a protocol error", async () => {
    const envelope = await callTool(createDemoServer(), 5, "resolve_context", {
      query: "",
    });

    const result = readToolResult(envelope);

    expect(envelope.error).toBeUndefined();
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("EmptyQueryError");
  });

  it("applies a caller's evidence character ceiling", async () => {
    const envelope = await callTool(createDemoServer(), 6, "resolve_context", {
      query: DEMO_QUERY,
      maxEvidenceCharacters: 1,
    });

    const resolution = readResolution(envelope);

    // The ceiling is a fact about the response as a whole, so it is reported
    // once on the policy block rather than on each item.
    expect(resolution.policy.budget.maxTotalCharacters).toBe(1);

    const document = itemOf(resolution, "card_refund_policy");
    expect(document.fulfillment).toBe("fulfilled");
    if (document.fulfillment !== "fulfilled") {
      throw new Error("a clipped Scope is still fulfilled, not failed");
    }
    expect(document.context.chunks).toEqual([]);
    expect(document.context.truncated).toBe(true);
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

    const envelope = await callTool(server, 10, "resolve_context", {
      query: DEMO_QUERY,
    });
    const result = readToolResult(envelope);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("internal_error");
    expect(JSON.stringify(envelope)).not.toContain("secret host");
  });
});
