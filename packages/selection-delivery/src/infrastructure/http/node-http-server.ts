import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

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

/** The response written when the handler itself fails. */
const INTERNAL_ERROR_BODY = JSON.stringify({
  error: { code: "internal_error" },
});

/**
 * Wraps a handler in an HTTP server that is bound to nothing.
 *
 * The caller decides where it listens, and whether it listens at all.
 */
export function createDeliveryHttpServer(handler: DeliveryHttpHandler): Server {
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    // The listener cannot be async: `node:http` ignores a returned promise, and
    // an unhandled rejection inside it would take the process down instead of
    // failing the one request.
    void answer(handler, request, response);
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
): Promise<void> {
  try {
    const body = await readBody(request);
    const answered = await handler({
      // Node populates both for any request it parsed; the fallbacks exist so a
      // missing value routes to a 404 rather than crashing the listener.
      method: request.method ?? "GET",
      path: request.url ?? "/",
      body,
    });

    writeJson(response, answered.status, answered.body);
  } catch {
    writeJson(response, 500, INTERNAL_ERROR_BODY);
  }
}

/**
 * Collects the request body as UTF-8.
 *
 * Buffered rather than decoded incrementally: a multi-byte character can span
 * two chunks, and concatenating decoded strings would corrupt it. Bodies here
 * are one small JSON object, so buffering costs nothing.
 */
function readBody(request: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];

    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", reject);
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
