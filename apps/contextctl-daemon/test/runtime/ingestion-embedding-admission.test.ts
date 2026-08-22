import { describe, expect, it } from "vitest";

import {
  DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
  EmbeddingProviderFault,
  type EmbeddingPort,
  type EmbeddingProviderRequest,
  type EmbeddingProviderOutput,
} from "@contextctl/ingestion-indexing";

import { AdmissionLane } from "../../src/runtime/admission.js";
import { LaneBoundIngestionEmbedding } from "../../src/runtime/lane-bound-ingestion-embedding.js";

function controlledProvider(): {
  readonly provider: EmbeddingPort;
  readonly active: () => number;
  readonly started: () => number;
  readonly releaseAll: () => void;
} {
  let active = 0;
  let started = 0;
  const releases: (() => void)[] = [];
  return {
    provider: {
      providerKind: "local",
      embeddingProfile: DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
      embed: async (
        request: EmbeddingProviderRequest,
      ): Promise<readonly EmbeddingProviderOutput[]> => {
        active += 1;
        started += 1;
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return request.inputs.map((input) => ({
          key: input.key,
          vector: Array.from(
            { length: request.profile.dimensions },
            () => 0,
          ),
        }));
      },
    },
    active: () => active,
    started: () => started,
    releaseAll: () => {
      for (const release of releases.splice(0)) release();
    },
  };
}

function request(key: string): EmbeddingProviderRequest {
  return {
    profile: DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
    inputs: [{ key, text: key }],
    signal: new AbortController().signal,
  };
}

describe("LaneBoundIngestionEmbedding", () => {
  it("starts two provider batches and refuses a third without queueing it", async () => {
    const controlled = controlledProvider();
    const lane = new AdmissionLane("ingestion_embedding", {
      concurrency: 2,
      queueDepth: 0,
    });
    const provider = new LaneBoundIngestionEmbedding(
      controlled.provider,
      lane,
    );

    const first = provider.embed(request("first"));
    const second = provider.embed(request("second"));
    await Promise.resolve();
    expect(controlled.active()).toBe(2);

    await expect(provider.embed(request("third"))).rejects.toEqual(
      expect.objectContaining({
        name: "EmbeddingProviderFault",
        code: "rate_limited",
        retriable: true,
      } satisfies Partial<EmbeddingProviderFault>),
    );
    expect(controlled.started()).toBe(2);
    expect(lane.depth).toMatchObject({ active: 2, queued: 0 });

    controlled.releaseAll();
    await Promise.all([first, second]);
  });

  it("forwards the exact profile metadata used for binding", () => {
    const controlled = controlledProvider();
    const provider = new LaneBoundIngestionEmbedding(
      controlled.provider,
      new AdmissionLane("ingestion_embedding", {
        concurrency: 2,
        queueDepth: 0,
      }),
    );

    expect(provider.providerKind).toBe(controlled.provider.providerKind);
    expect(provider.embeddingProfile).toBe(
      controlled.provider.embeddingProfile,
    );
  });
});
