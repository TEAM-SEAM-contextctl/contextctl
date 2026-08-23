import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import {
  ResolveContextFailure,
  resolveContextError,
  resolveContextErrorStatus,
  toResolveContextErrorCode,
} from "../../application/errors.js";
import { assertContextResolutionPayloadWithinLimit } from "../../application/transport-payload.js";
import { RESOLVE_REQUEST_MAXIMUM_BYTES } from "../../domain/transport-policy.js";
import type { DeliveryRequestExecution } from "../transport/request-execution.js";
import type { DeliveryHttpHandler } from "./http-query-handler.js";

/**
 * The `node:http` translation for the query handler.
 *
 * ADR 0005 keeps this package free of a web framework, so the whole adapter is
 * this file: read the body, hand the handler a plain request, write what comes
 * back. It is separate from `http-query-handler.ts` because a socket is the one
 * thing a routing test should not need, and it deliberately stops short of
 * `listen` — choosing a host and a port is a deployment decision, and the
 * daemon is the only Composition Root.
 */

/**
 * The response written when the handler itself fails.
 *
 * The same `ResolveContextError` shape the handler emits, and the same code it
 * uses for a fault nobody diagnosed. A client that only learned to read
 * `error.code` and `error.retriable` must not meet a second, adapter-shaped
 * error object on the one path where the handler never ran.
 */
/**
 * Wraps a handler in an HTTP server that is bound to nothing.
 *
 * The caller decides where it listens, and whether it listens at all.
 */
export function createDeliveryHttpServer(
  handler: DeliveryHttpHandler,
  execution?: DeliveryRequestExecution,
): Server {
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    const arrivedAt = execution?.now();
    // The listener cannot be async: `node:http` ignores a returned promise, and
    // an unhandled rejection inside it would take the process down instead of
    // failing the one request.
    void answer(handler, request, response, execution, arrivedAt);
  });
}

/**
 * Runs one request end to end.
 *
 * `createHttpQueryHandler` answers with a status rather than throwing, so the
 * catch is a backstop for a body that could not be read and for any other
 * handler placed behind this adapter. It reports the same opaque
 * `internal_error` the handler uses, for the same reason: an exception message
 * from this depth describes our infrastructure, not the caller's mistake.
 */
async function answer(
  handler: DeliveryHttpHandler,
  request: IncomingMessage,
  response: ServerResponse,
  execution: DeliveryRequestExecution | undefined,
  arrivedAt: number | undefined,
): Promise<void> {
  const caller = new AbortController();
  const onCallerAbort = (): void => {
    caller.abort(new Error("HTTP caller disconnected"));
  };
  const onResponseClose = (): void => {
    if (!response.writableEnded) onCallerAbort();
  };
  request.once("aborted", onCallerAbort);
  response.once("close", onResponseClose);

  try {
    const operation = async (signal: AbortSignal): Promise<void> => {
      const body = await readBody(request, signal);
      const answered = await handler({
        // Node populates both for any request it parsed; the fallbacks exist so a
        // missing value routes to a 404 rather than crashing the listener.
        method: request.method ?? "GET",
        path: request.url ?? "/",
        body,
      });

      // A handler is allowed to be replaced in tests and in a future adapter,
      // so the socket boundary repeats the final check. Nothing is written
      // until the whole UTF-8 body is known to fit.
      assertContextResolutionPayloadWithinLimit(answered.body);

      if (answered.status >= 200 && answered.status < 300) {
        execution?.assertResponseCanCommit();
      }
      if (!caller.signal.aborted) {
        writeJson(response, answered.status, answered.body);
      }
    };

    if (execution === undefined || arrivedAt === undefined) {
      await operation(caller.signal);
    } else {
      await execution.runRequest(
        { arrivedAt, signal: caller.signal },
        operation,
      );
    }
  } catch (cause: unknown) {
    if (caller.signal.aborted || response.writableEnded || response.destroyed) {
      return;
    }
    const code = toResolveContextErrorCode(cause);
    writeJson(
      response,
      resolveContextErrorStatus(code),
      JSON.stringify({ error: resolveContextError(code) }),
    );
  } finally {
    request.removeListener("aborted", onCallerAbort);
    response.removeListener("close", onResponseClose);
  }
}

/**
 * Collects the request body as UTF-8.
 *
 * Buffered rather than decoded incrementally: a multi-byte character can span
 * two chunks, and concatenating decoded strings would corrupt it. Bodies here
 * are one small JSON object, so buffering costs nothing.
 */
function readBody(
  request: IncomingMessage,
  signal: AbortSignal,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    const declaredLength = request.headers["content-length"];
    if (
      declaredLength !== undefined &&
      /^\d+$/u.test(declaredLength) &&
      Number(declaredLength) > RESOLVE_REQUEST_MAXIMUM_BYTES
    ) {
      reject(
        new ResolveContextFailure(
          "invalid_request",
          "HTTP request body exceeds 64 KiB.",
        ),
      );
      request.resume();
      return;
    }

    const cleanup = (): void => {
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const fail = (cause: unknown): void => {
      cleanup();
      reject(cause);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.byteLength;
      if (size > RESOLVE_REQUEST_MAXIMUM_BYTES) {
        fail(
          new ResolveContextFailure(
            "invalid_request",
            "HTTP request body exceeds 64 KiB.",
          ),
        );
        request.resume();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const onError = (cause: Error): void => fail(cause);
    const onAbort = (): void => {
      // A socket reset may emit `error` after `aborted`. The promise is already
      // settled, but EventEmitter still requires a listener for that late event.
      request.once("error", () => undefined);
      fail(signal.reason ?? new Error("HTTP request cancelled"));
    };

    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: string,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(body);
}
