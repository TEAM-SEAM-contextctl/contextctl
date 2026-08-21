import type {
  BatchManagedDocumentSearchCommand,
  BatchManagedDocumentSearchItem,
} from "@contextctl/ingestion-indexing";
import {
  createHttpQueryHandler,
  createMcpQueryServer,
  DEFAULT_POLICY_CONTEXT,
  RESOLVE_PATH,
  SELECTION_MCP_TOOL_NAMES,
  type ApprovedCard,
  type ContextResolution,
  type PolicyContext,
} from "@contextctl/selection-delivery";
import { describe, expect, it } from "vitest";

import {
  DaemonContextApplication,
  type ManagedDocumentSearchPort,
} from "../src/context-application.js";

/**
 * The same policy, the same answer, on every surface.
 *
 * The three surfaces share one `DaemonContextApplication`, and that object is
 * the only place the policy is held. This test pins the consequence SOT §6.6
 * asks for — MCP, HTTP and the CLI return the same policy result — by asking
 * the same question through all three and comparing the selections, under the
 * default policy and under `allow`. The CLI's `query` command calls
 * `resolveContext` on the same application, so the direct call stands for it.
 */

const QUERY = "환불 불가 상품";
const ALLOW: PolicyContext = { usage: "retrieval", sensitiveAccess: "allow" };

function sqlCard(
  cardId: string,
  policy: ApprovedCard["policy"],
  keywords: readonly string[],
): ApprovedCard {
  return {
    cardId,
    versionId: `${cardId}_v1`,
    meaning: {
      description: "환불 정책",
      representativeQuestions: ["환불 불가 상품은 무엇인가요?"],
      aliases: [],
      keywords,
    },
    policy,
    scopes: [
      {
        kind: "sql_source",
        reference: { scopeId: `scope_${cardId}`, scopeVersion: "scopev_0001" },
        connector: "postgres.main",
        schema: "public",
        table: cardId,
        columns: ["id"],
      },
    ],
  };
}

/** Two Cards that both match the query; one is approved as sensitive. */
function cards(): readonly ApprovedCard[] {
  return [
    sqlCard("card_public_refunds", { sensitive: false, allowedUsage: ["retrieval"] }, [
      "환불",
    ]),
    sqlCard("card_sensitive_refunds", { sensitive: true, allowedUsage: ["retrieval"] }, [
      "환불",
    ]),
  ];
}

/** No managed targets are planned for SQL Scopes, so this is never called. */
class NeverSearch implements ManagedDocumentSearchPort {
  searchBatch(
    _command: BatchManagedDocumentSearchCommand,
  ): Promise<readonly BatchManagedDocumentSearchItem[]> {
    return Promise.reject(new Error("no managed target should be searched"));
  }
}

function applicationUnder(policy: PolicyContext): DaemonContextApplication {
  return new DaemonContextApplication({
    catalog: { listApprovedCards: () => Promise.resolve(cards()) },
    search: new NeverSearch(),
    securityDomain: "payments",
    selection: { policy },
  });
}

async function viaMcp(application: DaemonContextApplication): Promise<ContextResolution> {
  const server = createMcpQueryServer(application);
  const reply = await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: SELECTION_MCP_TOOL_NAMES[0], arguments: { query: QUERY } },
    }),
  );
  const envelope = JSON.parse(reply ?? "null") as {
    result?: { content: { text: string }[] };
    error?: unknown;
  };
  expect(envelope.error).toBeUndefined();
  return JSON.parse(envelope.result?.content[0]?.text ?? "null") as ContextResolution;
}

async function viaHttp(application: DaemonContextApplication): Promise<ContextResolution> {
  const handler = createHttpQueryHandler(application);
  const response = await handler({
    method: "POST",
    path: RESOLVE_PATH,
    body: JSON.stringify({ query: QUERY }),
  });
  expect(response.status).toBe(200);
  return JSON.parse(response.body) as ContextResolution;
}

function selectedIds(resolution: ContextResolution): readonly string[] {
  return resolution.selection.selected.map((each) => each.cardId);
}

describe("one policy across MCP, HTTP and the direct application", () => {
  it("keeps the sensitive Card out on every surface under the default policy", async () => {
    const application = applicationUnder(DEFAULT_POLICY_CONTEXT);

    const direct = await application.resolveContext({ query: QUERY });
    const mcp = await viaMcp(application);
    const http = await viaHttp(application);

    expect(selectedIds(direct)).toEqual(["card_public_refunds"]);
    expect(mcp.selection).toEqual(direct.selection);
    expect(http.selection).toEqual(direct.selection);
    expect(mcp.items).toEqual(direct.items);
    expect(http.items).toEqual(direct.items);
    // The excluded Card is evaluated nowhere, so the counts say one Card.
    expect(direct.selection.counts).toEqual({ admitted: 1, deferred: 0, rejected: 0 });
    for (const surface of [direct, mcp, http]) {
      expect(JSON.stringify(surface)).not.toContain("card_sensitive_refunds");
    }
  });

  it("admits the sensitive Card on every surface under allow, and nowhere else", async () => {
    const application = applicationUnder(ALLOW);

    const direct = await application.resolveContext({ query: QUERY });
    const mcp = await viaMcp(application);
    const http = await viaHttp(application);

    expect([...selectedIds(direct)].sort()).toEqual([
      "card_public_refunds",
      "card_sensitive_refunds",
    ]);
    expect(mcp.selection).toEqual(direct.selection);
    expect(http.selection).toEqual(direct.selection);
    expect(direct.selection.counts.admitted).toBe(2);
  });

  it("cannot be widened from the request on any surface", async () => {
    const application = applicationUnder(DEFAULT_POLICY_CONTEXT);

    // A caller naming a policy in the tool arguments or the HTTP body gets the
    // deployment's policy regardless; the field is not part of the request.
    const server = createMcpQueryServer(application);
    const mcpReply = await server.handleMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: SELECTION_MCP_TOOL_NAMES[0],
          arguments: { query: QUERY, policy: ALLOW, sensitiveAccess: "allow" },
        },
      }),
    );
    const handler = createHttpQueryHandler(application);
    const httpResponse = await handler({
      method: "POST",
      path: RESOLVE_PATH,
      body: JSON.stringify({ query: QUERY, policy: ALLOW, sensitiveAccess: "allow" }),
    });

    expect(mcpReply ?? "").not.toContain("card_sensitive_refunds");
    expect(httpResponse.body).not.toContain("card_sensitive_refunds");
  });
});
