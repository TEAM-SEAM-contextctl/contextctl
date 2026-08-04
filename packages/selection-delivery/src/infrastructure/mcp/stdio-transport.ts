import type { Readable, Writable } from "node:stream";

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
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let buffer = "";
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
          output.write(`${response}\n`);
        }
      });
    };

    // Decoding here rather than per chunk: a chunk boundary can fall inside a
    // multi-byte character, and `setEncoding` carries the partial sequence to
    // the next chunk instead of producing a replacement character.
    input.setEncoding("utf8");

    input.on("data", (chunk: string) => {
      buffer += chunk;

      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        // Blank lines are framing, not messages: answering one with a parse
        // error would turn a peer's stray newline into a protocol failure.
        if (line.trim() !== "") {
          enqueue(line);
        }
        newline = buffer.indexOf("\n");
      }
    });

    input.on("error", reject);

    input.on("end", () => {
      // A final message without a trailing newline is still a message — a
      // writer that closes the stream has framed it as surely as a newline
      // would have.
      if (buffer.trim() !== "") {
        enqueue(buffer);
      }
      buffer = "";
      queue.then(resolve, reject);
    });
  });
}
