import type {
  EmbeddingProviderFaultCode,
  DocumentRetrievalEmbeddingProfile,
} from "@contextctl/ingestion-indexing";
import type { TransferListItem } from "node:worker_threads";

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
      readonly data: readonly number[] | Float32Array;
    }
  | {
      readonly id: number;
      readonly status: "failed";
      readonly code: EmbeddingProviderFaultCode;
      readonly retriable: boolean;
    };

interface LocalEmbeddingWorkerResponsePort {
  postMessage(
    response: LocalEmbeddingWorkerResponse,
    transferList?: readonly TransferListItem[],
  ): void;
}

/**
 * Posts fp32 output by moving its buffer instead of cloning every component.
 *
 * A successful call detaches the sender's buffer immediately. The worker must
 * not read, cache or pool it afterwards. This remains true when the parent has
 * already cancelled its request: the finished native inference is posted once,
 * the parent drops the unmatched response, and neither side reuses the buffer.
 * Plain numeric arrays are intentionally cloned so remote or non-fp32 values
 * are never rounded to fit this local fast path.
 */
export function postLocalEmbeddingWorkerResponse(
  port: LocalEmbeddingWorkerResponsePort,
  response: LocalEmbeddingWorkerResponse,
): void {
  if (
    response.status === "embedded" &&
    response.data instanceof Float32Array &&
    response.data.buffer instanceof ArrayBuffer
  ) {
    port.postMessage(response, [response.data.buffer]);
    return;
  }
  port.postMessage(response);
}
