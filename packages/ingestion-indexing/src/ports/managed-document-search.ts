import type { EmbeddingProfile } from "../domain/embedding-profile.js";
import type { EmbeddingPort } from "./embedding.js";
import type { VectorIndexPort } from "./vector-index.js";

export interface QueryEmbeddingProviderBinding {
  /** Stable ID of a security-domain-scoped provider credential binding. */
  readonly providerId: string;
  readonly provider: EmbeddingPort;
}

/** Fail-closed provider policy for one security domain and exact profile. */
export interface QueryEmbeddingProviderResolver {
  resolve(input: {
    readonly securityDomain: string;
    readonly embeddingProfile: EmbeddingProfile;
  }): QueryEmbeddingProviderBinding | undefined;
}

/** Resolves the connector recorded in a durable Index binding. */
export interface VectorIndexConnectorResolver {
  resolve(connectorId: string): VectorIndexPort | undefined;
}
