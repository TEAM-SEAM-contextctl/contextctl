import type {
  ResolveContextApplication,
  ResolveContextRequest,
} from "../../application/context-application.js";
import {
  resolveContextError,
  toResolveContextErrorCode,
} from "../../application/errors.js";
import { serializeContextResolutionPayload } from "../../application/transport-payload.js";
import {
  formatJsonRpcError,
  formatJsonRpcResult,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_METHOD_NOT_FOUND,
  parseJsonRpcMessage,
  type JsonRpcId,
} from "./json-rpc.js";

/**
 * The MCP protocol revision this server advertises.
 *
 * Pinned rather than negotiated: the surface implements three methods by hand
 * (ADR 0005), so claiming a revision we have not read is worse than claiming an
 * older one a client can still fall back to.
 */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/**
 * Every tool this server exposes, in the order `tools/list` reports them.
 *
 * One tool, and the tuple is what pins that. ADR 0003 forbids control plane
 * tools on MCP — no approve, reject, rollback, sync, or edit — and its cost
 * section asks for that absence to be held by a regression test rather than by
 * review discipline; this constant is what the test asserts against, so a tool
 * added anywhere else in this file without being named here cannot reach
 * `tools/list`.
 *
 * A catalog listing tool used to be the first entry and is gone. An agent that
 * can enumerate every approved Card can map the catalog without asking a single
 * question, and the listing answered nothing a resolution does not answer
 * already — the Cards that matter to a query come back as `selection.selected`,
 * attributed to the items they authorised.
 */
export const SELECTION_MCP_TOOL_NAMES = ["resolve_context"] as const;

/** A JSON-RPC endpoint over one message at a time; transport-agnostic. */
export interface McpQueryServer {
  /**
   * Answers one raw message. `undefined` means "no reply" — a notification, or
   * a message too malformed to address a response to.
   */
  handleMessage(rawMessage: string): Promise<string | undefined>;
}

/** One entry of `tools/list`. The schema is a hand-written JSON Schema object. */
interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

const TOOL_DEFINITIONS: readonly McpToolDefinition[] = [
  {
    name: SELECTION_MCP_TOOL_NAMES[0],
    description:
      "Resolve a query into the approved scopes it may be answered from, each with its retrieval guide and, for a managed document, the retrieved context.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        maxContextCharacters: { type: "number" },
      },
      required: ["query"],
    },
  },
];

/**
 * An MCP server over the resolution use case, exposing one query tool.
 *
 * The server owns no state beyond the application it was built with, so two
 * messages never interfere and a transport may hand it one message at a time in
 * any order. Assembly of the ports themselves stays with the daemon.
 *
 * A budget default used to be handed in here too. It is gone for the reason it
 * is gone from the HTTP handler: the ceiling rule belongs where the configured
 * budget lives, and a surface holding its own copy was a second place for it to
 * drift.
 */
export function createMcpQueryServer(
  application: ResolveContextApplication,
): McpQueryServer {
  return {
    async handleMessage(rawMessage: string): Promise<string | undefined> {
      const parsed = parseJsonRpcMessage(rawMessage);
      if (parsed.kind === "invalid") {
        return parsed.response;
      }

      const { id, method, params } = parsed.request;
      // A notification carries no id, and JSON-RPC forbids answering one — an
      // unknown notification is therefore dropped rather than reported.
      if (id === undefined) {
        return undefined;
      }

      switch (method) {
        case "initialize":
          return formatJsonRpcResult(id, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "contextctl-selection", version: "0.0.0" },
          });
        case "tools/list":
          return formatJsonRpcResult(id, { tools: TOOL_DEFINITIONS });
        case "tools/call":
          return await handleToolCall(application, id, params);
        default:
          return formatJsonRpcError(
            id,
            JSON_RPC_METHOD_NOT_FOUND,
            `Unknown method: ${method}.`,
          );
      }
    },
  };
}

async function handleToolCall(
  application: ResolveContextApplication,
  id: JsonRpcId,
  params: unknown,
): Promise<string> {
  const callParams = isRecord(params) ? params : {};
  const name = callParams["name"];
  if (typeof name !== "string") {
    return formatJsonRpcError(
      id,
      JSON_RPC_INVALID_PARAMS,
      'A "tools/call" request requires a string "name".',
    );
  }

  // Absent arguments read as an empty object rather than as an error: a tool
  // whose schema requires nothing is legitimately called without them.
  const rawArguments = callParams["arguments"];
  const toolArguments = isRecord(rawArguments) ? rawArguments : {};

  if (name === SELECTION_MCP_TOOL_NAMES[0]) {
    return await callResolveContext(application, id, toolArguments);
  }

  return formatJsonRpcError(id, JSON_RPC_INVALID_PARAMS, `Unknown tool: ${name}.`);
}

async function callResolveContext(
  application: ResolveContextApplication,
  id: JsonRpcId,
  toolArguments: Readonly<Record<string, unknown>>,
): Promise<string> {
  const query = toolArguments["query"];
  if (typeof query !== "string") {
    return formatJsonRpcError(
      id,
      JSON_RPC_INVALID_PARAMS,
      'Tool "resolve_context" requires a string "query".',
    );
  }

  // A wrong-typed argument is a protocol error rather than a tool failure: the
  // declared input schema says `number`, so the caller broke the contract it
  // was handed. An absent one is not an error — the deployment's own ceiling
  // stands. A number that is out of range is a different thing entirely and is
  // not judged here: it is a well-formed request the resolution refuses, and it
  // comes back as an `invalid_context_budget` tool error.
  const maxContextCharacters = toolArguments["maxContextCharacters"];
  if (
    maxContextCharacters !== undefined &&
    typeof maxContextCharacters !== "number"
  ) {
    return formatJsonRpcError(
      id,
      JSON_RPC_INVALID_PARAMS,
      'Tool "resolve_context" requires "maxContextCharacters" to be a number.',
    );
  }

  // Built by assignment rather than as one literal: `exactOptionalPropertyTypes`
  // makes `{ maxContextCharacters: undefined }` different from an absent key,
  // and an absent key is what selects the configured ceiling.
  const request: ResolveContextRequest =
    maxContextCharacters === undefined
      ? { query }
      : { query, maxContextCharacters };

  return await runTool(id, () => application.resolveContext(request));
}

/**
 * Runs the tool and reduces whatever it throws to an MCP result.
 *
 * A failing tool is not a failing JSON-RPC call: the request was well formed and
 * was answered, so the failure travels as `isError` content the model can read,
 * exactly as MCP intends.
 *
 * The content is the same `ResolveContextError` the HTTP surface puts in its
 * body, serialized as JSON rather than as prose. It used to be an exception's
 * own `name: message` for the two errors deemed safe to repeat and the fixed
 * string `internal_error` for everything else, which meant an agent had to parse
 * English to learn whether retrying was worth it. `code` and `retriable` are
 * both machine-readable, and no exception message crosses at all — a fault
 * raised deep in an adapter names hosts, paths and credentials.
 */
async function runTool(
  id: JsonRpcId,
  execute: () => Promise<unknown>,
): Promise<string> {
  try {
    const payload = await execute();
    return formatJsonRpcResult(id, {
      content: [
        { type: "text", text: serializeContextResolutionPayload(payload) },
      ],
    });
  } catch (cause: unknown) {
    const error = resolveContextError(toResolveContextErrorCode(cause));
    return formatJsonRpcResult(id, {
      content: [{ type: "text", text: JSON.stringify({ error }) }],
      isError: true,
    });
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
