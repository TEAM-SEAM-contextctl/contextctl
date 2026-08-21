import { assertProductionEmbeddingProvider } from "../application/document-embedding-provider-binding.js";
import {
  isDocumentRetrievalEmbeddingProfile,
  type EmbeddingProfile,
} from "../domain/embedding-profile.js";
import { canonicalJson } from "../domain/revision-identity.js";
import type { EmbeddingPort } from "../ports/embedding.js";
import type {
  QueryEmbeddingProviderBinding,
  QueryEmbeddingProviderResolver,
  VectorIndexConnectorResolver,
} from "../ports/managed-document-search.js";
import type { VectorIndexPort } from "../ports/vector-index.js";

export interface QueryEmbeddingProviderRegistration {
  readonly securityDomain: string;
  readonly embeddingProfile: EmbeddingProfile;
  readonly providerId: string;
  readonly provider: EmbeddingPort;
}

export class StaticQueryEmbeddingProviderRegistry
  implements QueryEmbeddingProviderResolver
{
  readonly #bindings: ReadonlyMap<string, QueryEmbeddingProviderBinding>;

  constructor(registrations: readonly QueryEmbeddingProviderRegistration[]) {
    const bindings = new Map<string, QueryEmbeddingProviderBinding>();
    const providerDomains = new Map<string, string>();
    const providerInstanceDomains = new Map<EmbeddingPort, string>();
    for (const registration of registrations) {
      if (
        registration.securityDomain.trim() === "" ||
        registration.providerId.trim() === ""
      ) {
        throw new TypeError("query embedding provider registration is invalid");
      }
      if (isDocumentRetrievalEmbeddingProfile(registration.embeddingProfile)) {
        assertProductionEmbeddingProvider(
          registration.embeddingProfile,
          registration.provider,
        );
      }
      const key = providerKey(
        registration.securityDomain,
        registration.embeddingProfile,
      );
      if (bindings.has(key)) {
        throw new TypeError("duplicate query embedding provider registration");
      }
      const providerDomain = providerDomains.get(registration.providerId);
      if (
        providerDomain !== undefined &&
        providerDomain !== registration.securityDomain
      ) {
        throw new TypeError(
          "query embedding provider credential binding crosses security domains",
        );
      }
      providerDomains.set(registration.providerId, registration.securityDomain);
      const providerInstanceDomain = providerInstanceDomains.get(
        registration.provider,
      );
      if (
        providerInstanceDomain !== undefined &&
        providerInstanceDomain !== registration.securityDomain
      ) {
        throw new TypeError(
          "query embedding provider instance crosses security domains",
        );
      }
      providerInstanceDomains.set(
        registration.provider,
        registration.securityDomain,
      );
      bindings.set(key, {
        providerId: registration.providerId,
        provider: registration.provider,
      });
    }
    this.#bindings = bindings;
  }

  resolve(input: {
    readonly securityDomain: string;
    readonly embeddingProfile: EmbeddingProfile;
  }): QueryEmbeddingProviderBinding | undefined {
    return this.#bindings.get(
      providerKey(input.securityDomain, input.embeddingProfile),
    );
  }
}

export interface VectorIndexConnectorRegistration {
  readonly connectorId: string;
  readonly vectorIndex: VectorIndexPort;
}

export class StaticVectorIndexConnectorRegistry
  implements VectorIndexConnectorResolver
{
  readonly #connectors: ReadonlyMap<string, VectorIndexPort>;

  constructor(registrations: readonly VectorIndexConnectorRegistration[]) {
    const connectors = new Map<string, VectorIndexPort>();
    for (const registration of registrations) {
      if (
        registration.connectorId.trim() === "" ||
        connectors.has(registration.connectorId)
      ) {
        throw new TypeError("vector connector registration is invalid");
      }
      connectors.set(registration.connectorId, registration.vectorIndex);
    }
    this.#connectors = connectors;
  }

  resolve(connectorId: string): VectorIndexPort | undefined {
    return this.#connectors.get(connectorId);
  }
}

function providerKey(
  securityDomain: string,
  profile: EmbeddingProfile,
): string {
  return `${securityDomain}\u0000${canonicalJson(profile)}`;
}
