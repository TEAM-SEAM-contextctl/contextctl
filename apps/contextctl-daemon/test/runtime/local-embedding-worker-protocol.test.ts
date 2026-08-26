import { once } from "node:events";
import { MessageChannel } from "node:worker_threads";

import { afterEach, describe, expect, it } from "vitest";

import { postLocalEmbeddingWorkerResponse } from "../../src/runtime/local-embedding-worker-protocol.js";

const channels: MessageChannel[] = [];

afterEach(() => {
  for (const channel of channels.splice(0)) {
    channel.port1.close();
    channel.port2.close();
  }
});

describe("local embedding worker protocol", () => {
  it("moves an fp32 embedding buffer to the parent without changing values", async () => {
    const channel = new MessageChannel();
    channels.push(channel);
    const data = new Float32Array([0.125, -0.25, 0.5, 1]);
    const expected = Array.from(data);
    const received = once(channel.port2, "message");

    postLocalEmbeddingWorkerResponse(channel.port1, {
      id: 7,
      status: "embedded",
      dimensions: [1, 4],
      data,
    });

    expect(data.byteLength).toBe(0);
    const [response] = await received;
    expect(response).toMatchObject({
      id: 7,
      status: "embedded",
      dimensions: [1, 4],
    });
    expect(response.data).toBeInstanceOf(Float32Array);
    expect(Array.from(response.data as Float32Array)).toEqual(expected);
  });

  it("does not lower the precision of a plain numeric response", async () => {
    const channel = new MessageChannel();
    channels.push(channel);
    const data = [1 / 3, Number.MIN_VALUE];
    const received = once(channel.port2, "message");

    postLocalEmbeddingWorkerResponse(channel.port1, {
      id: 8,
      status: "embedded",
      dimensions: [1, 2],
      data,
    });

    const [response] = await received;
    expect(response.data).toEqual(data);
    expect(response.data).not.toBeInstanceOf(Float32Array);
  });
});
