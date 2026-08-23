import type { Readable, Writable } from "node:stream";

import {
  ResolveContextFailure,
  resolveContextError,
  toResolveContextErrorCode,
} from "../../application/errors.js";
import { assertContextResolutionPayloadWithinLimit } from "../../application/transport-payload.js";
import {
  RESOLVE_REQUEST_MAXIMUM_BYTES,
  utf8ByteLength,
} from "../../domain/transport-policy.js";
import type { DeliveryRequestExecution } from "../transport/request-execution.js";
import {
  formatJsonRpcResult,
  parseJsonRpcMessage,
  type JsonRpcId,
} from "./json-rpc.js";
import type { McpQueryServer } from "./mcp-query-server.js";

/**
 * Runs an `McpQueryServer` over a pair of newline-delimited JSON streams.
 *
 * The streams are injected rather than taken from `process`, so this file
 * contains no process entry point: ADR 0005 leaves the wiring of stdio — and
 * the decision to have a runnable binary at all — to the daemon. A test can
 * therefore drive the whole transport with two `PassThrough`s.
 *
 * Resolves when the input ends and every line read from it has been answered;
 * rejects only if the input itself errors or the server throws, which a server
 * that reduces its own failures to responses does not do.
 */
export async function runStdioServer(
  server: McpQueryServer,
  input: Readable,
  output: Writable,
  execution?: DeliveryRequestExecution,
): Promise<void> {
  if (execution !== undefined) {
    await runControlledStdioServer(server, input, output, execution);
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let buffer = "";
    let discardingOversizedFrame = false;
    // Messages are answered strictly in arrival order. `handleMessage` is
    // async and `data` events do not wait for it, so without this chain two
    // chunks arriving close together could have their responses interleaved or
    // reordered — and a JSON-RPC client matches responses by id, but a human
    // reading the stream cannot.
    let queue: Promise<void> = Promise.resolve();

    const enqueue = (line: string): void => {
      queue = queue.then(async () => {
        const response = await server.handleMessage(line);
        // A notification produces nothing to write; writing an empty line for
        // it would desynchronise a peer counting framed messages.
        if (response !== undefined) {
          output.write(`${boundedMcpResponse(response)}\n`);
        }
      });
    };

    const rejectOversizedFrame = (): void => {
      queue = queue.then(() => {
        output.write(`${requestTooLargeResponse()}\n`);
      });
    };

    // Decoding here rather than per chunk: a chunk boundary can fall inside a
    // multi-byte character, and `setEncoding` carries the partial sequence to
    // the next chunk instead of producing a replacement character.
    input.setEncoding("utf8");

    input.on("data", (incoming: string) => {
      let chunk = incoming;
      if (discardingOversizedFrame) {
        const boundary = chunk.indexOf("\n");
        if (boundary === -1) return;
        chunk = chunk.slice(boundary + 1);
        discardingOversizedFrame = false;
      }
      buffer += chunk;

      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        // Blank lines are framing, not messages: answering one with a parse
        // error would turn a peer's stray newline into a protocol failure.
        if (utf8ByteLength(line) > RESOLVE_REQUEST_MAXIMUM_BYTES) {
          rejectOversizedFrame();
        } else if (line.trim() !== "") {
          enqueue(line);
        }
        newline = buffer.indexOf("\n");
      }

      if (utf8ByteLength(buffer) > RESOLVE_REQUEST_MAXIMUM_BYTES) {
        buffer = "";
        discardingOversizedFrame = true;
        rejectOversizedFrame();
      }
    });

    input.on("error", reject);

    input.on("end", () => {
      // A final message without a trailing newline is still a message — a
      // writer that closes the stream has framed it as surely as a newline
      // would have.
      if (
        !discardingOversizedFrame &&
        utf8ByteLength(buffer) > RESOLVE_REQUEST_MAXIMUM_BYTES
      ) {
        rejectOversizedFrame();
      } else if (!discardingOversizedFrame && buffer.trim() !== "") {
        enqueue(buffer);
      }
      buffer = "";
      discardingOversizedFrame = false;
      queue.then(resolve, reject);
    });
  });
}

interface PendingMessage {
  readonly line: string;
  readonly arrivedAt: number;
  readonly envelope: MessageEnvelope;
}

interface MessageEnvelope {
  readonly id?: JsonRpcId;
  readonly cancellationId?: JsonRpcId;
}

/**
 * Concurrent framing used when a composition root supplies runtime control.
 *
 * Delivery still owns JSON-RPC framing, cancellation and response encoding.
 * The injected executor alone owns whether a Resolve call runs, waits or is
 * refused and how long it may live.
 */
async function runControlledStdioServer(
  server: McpQueryServer,
  input: Readable,
  output: Writable,
  execution: DeliveryRequestExecution,
): Promise<void> {
  if (
    !Number.isSafeInteger(execution.maximumInFlightRequests) ||
    execution.maximumInFlightRequests < 1
  ) {
    throw new TypeError("maximumInFlightRequests must be a positive integer");
  }

  await new Promise<void>((resolve, reject) => {
    const pending: PendingMessage[] = [];
    const inFlight = new Set<Promise<void>>();
    const controllers = new Map<string, Set<AbortController>>();
    let writes: Promise<void> = Promise.resolve();
    let buffer = "";
    let bufferedAt: number | undefined;
    let discardingOversizedFrame = false;
    let ended = false;
    let settled = false;

    const finishIfDone = (): void => {
      if (
        settled ||
        !ended ||
        buffer !== "" ||
        pending.length !== 0 ||
        inFlight.size !== 0
      ) {
        return;
      }
      settled = true;
      writes.then(resolve, reject);
    };

    const queueWrite = (line: string): void => {
      writes = writes.then(
        async () =>
          await new Promise<void>((resolveWrite, rejectWrite) => {
            output.write(`${boundedMcpResponse(line)}\n`, (cause) => {
              if (cause === undefined || cause === null) resolveWrite();
              else rejectWrite(cause);
            });
          }),
      );
    };

    const cancel = (id: JsonRpcId): void => {
      const key = idKey(id);
      for (const controller of controllers.get(key) ?? []) {
        controller.abort(new Error("MCP caller cancelled the request"));
      }
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        const pendingId = pending[index]?.envelope.id;
        if (pendingId !== undefined && idKey(pendingId) === key) {
          pending.splice(index, 1);
        }
      }
    };

    const start = (message: PendingMessage): void => {
      const caller = new AbortController();
      const key =
        message.envelope.id === undefined
          ? undefined
          : idKey(message.envelope.id);
      if (key !== undefined) {
        const active = controllers.get(key) ?? new Set<AbortController>();
        active.add(caller);
        controllers.set(key, active);
      }

      let operation: Promise<void>;
      operation = execution
        .runRequest(
          { arrivedAt: message.arrivedAt, signal: caller.signal },
          async () => {
            const response = await server.handleMessage(message.line);
            if (response !== undefined) {
              if (!isErrorResponse(response)) {
                execution.assertResponseCanCommit();
              }
              if (!caller.signal.aborted) queueWrite(response);
            }
          },
        )
        .catch((cause: unknown) => {
          if (message.envelope.id !== undefined && !caller.signal.aborted) {
            queueWrite(failureResponse(message.envelope.id, cause));
          }
        })
        .finally(() => {
          if (key !== undefined) {
            const active = controllers.get(key);
            active?.delete(caller);
            if (active?.size === 0) controllers.delete(key);
          }
          inFlight.delete(operation);
          drainBuffer(ended);
          finishIfDone();
        });
      inFlight.add(operation);
    };

    const pump = (): void => {
      while (
        pending.length > 0 &&
        inFlight.size < execution.maximumInFlightRequests
      ) {
        const message = pending.shift();
        if (message === undefined) break;
        start(message);
      }

      if (
        pending.length > 0 ||
        (buffer.includes("\n") &&
          inFlight.size >= execution.maximumInFlightRequests)
      ) {
        input.pause();
      } else if (!ended) {
        input.resume();
      }
      finishIfDone();
    };

    const acceptLine = (line: string, arrivedAt: number): void => {
      const envelope = inspectEnvelope(line);
      if (envelope.cancellationId !== undefined) {
        cancel(envelope.cancellationId);
        return;
      }
      pending.push({ line, arrivedAt, envelope });
    };

    const drainBuffer = (includeTrailing: boolean): void => {
      let newline = buffer.indexOf("\n");
      while (
        newline !== -1 &&
        pending.length + inFlight.size < execution.maximumInFlightRequests
      ) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (utf8ByteLength(line) > RESOLVE_REQUEST_MAXIMUM_BYTES) {
          queueWrite(requestTooLargeResponse());
        } else if (line.trim() !== "") {
          acceptLine(line, bufferedAt ?? execution.now());
        }
        bufferedAt = buffer === "" ? undefined : execution.now();
        newline = buffer.indexOf("\n");
      }
      if (
        includeTrailing &&
        pending.length + inFlight.size < execution.maximumInFlightRequests &&
        newline === -1
      ) {
        if (
          !discardingOversizedFrame &&
          utf8ByteLength(buffer) > RESOLVE_REQUEST_MAXIMUM_BYTES
        ) {
          queueWrite(requestTooLargeResponse());
        } else if (!discardingOversizedFrame && buffer.trim() !== "") {
          acceptLine(buffer, bufferedAt ?? execution.now());
        }
        buffer = "";
        bufferedAt = undefined;
        discardingOversizedFrame = false;
      }
      pump();
    };

    input.setEncoding("utf8");
    input.on("data", (incoming: string) => {
      let chunk = incoming;
      if (discardingOversizedFrame) {
        const boundary = chunk.indexOf("\n");
        if (boundary === -1) return;
        chunk = chunk.slice(boundary + 1);
        discardingOversizedFrame = false;
      }
      if (buffer === "") bufferedAt = execution.now();
      buffer += chunk;
      drainBuffer(false);
      if (
        !buffer.includes("\n") &&
        utf8ByteLength(buffer) > RESOLVE_REQUEST_MAXIMUM_BYTES
      ) {
        buffer = "";
        bufferedAt = undefined;
        discardingOversizedFrame = true;
        queueWrite(requestTooLargeResponse());
      }
    });
    input.once("error", (cause) => {
      if (settled) return;
      settled = true;
      reject(cause);
    });
    input.once("end", () => {
      ended = true;
      drainBuffer(true);
      finishIfDone();
    });
  });
}

function inspectEnvelope(raw: string): MessageEnvelope {
  const parsed = parseJsonRpcMessage(raw);
  if (parsed.kind === "invalid") return {};
  const { id, method, params } = parsed.request;
  if (method !== "notifications/cancelled") {
    return id === undefined ? {} : { id };
  }
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return {};
  }
  const cancellationId = (
    params as Readonly<Record<string, unknown>>
  )["requestId"];
  return isJsonRpcId(cancellationId) ? { cancellationId } : {};
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || typeof value === "number" || value === null;
}

function idKey(id: JsonRpcId): string {
  return JSON.stringify(id);
}

function failureResponse(id: JsonRpcId, cause: unknown): string {
  const error = resolveContextError(toResolveContextErrorCode(cause));
  return formatJsonRpcResult(id, {
    content: [{ type: "text", text: JSON.stringify({ error }) }],
    isError: true,
  });
}

function requestTooLargeResponse(): string {
  return failureResponse(
    null,
    new ResolveContextFailure(
      "invalid_request",
      "MCP request exceeds the public UTF-8 byte limit.",
    ),
  );
}

/** Applies the final wire-size guard before a JSON-RPC frame is committed. */
function boundedMcpResponse(response: string): string {
  try {
    assertContextResolutionPayloadWithinLimit(response);
    return response;
  } catch (cause: unknown) {
    return failureResponse(responseId(response), cause);
  }
}

function responseId(response: string): JsonRpcId {
  try {
    const parsed: unknown = JSON.parse(response);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const id = (parsed as Readonly<Record<string, unknown>>)["id"];
    return isJsonRpcId(id) ? id : null;
  } catch {
    return null;
  }
}

function isErrorResponse(response: string): boolean {
  try {
    const parsed: unknown = JSON.parse(response);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return false;
    }
    const record = parsed as Readonly<Record<string, unknown>>;
    if (Object.hasOwn(record, "error")) return true;
    const result = record["result"];
    return (
      typeof result === "object" &&
      result !== null &&
      !Array.isArray(result) &&
      (result as Readonly<Record<string, unknown>>)["isError"] === true
    );
  } catch {
    return false;
  }
}
