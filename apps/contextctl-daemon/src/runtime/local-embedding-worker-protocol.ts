import type {
  EmbeddingProviderFaultCode,
  DocumentRetrievalEmbeddingProfile,
} from "@contextctl/ingestion-indexing";

export interface LocalEmbeddingWorkerBootstrap {
  readonly artifactDirectory: string;
  readonly profile: DocumentRetrievalEmbeddingProfile;
}

export type LocalEmbeddingWorkerRequest =
  | { readonly kind: "ready"; readonly id: number }
  | { readonly kind: "token_count"; readonly id: number; readonly text: string }
  | {
      readonly kind: "token_counts";
      readonly id: number;
      readonly texts: readonly string[];
    }
  | {
      readonly kind: "embed";
      readonly id: number;
      readonly texts: readonly string[];
      readonly pooling: "cls" | "mean";
    };

export type LocalEmbeddingWorkerResponse =
  | {
      readonly id: number;
      readonly status: "ready";
    }
  | {
      readonly id: number;
      readonly status: "token_counted";
      readonly count: number;
    }
  | {
      readonly id: number;
      readonly status: "token_counts_counted";
      readonly counts: readonly number[];
    }
  | {
      readonly id: number;
      readonly status: "embedded";
      readonly dimensions: readonly number[];
      readonly data: readonly number[];
    }
  | {
      readonly id: number;
      readonly status: "failed";
      readonly code: EmbeddingProviderFaultCode;
      readonly retriable: boolean;
    };
