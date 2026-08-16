import type { EmbeddingProfile } from "../domain/embedding-profile.js";

export interface EmbeddingProviderInput {
  readonly key: string;
  readonly text: string;
}

export interface EmbeddingProviderRequest {
  readonly profile: EmbeddingProfile;
  readonly inputs: readonly EmbeddingProviderInput[];
  readonly signal: AbortSignal;
}

export interface EmbeddingProviderOutput {
  readonly key: string;
  readonly vector: readonly number[];
}

export type EmbeddingProviderKind = "local" | "remote" | "test";

/** Outbound port owned by the Ingestion embedding workflow. */
export interface EmbeddingPort {
  readonly providerKind?: EmbeddingProviderKind;
  embed(
    request: EmbeddingProviderRequest,
  ): Promise<readonly EmbeddingProviderOutput[]>;
}

export type EmbeddingProviderFaultCode =
  | "authentication_failed"
  | "embedding_artifact_unavailable"
  | "input_limit_exceeded"
  | "invalid_request"
  | "invalid_response"
  | "provider_unavailable"
  | "rate_limited";

export class EmbeddingProviderFault extends Error {
  constructor(
    readonly code: EmbeddingProviderFaultCode,
    readonly retriable: boolean,
  ) {
    super(`Embedding provider failed: ${code}`);
    this.name = "EmbeddingProviderFault";
  }
}
