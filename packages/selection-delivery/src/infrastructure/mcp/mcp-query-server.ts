import { EmptyQueryError } from "../../application/errors.js";
import {
  selectContext,
  type SelectContextOptions,
  type SelectContextPorts,
} from "../../application/select-context.js";
import type { ApprovedCard, ApprovedScope } from "../../domain/card-catalog.js";
import { EvidenceBudgetInvariantError } from "../../domain/errors.js";
import { DEFAULT_EVIDENCE_BUDGET } from "../../domain/evidence-assembly.js";
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
 * ADR 0003 forbids control plane tools on MCP — no approve, reject, rollback,
 * sync, or edit — and its cost section asks for that absence to be pinned by a
 * regression test rather than by review discipline. This constant is what the
 * test asserts against, so a tool added anywhere else in this file without
 * being named here cannot reach `tools/list`.
 */
export const SELECTION_MCP_TOOL_NAMES = [
  "list_context_cards",
  "select_context",
] as const;

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
    description: "List the approved context cards available for selection.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: SELECTION_MCP_TOOL_NAMES[1],
    description:
      "Select context cards for a query and return document evidence and retrieval coordinates.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        maxEvidenceCharacters: { type: "number" },
      },
      required: ["query"],
    },
  },
];

/**
 * An MCP server over the selection use case, exposing queries only.
 *
 * The server owns no state beyond the ports and options it was built with, so
 * two messages never interfere and a transport may hand it one message at a
 * time in any order. Assembly of the ports themselves stays with the daemon.
 */
export function createMcpQueryServer(
  ports: SelectContextPorts,
  options?: SelectContextOptions,
): McpQueryServer {
  const baseOptions: SelectContextOptions = options ?? {};

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
          return await handleToolCall(ports, baseOptions, id, params);
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
  ports: SelectContextPorts,
  baseOptions: SelectContextOptions,
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

  switch (name) {
    case "list_context_cards":
      return await runTool(id, async () => summarizeCatalog(await listCards(ports)));
    case "select_context":
      return await callSelectContext(ports, baseOptions, id, toolArguments);
    default:
      return formatJsonRpcError(
        id,
        JSON_RPC_INVALID_PARAMS,
        `Unknown tool: ${name}.`,
      );
  }
}

async function callSelectContext(
  ports: SelectContextPorts,
  baseOptions: SelectContextOptions,
  id: JsonRpcId,
  toolArguments: Readonly<Record<string, unknown>>,
): Promise<string> {
  const query = toolArguments["query"];
  if (typeof query !== "string") {
    return formatJsonRpcError(
      id,
      JSON_RPC_INVALID_PARAMS,
      'Tool "select_context" requires a string "query".',
    );
  }

  // A wrong-typed argument is a protocol error rather than a tool failure: the
  // declared input schema says `number`, so the caller broke the contract it
  // was handed. An absent one is not an error — the server's own budget stands.
  const maxEvidenceCharacters = toolArguments["maxEvidenceCharacters"];
  if (
    maxEvidenceCharacters !== undefined &&
    typeof maxEvidenceCharacters !== "number"
  ) {
    return formatJsonRpcError(
      id,
      JSON_RPC_INVALID_PARAMS,
      'Tool "select_context" requires "maxEvidenceCharacters" to be a number.',
    );
  }

  // Only the character ceiling is overridden; the chunk ceiling stays whatever
  // the server was assembled with, so a caller cannot widen a limit it was
  // never given control of.
  const callOptions: SelectContextOptions =
    maxEvidenceCharacters === undefined
      ? baseOptions
      : {
          ...baseOptions,
          budget: {
            ...(baseOptions.budget ?? DEFAULT_EVIDENCE_BUDGET),
            maxTotalCharacters: maxEvidenceCharacters,
          },
        };

  return await runTool(id, () => selectContext(ports, query, callOptions));
}

function listCards(ports: SelectContextPorts): Promise<readonly ApprovedCard[]> {
  return ports.catalog.listApprovedCards();
}

/** What a listing exposes about one Card: enough to choose it, no Scope detail. */
function summarizeCatalog(cards: readonly ApprovedCard[]): unknown {
  return {
    cards: cards.map((card) => ({
      cardId: card.cardId,
      description: card.meaning.description,
      keywords: card.meaning.keywords,
      scopeKinds: distinctScopeKinds(card.scopes),
    })),
  };
}

/** Scope kinds in the order the Card declares them, each reported once. */
function distinctScopeKinds(
  scopes: readonly ApprovedScope[],
): readonly ApprovedScope["kind"][] {
  const kinds: ApprovedScope["kind"][] = [];

  for (const scope of scopes) {
    if (!kinds.includes(scope.kind)) {
      kinds.push(scope.kind);
    }
  }

  return kinds;
}

/**
 * Runs one tool and reduces whatever it throws to an MCP result.
 *
 * A failing tool is not a failing JSON-RPC call: the request was well formed
 * and was answered, so the failure travels as `isError` content the model can
 * read, exactly as MCP intends. Which errors get their message forwarded is the
 * only judgement here — a domain error states a rule the caller broke and is
 * safe to repeat, while anything else may carry adapter-internal detail (a
 * host, a path, a store's own wording) and is reduced to a fixed string. This
 * matches how `select-context.ts` treats a retriever's own exception.
 */
async function runTool(id: JsonRpcId, execute: () => Promise<unknown>): Promise<string> {
  try {
    const payload = await execute();
    return formatJsonRpcResult(id, {
      content: [{ type: "text", text: JSON.stringify(payload) }],
    });
  } catch (cause: unknown) {
    const text =
      cause instanceof EmptyQueryError ||
      cause instanceof EvidenceBudgetInvariantError
        ? `${cause.name}: ${cause.message}`
        : "internal_error";

    return formatJsonRpcResult(id, {
      content: [{ type: "text", text }],
      isError: true,
    });
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
