import type {
  EmbeddingProviderFaultCode,
  EmbeddingProviderInput,
  EmbeddingProviderOutput,
  DocumentRetrievalEmbeddingProfile,
} from "@contextctl/ingestion-indexing";

export interface LocalEmbeddingWorkerBootstrap {
  readonly artifactDirectory: string;
  readonly profile: DocumentRetrievalEmbeddingProfile;
}

export type LocalEmbeddingWorkerRequest =
  | { readonly kind: "ready"; readonly id: number }
  | {
      readonly kind: "embed";
      readonly id: number;
      readonly inputs: readonly EmbeddingProviderInput[];
    };

export type LocalEmbeddingWorkerResponse =
  | {
      readonly id: number;
      readonly status: "ready";
    }
  | {
      readonly id: number;
      readonly status: "embedded";
      readonly outputs: readonly EmbeddingProviderOutput[];
    }
  | {
      readonly id: number;
      readonly status: "failed";
      readonly code: EmbeddingProviderFaultCode;
      readonly retriable: boolean;
    };
