import { createHash } from "node:crypto";

import type {
  EmbeddingPort,
  EmbeddingProviderOutput,
  EmbeddingProviderRequest,
} from "../ports/embedding.js";

/** Network-free adapter for deterministic CI and local integration tests. */
export class DeterministicEmbeddingAdapter implements EmbeddingPort {
  async embed(
    request: EmbeddingProviderRequest,
  ): Promise<readonly EmbeddingProviderOutput[]> {
    request.signal.throwIfAborted();
    return request.inputs.map((input) => ({
      key: input.key,
      vector: deterministicVector(
        `${request.profile.model}\u0000${input.text}`,
        request.profile.dimensions,
      ),
    }));
  }
}

function deterministicVector(seed: string, dimensions: number): number[] {
  const vector: number[] = [];
  for (let counter = 0; vector.length < dimensions; counter += 1) {
    const digest = createHash("sha256")
      .update(seed)
      .update("\u0000")
      .update(String(counter))
      .digest();
    for (const byte of digest) {
      vector.push(byte / 127.5 - 1);
      if (vector.length === dimensions) {
        break;
      }
    }
  }
  const magnitude = Math.sqrt(
    vector.reduce((sum, component) => sum + component * component, 0),
  );
  return magnitude === 0
    ? vector
    : vector.map((component) => component / magnitude);
}
