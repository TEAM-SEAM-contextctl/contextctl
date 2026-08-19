import { describe, expect, it } from "vitest";

import {
  createHttpQueryHandler,
  createMcpQueryServer,
  CONTEXT_ASSEMBLY_POLICY_VERSION,
  CONTEXT_FUSION_POLICY_VERSION,
  DEFAULT_CONTEXT_BUDGET,
  MCP_PROTOCOL_VERSION,
  QUERY_SCORING_POLICY_VERSION,
  RESOLVE_PATH,
  SELECTION_MCP_TOOL_NAMES,
  SELECTION_PLANNING_POLICY_VERSION,
  SELECTION_RANKING_POLICY_VERSION,
  type ContextResolution,
  type ContextResolutionItem,
  type DeliveryHttpHandler,
  type McpQueryServer,
  type ResolveContextApplication,
} from "../src/index.js";
import {
  createDemoCardSet,
  DEMO_QUERY,
} from "./fixtures/approved-card.fixture.js";
import { createFixtureContextApplication } from "./fixtures/context-application.fixture.js";
import { createRefundPolicyChunkMap } from "./fixtures/document-chunk.fixture.js";

/**
 * The demo path, driven only through what `src/index.ts` publishes.
 *
 * Every import above comes from the package entry point on purpose: the other
 * suites reach into `src/` directly and would still pass if a symbol never made
 * it onto the public surface. This one fails in that case, which is what makes
 * it the check that the demo is runnable by a consumer rather than only by us.
 *
 * `DEMO_QUERY` is imported rather than restated: the Cards and the question they
 * were written to answer are one pair, and a copy of the literal here would let
 * this suite keep scoring against wording the fixture had already moved on from.
 */

/**
 * Physical retrieval coordinates in the shape our infrastructure would use.
 *
 * These are literals and no longer read off the fixture: `ApprovedDocumentIndexRef`
 * has no field to hold them since the contract dropped the physical binding, so
 * the check is no longer "the value the Card carries does not escape" but the
 * stronger "a value of this shape appears nowhere in a response". A regression
 * that reintroduced a connector handle anywhere along the pipeline — read from
 * Indexing, defaulted in an adapter, rebuilt in a projection — would still have
 * to produce a string like one of these to be useful, and would trip here.
 */
const FORBIDDEN_VALUES = {
  connectorId: "vector.local",
  accessHandle: "documents/policies/indexes/refund",
} as const;

/** Field names that must never reach a consumer, whatever they hold. */
const FORBIDDEN_FIELDS = [
  "connectorId",
  "accessHandle",
  "collection",
  "credential",
] as const;

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

/**
 * The demo pipeline behind the one interface a surface may hold.
 *
 * `createFixtureContextApplication` imports from `../src/index.js` too, so the
 * "only the published surface" rule this suite exists for survives the helper:
 * a symbol missing from the entry point fails here exactly as before.
 */
function createDemoApplication(): ResolveContextApplication {
  return createFixtureContextApplication({
    cards: createDemoCardSet(),
    chunks: createRefundPolicyChunkMap(),
  });
}

function resolveDirectly(): Promise<ContextResolution> {
  return createDemoApplication().resolveContext({ query: DEMO_QUERY });
}

/**
 * Whether the selection summary reports this Card as answering the query.
 *
 * `selected` lists admitted Cards only, so membership is the whole verdict a
 * consumer receives. A deferred or rejected Card is not named anywhere in a
 * response, which is why this cannot tell those two apart and does not try.
 */
function wasSelected(resolution: ContextResolution, cardId: string): boolean {
  return resolution.selection.selected.some((card) => card.cardId === cardId);
}

function itemFor(
  resolution: ContextResolution,
  scopeId: string,
): ContextResolutionItem {
  const found = resolution.items.find(
    (item) => item.guide.scopeRef.scopeId === scopeId,
  );

  if (found === undefined) {
    throw new Error(`no item for ${scopeId}`);
  }
  return found;
}

/** `scopeId/scopeVersion` for every item, in the order the response lists them. */
function coordinates(resolution: ContextResolution): readonly string[] {
  return resolution.items.map(
    (item) =>
      `${item.guide.scopeRef.scopeId}/${item.guide.scopeRef.scopeVersion}`,
  );
}

/**
 * Everything the demo query has to be true of, wherever the answer came from.
 *
 * One function rather than three sets of expectations, because the property
 * this suite exists for is not "each surface works" but "the surfaces agree".
 * A direct call, an MCP tool call and an HTTP request must be
 * indistinguishable from the payload, and assertions written per surface would
 * let them drift apart while every test stayed green.
 *
 * It takes the parsed payload only. Both round trips hand back JSON, so
 * re-serializing here is what a consumer would see either way, and the
 * exclusion checks then run over exactly the bytes that crossed the boundary.
 */
function expectDemoResolution(resolution: ContextResolution): void {
  expect(resolution.query).toBe(DEMO_QUERY);

  // First, and before anything that reads the list: a fixture that stopped
  // admitting anything would satisfy every `for`, every `sort` and every set
  // comparison below without a single one of them being asked a question.
  expect(resolution.items.length).toBeGreaterThan(0);
  expect(resolution.items).toHaveLength(3);

  // The selection itself: the demo query reaches all three Cards under the
  // thresholds the package ships, so no test here has to widen the band to see
  // a Scope kind.
  expect(wasSelected(resolution, "card_refund_policy")).toBe(true);
  expect(wasSelected(resolution, "card_payments_table")).toBe(true);
  expect(wasSelected(resolution, "card_payment_api")).toBe(true);
  expect(resolution.selection.counts).toEqual({
    admitted: 3,
    deferred: 0,
    rejected: 0,
  });

  expect(coordinates(resolution)).toEqual([
    "scope_payment_get/scopev_0001",
    "scope_payments_table/scopev_0001",
    "scope_refund_policy_doc/scopev_0001",
  ]);
  // And that list is the sorted one: ascending scopeId, then ascending
  // scopeVersion. Two responses to the same query are directly comparable only
  // if the order is a function of identity rather than of the ranking. Card
  // identity cannot carry it any more — an item can be selected by several
  // Cards — so Scope identity does.
  expect(coordinates(resolution)).toEqual([...coordinates(resolution)].sort());

  // What the three items are, as sets rather than positions: one Scope we
  // answer ourselves and two we hand back as coordinates, one per Scope kind.
  // Stated as sorted sets so the check survives the ordering rule above
  // changing, which is a separate decision from which outcomes exist.
  expect(
    resolution.items.map((item) => item.fulfillment.status).sort(),
  ).toEqual([
    "delegated",
    "delegated",
    "fulfilled",
  ]);
  expect(resolution.items.map((item) => item.guide.kind).sort()).toEqual([
    "http",
    "managed_document",
    "sql",
  ]);

  // The document Scope was fulfilled from our own index...
  const document = itemFor(resolution, "scope_refund_policy_doc");
  expect(document.fulfillment.status).toBe("fulfilled");
  if (document.fulfillment.status !== "fulfilled") {
    throw new Error("expected a fulfilled document item");
  }
  expect(document.fulfillment.context.chunks.length).toBeGreaterThan(0);
  // ...and the item it sits in names the one Scope that authorised it. Context
  // that cannot name an approved source is worse than no context. The chunk no
  // longer repeats the attribution: one statement cannot contradict itself.
  expect(document.guide.scopeRef.scopeId).toBe("scope_refund_policy_doc");
  expect(document.fulfillment.context.contentTrust).toBe("untrusted");
  expect(
    document.fulfillment.context.chunks.map((chunk) => chunk.contextRank),
  ).toEqual([1, 2, 3]);
  // And the item names the Card that selected it, which is what the merge would
  // otherwise have lost.
  expect(document.selectedBy).toEqual([
    { cardId: "card_refund_policy", versionId: "cardv_refund_policy_v1" },
  ]);

  // ...while the consumer's own table was answered with a coordinate rather
  // than with rows.
  const payments = itemFor(resolution, "scope_payments_table");
  expect(payments.fulfillment).toEqual({
    status: "delegated",
    executor: "consumer",
  });
  if (payments.guide.kind !== "sql") {
    throw new Error("expected a sql guide");
  }
  expect(payments.guide.connector).toBe("postgres.main");
  expect(payments.guide.table).toBe("payments");
  expect(payments.guide.columns).toEqual([
    "created_at",
    "failed_reason",
    "payment_id",
    "status",
  ]);
  expect(payments.guide.allowedOperations).toEqual(["select"]);

  // The HTTP Scope crosses every surface with the two coordinates that make it
  // callable. Nothing checked this before: the demo query used to reject this
  // Card, so no round trip ever carried an HTTP guide at all.
  const api = itemFor(resolution, "scope_payment_get");
  expect(api.fulfillment).toEqual({
    status: "delegated",
    executor: "consumer",
  });
  if (api.guide.kind !== "http") {
    throw new Error("expected an http guide");
  }
  expect(api.guide.connector).toBe("payments.api");
  expect(api.guide.method).toBe("GET");
  expect(api.guide.path).toBe("/payments/{paymentId}");

  // Every comparability fact, in one block, on every surface.
  expect(resolution.policy).toEqual({
    payloadSchemaVersion: 3,
    scoring: QUERY_SCORING_POLICY_VERSION,
    ranking: SELECTION_RANKING_POLICY_VERSION,
    planning: SELECTION_PLANNING_POLICY_VERSION,
    fusion: CONTEXT_FUSION_POLICY_VERSION,
    assembly: CONTEXT_ASSEMBLY_POLICY_VERSION,
    budget: DEFAULT_CONTEXT_BUDGET,
  });

  // The split-channel payload is gone: evidence, contracts and failures used to
  // be three sibling lists a consumer had to re-join by coordinates, and a
  // surface still emitting one of them would be shipping schema version 1 under
  // a later label. `candidates` joins them at version 3: publishing every Card
  // a query was scored against handed a consumer the catalog's shape one
  // question at a time.
  for (const field of [
    "evidence",
    "contracts",
    "retrievalFailures",
    "candidates",
  ]) {
    expect(Object.hasOwn(resolution, field)).toBe(false);
  }
  expect(Object.keys(resolution.selection).sort()).toEqual([
    "counts",
    "mode",
    "selected",
  ]);

  expectNoRetrievalCoordinates(resolution);
}

/**
 * Our own infrastructure coordinates never leave, on any surface.
 *
 * The first assertion is about the catalog rather than the response, and it is
 * what keeps the rest from being vacuous. It used to read the coordinates off
 * the Card to prove the fixture carried something worth excluding; the Card
 * cannot carry them any more, so it now asserts the opposite and stronger fact
 * — the entry the whole pipeline reads from holds no physical binding at all,
 * at runtime and not only in the type. Exclusion downstream is then a property
 * of the input rather than a projection rule each layer has to keep applying.
 *
 * Both the field names and the value shapes are still checked on the response,
 * because a regression that renamed a field and shipped the coordinate anyway
 * would satisfy the first list and still leak.
 */
function expectNoRetrievalCoordinates(resolution: ContextResolution): void {
  const scope = createDemoCardSet()[0]?.scopes[0];
  if (scope?.kind !== "managed_document") {
    throw new Error("expected the refund policy Card to hold a document scope");
  }
  for (const field of FORBIDDEN_FIELDS) {
    expect(Object.keys(scope.documentIndex)).not.toContain(field);
  }

  const serialized = JSON.stringify(resolution);

  for (const field of FORBIDDEN_FIELDS) {
    expect(serialized).not.toContain(field);
  }
  expect(serialized).not.toContain(FORBIDDEN_VALUES.connectorId);
  expect(serialized).not.toContain(FORBIDDEN_VALUES.accessHandle);
}

async function send(
  server: McpQueryServer,
  message: unknown,
): Promise<JsonRpcEnvelope> {
  const raw = await server.handleMessage(JSON.stringify(message));

  expect(raw).toBeTypeOf("string");
  return JSON.parse(raw as string) as JsonRpcEnvelope;
}

/** One `resolve_context` tool call, initialize and handshake included. */
async function resolveOverMcp(): Promise<ContextResolution> {
  const server = createMcpQueryServer(createDemoApplication());

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
    params: { name: "resolve_context", arguments: { query: DEMO_QUERY } },
  });
  const result = called.result as ToolCallResult;

  expect(called.error).toBeUndefined();
  expect(result.isError).toBeUndefined();
  expect(result.content[0]?.type).toBe("text");

  return JSON.parse(result.content[0]?.text ?? "null") as ContextResolution;
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

async function resolveOverHttp(): Promise<ContextResolution> {
  const handler = createHttpQueryHandler(createDemoApplication());
  const response = await post(handler, RESOLVE_PATH, {
    query: DEMO_QUERY,
  });

  expect(response.status).toBe(200);
  return response.body as ContextResolution;
}

describe("resolve context end to end", () => {
  it("resolves the demo query into one item per selected scope", async () => {
    expectDemoResolution(await resolveDirectly());
  });

  it("ranks the refund exclusion chunk first", async () => {
    const resolution = await resolveDirectly();
    const document = itemFor(resolution, "scope_refund_policy_doc");

    if (document.fulfillment.status !== "fulfilled") {
      throw new Error("expected a fulfilled document item");
    }
    // The question asks which products cannot be refunded, and the chunk that
    // answers it beats two chunks written in the same vocabulary.
    //
    // The whole order is pinned, not just the winner, and it is reproducible
    // rather than merely observed. `FixtureManagedExecutor` orders the three
    // chunks by bigram Jaccard against the query — 0.108 / 0.030 / 0.027,
    // three distinct numbers — and stamps ranks 1, 2, 3 on them in that order.
    // Fusion then scores each at `1 / (60 + rank)`, which is strictly
    // decreasing in rank, so the fused order is the rank order and
    // `compareChunks` never reaches its `chunkRevisionId` branch here. Anyone
    // tempted to `.sort()` this assertion into passing should read that as the
    // ranking having changed, which is the thing under test.
    expect(
      document.fulfillment.context.chunks.map((chunk) => chunk.chunkId),
    ).toEqual([
      "chunk_refund_excluded",
      "chunk_shipping_fee",
      "chunk_refund_window",
    ]);
  });

  it("delivers the same result over an MCP round trip", async () => {
    expectDemoResolution(await resolveOverMcp());
  });

  it("delivers the same result over an HTTP round trip", async () => {
    expectDemoResolution(await resolveOverHttp());
  });

  it("exposes one route and one tool, and nothing that lists the catalog", async () => {
    const handler = createHttpQueryHandler(createDemoApplication());
    const listed = await handler({
      method: "GET",
      path: "/v1/context/cards",
      body: "",
    });

    // 404, not an empty listing: the route is gone rather than answering with
    // nothing, so a consumer cannot enumerate the catalog without asking a
    // question. The MCP half of the same removal is the tool list below.
    expect(listed.status).toBe(404);
    expect([...SELECTION_MCP_TOOL_NAMES]).toEqual(["resolve_context"]);
  });

  it("returns one identical payload whichever surface asked", async () => {
    // The shared assertion set above says the three surfaces agree on every
    // fact it names. This says they agree on the rest too — a field one surface
    // adds, drops or reorders has nowhere left to hide.
    const direct = await resolveDirectly();
    const overMcp = await resolveOverMcp();
    const overHttp = await resolveOverHttp();

    // Round-tripped so the comparison is between two JSON documents rather than
    // between a live object and a parsed one.
    const serializedDirect = JSON.parse(
      JSON.stringify(direct),
    ) as ContextResolution;

    expect(overMcp).toEqual(serializedDirect);
    expect(overHttp).toEqual(serializedDirect);
  });
});
