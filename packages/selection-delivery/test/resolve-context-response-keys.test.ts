import { describe, expect, it } from "vitest";

import {
  createHttpQueryHandler,
  createMcpQueryServer,
  DEFAULT_CONTEXT_BUDGET,
  RESOLVE_PATH,
  type ContextResolution,
  type ResolveContextApplication,
} from "../src/index.js";
import {
  ALL_OUTCOMES_QUERY,
  createAllOutcomesCardSet,
} from "./fixtures/approved-card.fixture.js";
import { createFixtureContextApplication } from "./fixtures/context-application.fixture.js";
import { createRefundPolicyChunkMap } from "./fixtures/document-chunk.fixture.js";
import { collectKeys, type JsonObject } from "./fixtures/response-keys.fixture.js";

/**
 * The shape of a schema v3 response, pinned key by key on every surface.
 *
 * Two properties, neither of which any other suite states:
 *
 * 1. Every key is camelCase. snake_case is reserved for *values* — the
 *    enumerations `managed_search`, `lexical_degraded`, `budget_exhausted` and
 *    so on are tokens a consumer branches on and are not keys — so the rule
 *    is stated over keys alone and says nothing about what they hold.
 *
 * 2. Every object in the payload carries exactly the keys its public type
 *    declares. The other suites pin the root, `policy` and `selection`
 *    exhaustively and then check everything below by `not.toHaveProperty`,
 *    which passes for any field nobody thought to forbid. A field added to a
 *    chunk, a guide or an omission has to be added here too, which is the
 *    point: it turns "did anyone notice the payload changed?" into a failing
 *    test.
 *
 * One fixture resolution is used rather than the demo one, because the demo
 * query never exercises a `failed` read or a clipped context. The all-outcomes
 * catalog under a one-chunk budget produces every member of every union the
 * response type declares — fulfilled and failed managed documents, delegated
 * SQL and HTTP guides, retrieved chunks and budget omissions — and the coverage
 * test below asserts it keeps doing so, so an exhaustiveness check can never
 * quietly pass over a variant the fixture stopped producing.
 *
 * Checked on all three surfaces. The direct call is re-serialized first so the
 * three are compared over the same bytes a consumer receives; a key that only
 * exists in memory is not a key anyone outside this package can see.
 */

/** Allowed keys of one object: `required` must all be present, `optional` may be. */
interface KeySet {
  readonly required: readonly string[];
  readonly optional?: readonly string[];
}

const SCOPE_REF: KeySet = { required: ["scopeId", "scopeVersion"] };
const CARD_REFERENCE: KeySet = { required: ["cardId", "versionId"] };

const ROOT: KeySet = { required: ["items", "policy", "query", "selection"] };
const POLICY: KeySet = {
  required: [
    "assembly",
    "budget",
    "fusion",
    "payloadSchemaVersion",
    "planning",
    "ranking",
    "scoring",
  ],
};
const BUDGET: KeySet = { required: ["maxChunks", "maxTotalCharacters"] };
const SELECTION: KeySet = { required: ["counts", "mode", "selected"] };
const COUNTS: KeySet = { required: ["admitted", "deferred", "rejected"] };
const ITEM: KeySet = { required: ["fulfillment", "guide", "selectedBy"] };

const MANAGED_DOCUMENT_GUIDE: KeySet = {
  required: [
    "documentId",
    "documentIndexId",
    "indexVersion",
    "kind",
    "limit",
    "scopeRef",
    "selector",
    "sourceId",
  ],
};
const SQL_GUIDE: KeySet = {
  required: [
    "allowedOperations",
    "columns",
    "connector",
    "kind",
    "schema",
    "scopeRef",
    "table",
  ],
};
/** `operationId` is `string | undefined` and an undefined one is not serialized. */
const HTTP_GUIDE: KeySet = {
  required: ["connector", "kind", "method", "parameters", "path", "scopeRef"],
  optional: ["operationId"],
};
const HTTP_PARAMETER: KeySet = { required: ["location", "name", "required"] };
const DOCUMENT_SELECTOR: KeySet = { required: ["kind"] };
const SEMANTIC_UNITS_SELECTOR: KeySet = {
  required: ["kind", "semanticUnitIds"],
};

const FULFILLED: KeySet = { required: ["context", "executor", "status"] };
const FAILED: KeySet = { required: ["executor", "failure", "status"] };
const DELEGATED: KeySet = { required: ["executor", "status"] };
const FAILURE: KeySet = { required: ["code", "retriable", "stage"] };
const CONTEXT: KeySet = {
  required: ["chunks", "contentTrust", "omitted", "truncated"],
};
const CHUNK: KeySet = {
  required: [
    "chunkId",
    "chunkRevisionId",
    "contentDigest",
    "contextRank",
    "documentId",
    "semanticUnitId",
    "text",
  ],
};
const OMISSION: KeySet = { required: ["chunkId", "chunkRevisionId", "reason"] };

/** One lowercase word followed by capitalised words; digits allowed, nothing else. */
const CAMEL_CASE = /^[a-z][a-zA-Z0-9]*$/;

/**
 * Exhaustive, not containment. `toMatchObject` and `toHaveProperty` both pass
 * for an object that gained a key, and the claim here is precisely that none
 * has.
 */
function expectKeys(value: unknown, keys: KeySet, at: string): JsonObject {
  expect(value, at).toBeTypeOf("object");
  expect(value, at).not.toBeNull();
  expect(Array.isArray(value), at).toBe(false);
  const object = value as JsonObject;

  const actual = Object.keys(object).sort();
  const optional = keys.optional ?? [];
  const unexpected = actual.filter(
    (key) => !keys.required.includes(key) && !optional.includes(key),
  );
  const missing = keys.required.filter((key) => !actual.includes(key));

  expect(unexpected, `${at}: keys not declared by the public type`).toEqual([]);
  expect(missing, `${at}: keys the public type requires`).toEqual([]);
  return object;
}

function expectArray(value: unknown, at: string): readonly unknown[] {
  expect(Array.isArray(value), at).toBe(true);
  return value as readonly unknown[];
}

/** What the fixture resolution exercised, so exhaustiveness is never vacuous. */
interface Coverage {
  fulfilled: number;
  failed: number;
  delegated: number;
  managedDocument: number;
  sql: number;
  http: number;
  chunks: number;
  omitted: number;
}

function expectPublicShape(payload: unknown): Coverage {
  const coverage: Coverage = {
    fulfilled: 0,
    failed: 0,
    delegated: 0,
    managedDocument: 0,
    sql: 0,
    http: 0,
    chunks: 0,
    omitted: 0,
  };

  const root = expectKeys(payload, ROOT, "$");
  const policy = expectKeys(root["policy"], POLICY, "$.policy");
  expectKeys(policy["budget"], BUDGET, "$.policy.budget");

  const selection = expectKeys(root["selection"], SELECTION, "$.selection");
  expectKeys(selection["counts"], COUNTS, "$.selection.counts");
  for (const [index, card] of expectArray(
    selection["selected"],
    "$.selection.selected",
  ).entries()) {
    expectKeys(card, CARD_REFERENCE, `$.selection.selected[${index}]`);
  }

  for (const [index, element] of expectArray(root["items"], "$.items").entries()) {
    const at = `$.items[${index}]`;
    const item = expectKeys(element, ITEM, at);

    for (const [cardIndex, card] of expectArray(
      item["selectedBy"],
      `${at}.selectedBy`,
    ).entries()) {
      expectKeys(card, CARD_REFERENCE, `${at}.selectedBy[${cardIndex}]`);
    }

    const guide = item["guide"] as JsonObject;
    switch (guide["kind"]) {
      case "managed_document": {
        coverage.managedDocument += 1;
        expectKeys(guide, MANAGED_DOCUMENT_GUIDE, `${at}.guide`);
        expectKeys(guide["scopeRef"], SCOPE_REF, `${at}.guide.scopeRef`);
        const selector = guide["selector"] as JsonObject;
        expectKeys(
          selector,
          selector["kind"] === "semantic_units"
            ? SEMANTIC_UNITS_SELECTOR
            : DOCUMENT_SELECTOR,
          `${at}.guide.selector`,
        );
        break;
      }
      case "sql": {
        coverage.sql += 1;
        expectKeys(guide, SQL_GUIDE, `${at}.guide`);
        expectKeys(guide["scopeRef"], SCOPE_REF, `${at}.guide.scopeRef`);
        break;
      }
      case "http": {
        coverage.http += 1;
        expectKeys(guide, HTTP_GUIDE, `${at}.guide`);
        expectKeys(guide["scopeRef"], SCOPE_REF, `${at}.guide.scopeRef`);
        for (const [parameterIndex, parameter] of expectArray(
          guide["parameters"],
          `${at}.guide.parameters`,
        ).entries()) {
          expectKeys(
            parameter,
            HTTP_PARAMETER,
            `${at}.guide.parameters[${parameterIndex}]`,
          );
        }
        break;
      }
      default:
        throw new Error(`${at}.guide.kind: unknown kind ${String(guide["kind"])}`);
    }

    const fulfillment = item["fulfillment"] as JsonObject;
    switch (fulfillment["status"]) {
      case "fulfilled": {
        coverage.fulfilled += 1;
        expectKeys(fulfillment, FULFILLED, `${at}.fulfillment`);
        const context = expectKeys(
          fulfillment["context"],
          CONTEXT,
          `${at}.fulfillment.context`,
        );
        for (const [chunkIndex, chunk] of expectArray(
          context["chunks"],
          `${at}.fulfillment.context.chunks`,
        ).entries()) {
          coverage.chunks += 1;
          expectKeys(chunk, CHUNK, `${at}.fulfillment.context.chunks[${chunkIndex}]`);
        }
        for (const [omissionIndex, omission] of expectArray(
          context["omitted"],
          `${at}.fulfillment.context.omitted`,
        ).entries()) {
          coverage.omitted += 1;
          expectKeys(
            omission,
            OMISSION,
            `${at}.fulfillment.context.omitted[${omissionIndex}]`,
          );
        }
        break;
      }
      case "failed": {
        coverage.failed += 1;
        expectKeys(fulfillment, FAILED, `${at}.fulfillment`);
        expectKeys(fulfillment["failure"], FAILURE, `${at}.fulfillment.failure`);
        break;
      }
      case "delegated": {
        coverage.delegated += 1;
        expectKeys(fulfillment, DELEGATED, `${at}.fulfillment`);
        break;
      }
      default:
        throw new Error(
          `${at}.fulfillment.status: unknown status ${String(fulfillment["status"])}`,
        );
    }
  }

  return coverage;
}

/**
 * The all-outcomes catalog under a budget of one chunk.
 *
 * One chunk is what makes `omitted` non-empty and `truncated` true on the
 * fulfilled item: the indexed document answers with three chunks, and two of
 * them lose the budget. Without the cut the omission shape would never be
 * produced and its key set never checked.
 */
function createApplication(): ResolveContextApplication {
  return createFixtureContextApplication({
    cards: createAllOutcomesCardSet(),
    chunks: createRefundPolicyChunkMap(),
    budget: {
      maxTotalCharacters: DEFAULT_CONTEXT_BUDGET.maxTotalCharacters,
      maxChunks: 1,
    },
  });
}

/** As a consumer holding the object in process would serialize it. */
async function resolveDirectly(): Promise<unknown> {
  const resolution = await createApplication().resolveContext({
    query: ALL_OUTCOMES_QUERY,
  });
  return JSON.parse(JSON.stringify(resolution)) as unknown;
}

async function resolveOverMcp(): Promise<unknown> {
  const server = createMcpQueryServer(createApplication());
  const raw = await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "resolve_context",
        arguments: { query: ALL_OUTCOMES_QUERY },
      },
    }),
  );
  expect(raw).toBeTypeOf("string");
  const envelope = JSON.parse(raw as string) as {
    readonly error?: unknown;
    readonly result?: {
      readonly isError?: boolean;
      readonly content: readonly { readonly type: string; readonly text: string }[];
    };
  };
  expect(envelope.error).toBeUndefined();
  expect(envelope.result?.isError).toBeUndefined();
  return JSON.parse(envelope.result?.content[0]?.text ?? "null") as unknown;
}

async function resolveOverHttp(): Promise<unknown> {
  const handler = createHttpQueryHandler(createApplication());
  const response = await handler({
    method: "POST",
    path: RESOLVE_PATH,
    body: JSON.stringify({ query: ALL_OUTCOMES_QUERY }),
  });
  expect(response.status).toBe(200);
  return JSON.parse(response.body) as unknown;
}

const SURFACES = [
  ["direct call", resolveDirectly],
  ["MCP tools/call", resolveOverMcp],
  ["HTTP POST /v1/context/resolve", resolveOverHttp],
] as const;

describe("resolve_context response keys", () => {
  it("exercises every variant the response type declares", async () => {
    // Stated once, on the direct call, because the other two surfaces carry
    // the same resolution (see the cross-surface test below). If a fixture edit
    // stops producing a variant, this fails rather than the exhaustiveness
    // checks silently covering less.
    const coverage = expectPublicShape(await resolveDirectly());

    expect(coverage).toEqual({
      fulfilled: 1,
      failed: 1,
      delegated: 2,
      managedDocument: 2,
      sql: 1,
      http: 1,
      chunks: 1,
      omitted: 2,
    });
  });

  describe.each(SURFACES)("over the %s", (_surface, resolve) => {
    it("uses camelCase for every key, at every depth", async () => {
      const keys = [...collectKeys(await resolve())].sort();

      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect(key, `key ${JSON.stringify(key)}`).toMatch(CAMEL_CASE);
      }
    });

    it("carries exactly the keys the public types declare, on every object", async () => {
      expectPublicShape(await resolve());
    });
  });

  it("serializes one identical payload whichever surface asked", async () => {
    // What lets the coverage test speak for all three: the surfaces do not
    // build their own payloads, they forward one. A surface that re-shaped the
    // resolution on its way out would diverge here first.
    const [direct, mcp, http] = await Promise.all([
      resolveDirectly(),
      resolveOverMcp(),
      resolveOverHttp(),
    ]);

    expect(mcp).toEqual(direct);
    expect(http).toEqual(direct);
  });

  it("is typed as the resolution it serializes", async () => {
    // Guards the helpers rather than the payload: `resolveDirectly` goes
    // through JSON so the three surfaces compare like for like, and this pins
    // that what went in was a `ContextResolution` and not an envelope.
    const resolution: ContextResolution = await createApplication().resolveContext({
      query: ALL_OUTCOMES_QUERY,
    });

    expect(JSON.parse(JSON.stringify(resolution))).toEqual(await resolveDirectly());
  });
});
