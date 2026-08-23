import { describe, expect, it } from "vitest";

import type { ApprovedCard } from "../../src/domain/card-catalog.js";
import type {
  ContextResolution,
  ContextResolutionItem,
} from "../../src/domain/context-resolution.js";
import {
  createMcpQueryServer,
  SELECTION_MCP_TOOL_NAMES,
  type McpQueryServer,
} from "../../src/infrastructure/mcp/mcp-query-server.js";
import {
  createDemoCardSet,
  createRefundPolicyCard,
  DEMO_QUERY,
} from "../fixtures/approved-card.fixture.js";
import { createFixtureContextApplication } from "../fixtures/context-application.fixture.js";
import { createRefundPolicyChunkMap } from "../fixtures/document-chunk.fixture.js";

/** The tool name prefixes ADR 0003 forbids from ever reaching `tools/list`. */
const CONTROL_PLANE_WORDS = ["approve", "reject", "rollback", "sync", "edit"];

/**
 * Infrastructure coordinates in the shape our own store would use for the
 * refund document.
 *
 * No document index carries them any more: the contract dropped the physical
 * binding, so `ApprovedDocumentIndexRef` has nowhere to put a connector id or
 * an access handle and `ManagedDocumentGuide` omits what was never there. They
 * stay named here as literals because the wire check they feed is worth more
 * this way — it asks whether a coordinate of this shape appears in a response
 * at all, rather than whether one specific fixture value survived, and any
 * reintroduced binding would have to look like this to be usable.
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

function createServer(cards: readonly ApprovedCard[]): McpQueryServer {
  return createMcpQueryServer(
    createFixtureContextApplication({
      cards,
      chunks: createRefundPolicyChunkMap(),
    }),
  );
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
  return createServer(createDemoCardSet());
}

/** A one-Card server whose executor always fails with the given code. */
function createFailingServer(
  code: string,
  retriable = false,
): McpQueryServer {
  return createMcpQueryServer(
    createFixtureContextApplication({
      cards: [createRefundPolicyCard()],
      execute: (_queryText, targets) =>
        targets.map((target) => ({
          targetKey: target.targetKey,
          status: "failed" as const,
          failure: { stage: "managed_search" as const, code, retriable },
        })),
    }),
  );
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

/**
 * The one item a Card produced, found through `selectedBy`.
 *
 * An item is one Scope under one bound now rather than one (Card, Scope) pair,
 * so a Card is one of possibly several that selected it. Every demo Card
 * declares exactly one Scope and no two share one, so the lookup is still
 * unambiguous here.
 */
function itemOf(resolution: ContextResolution, cardId: string): ContextResolutionItem {
  const item = resolution.items.find((candidate) =>
    candidate.selectedBy.some((reference) => reference.cardId === cardId),
  );

  expect(item).toBeDefined();
  return item as ContextResolutionItem;
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
  it("exposes exactly one query tool and no control plane tool", async () => {
    const envelope = await send(createDemoServer(), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });

    const { tools } = envelope.result as { tools: readonly McpToolDescriptor[] };
    const names = tools.map((tool) => tool.name);

    expect(names).toEqual(["resolve_context"]);
    expect(names).toEqual([...SELECTION_MCP_TOOL_NAMES]);
    expect(tools).toHaveLength(1);

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

  it("no longer lists the approved Cards at all", async () => {
    // Not "answers an empty list": the tool is gone, so a caller asking for it
    // is asking for a tool that does not exist. An agent that could enumerate
    // every approved Card could map the catalog without asking a question.
    const envelope = await callTool(createDemoServer(), 2, "list_context_cards");

    expect(envelope.result).toBeUndefined();
    expect(envelope.error?.code).toBe(-32602);
  });

  it("resolves the demo query into one item per selected Scope", async () => {
    const envelope = await callTool(createDemoServer(), 3, "resolve_context", {
      query: DEMO_QUERY,
    });

    const resolution = readResolution(envelope);

    expect(resolution.query).toBe(DEMO_QUERY);
    expect(resolution.policy.payloadSchemaVersion).toBe(3);
    expect(resolution.items.length).toBeGreaterThan(0);
    expect(resolution.items).toHaveLength(3);
    expect(resolution.items.map((item) => item.guide.kind).sort()).toEqual([
      "http",
      "managed_document",
      "sql",
    ]);

    const document = itemOf(resolution, "card_refund_policy");
    expect(document.fulfillment.status).toBe("fulfilled");
    expect(document.guide.kind).toBe("managed_document");
    if (document.fulfillment.status !== "fulfilled") {
      throw new Error("the refund policy Scope must resolve to retrieved context");
    }
    expect(document.fulfillment.context.chunks.length).toBeGreaterThan(0);
    // Chunks are attributed by the item they sit in, not by a key repeated on
    // each of them: an item can be selected by several Cards and its context
    // belongs to all of them at once.
    expect(document.fulfillment.context.chunks[0]?.contextRank).toBe(1);
    expect(document.fulfillment.context.contentTrust).toBe("untrusted");

    const table = itemOf(resolution, "card_payments_table");
    expect(table.fulfillment.status).toBe("delegated");
    expect(table.guide.kind).toBe("sql");
  });

  it("holds no index coordinates on the fixture Card, not even to omit later", () => {
    const [scope] = createRefundPolicyCard().scopes;

    // This used to be the anti-void half of the leak test below, asserting the
    // fixture really held the values that test says never cross the wire. The
    // Card cannot hold them any more, so the premise inverts and strengthens:
    // the document index a selection is planned from is exactly four logical
    // fields, checked as a whole set rather than field by field so that a new
    // physical field added later fails here instead of quietly riding along to
    // the serializer and relying on a projection to drop it.
    expect(scope?.kind).toBe("managed_document");
    if (scope?.kind !== "managed_document") {
      throw new Error("the refund policy Card must declare a managed document Scope");
    }
    expect(Object.keys(scope.documentIndex).sort()).toEqual([
      "documentId",
      "documentIndexId",
      "indexVersion",
      "sourceId",
    ]);
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
      expect(item.fulfillment.status).toBe("delegated");
      // We never ran the consumer's source, so we are in no position to report
      // a failure for it — `failure` must be absent, not merely undefined.
      expect(Object.hasOwn(item.fulfillment, "failure")).toBe(false);
      expect(item.fulfillment.executor).toBe("consumer");
    }
  });

  /**
   * Four codes from the executor's own vocabulary, none of which this package
   * declares anywhere. That is the assertion: the code crosses by name, so a
   * surface that folded it into a vocabulary of its own would answer with
   * something other than what was handed to it.
   */
  it.each([
    "index_binding_unavailable",
    "scope_not_published",
    "security_domain_mismatch",
    "query_embedding_failed",
  ])("reports a %s failure under the executor's own name", async (code) => {
    const envelope = await callTool(
      createFailingServer(code, true),
      14,
      "resolve_context",
      { query: DEMO_QUERY },
    );

    const resolution = readResolution(envelope);
    const item = itemOf(resolution, "card_refund_policy");

    expect(item.fulfillment.status).toBe("failed");
    expect(item.guide.kind).toBe("managed_document");
    if (item.fulfillment.status !== "failed") {
      throw new Error("a failing read must resolve to a failed item");
    }
    expect(item.fulfillment.failure).toEqual({
      stage: "managed_search",
      code,
      retriable: true,
    });
    // The exception behind a failure is written for an operator, not a consumer.
    expect(JSON.stringify(envelope)).not.toContain("Managed document search failed");
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
    // A machine-readable record rather than an exception's own `name: message`.
    // An agent deciding whether to retry should not have to parse English, and
    // the same record is what the HTTP surface puts in its body.
    expect(JSON.parse(result.content[0]?.text ?? "null")).toEqual({
      error: { code: "empty_query", retriable: false },
    });
  });

  it("reports a ceiling it cannot apply as invalid_context_budget", async () => {
    const envelope = await callTool(createDemoServer(), 15, "resolve_context", {
      query: DEMO_QUERY,
      // Above the configured ceiling: refused rather than clamped, so a caller
      // that believed it had widened the budget is told it had not.
      maxContextCharacters: 999_999,
    });

    const result = readToolResult(envelope);

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? "null")).toEqual({
      error: { code: "invalid_context_budget", retriable: false },
    });
  });

  it("rejects a ceiling of the wrong type as a protocol error", async () => {
    // The declared input schema says `number`, so a string breaks the contract
    // the caller was handed rather than asking for something we refuse.
    const envelope = await callTool(createDemoServer(), 16, "resolve_context", {
      query: DEMO_QUERY,
      maxContextCharacters: "1",
    });

    expect(envelope.result).toBeUndefined();
    expect(envelope.error?.code).toBe(-32602);
  });

  it("applies a caller's context character ceiling", async () => {
    const envelope = await callTool(createDemoServer(), 6, "resolve_context", {
      query: DEMO_QUERY,
      maxContextCharacters: 1,
    });

    const resolution = readResolution(envelope);

    // The ceiling is a fact about the response as a whole, so it is reported
    // once on the policy block rather than on each item.
    expect(resolution.policy.budget.maxTotalCharacters).toBe(1);

    const document = itemOf(resolution, "card_refund_policy");
    expect(document.fulfillment.status).toBe("fulfilled");
    if (document.fulfillment.status !== "fulfilled") {
      throw new Error("a clipped Scope is still fulfilled, not failed");
    }
    expect(document.fulfillment.context.chunks).toEqual([]);
    expect(document.fulfillment.context.truncated).toBe(true);
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

  /**
   * The MCP methods a server *could* serve and this one does not, named one by
   * one rather than left to the generic unknown-method case above. That case
   * proves an invented name is refused; it says nothing about a real method a
   * future edit might wire up by accident — a resource listing that exposed
   * the catalog would be exactly the control plane ADR 0003 removed, under a
   * method name nobody grepped for. Each is refused with `-32601` and echoes
   * the id, so a client learns the method is absent rather than timing out.
   */
  it.each([
    "resources/list",
    "resources/read",
    "resources/templates/list",
    "resources/subscribe",
    "prompts/list",
    "prompts/get",
    "completion/complete",
    "logging/setLevel",
  ])("refuses %s as method_not_found", async (method) => {
    const envelope = await send(createDemoServer(), {
      jsonrpc: "2.0",
      id: `absent-${method}`,
      method,
      params: {},
    });

    expect(envelope.id).toBe(`absent-${method}`);
    expect(envelope.result).toBeUndefined();
    expect(envelope.error?.code).toBe(-32601);
  });

  it("advertises the tools capability and nothing else", async () => {
    // Exhaustive on the capability keys: `tools` being defined is asserted
    // above, but a server that also declared `resources` or `prompts` while
    // refusing their methods would be advertising a surface it does not have,
    // and one that grew them for real would be widening the surface past the
    // one tool.
    const envelope = await send(createDemoServer(), {
      jsonrpc: "2.0",
      id: "init-2",
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    const result = envelope.result as {
      readonly capabilities: Readonly<Record<string, unknown>>;
    };

    expect(Object.keys(result.capabilities)).toEqual(["tools"]);
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

  it("reduces an unexpected port failure to unexpected_failure", async () => {
    const server = createMcpQueryServer(
      createFixtureContextApplication({
        catalog: {
          listApprovedCards: () => {
            throw new Error("connection refused to secret host:6333");
          },
        },
      }),
    );

    const envelope = await callTool(server, 10, "resolve_context", {
      query: DEMO_QUERY,
    });
    const result = readToolResult(envelope);

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? "null")).toEqual({
      error: { code: "unexpected_failure", retriable: false },
    });
    expect(JSON.stringify(envelope)).not.toContain("secret host");
  });
});
