import type {
  CardSelectionEmbeddingProfile,
  CardSelectionProfile,
} from "../../src/domain/card-selection-profile.js";
import { DEFAULT_CARD_ADMISSION_LIMITS } from "../../src/domain/card-selection-profile.js";
import type { ApprovedCard } from "../../src/domain/card-catalog.js";
import {
  CardEmbeddingFault,
  type CardEmbeddingOutput,
  type CardEmbeddingPort,
  type CardEmbeddingRequest,
} from "../../src/ports/card-embedding.js";

/**
 * A four-dimensional test profile.
 *
 * Four rather than 384 because every vector the fixture below produces is a
 * basis vector: the point of these tests is which Cards the semantic path
 * reaches, and a wider space would only make the fixtures harder to read.
 */
export const TEST_CARD_PROFILE: CardSelectionProfile = {
  id: "card-test-v1",
  version: "1",
  model: "concept-axis-v1",
  dimensions: 4,
  distance: "cosine",
  normalization: "l2",
  selectionTextSchemaVersion: 2,
  admissionLimits: DEFAULT_CARD_ADMISSION_LIMITS,
};

/** The same family, stated as a production profile that pins an artifact. */
export const TEST_PRODUCTION_CARD_PROFILE: CardSelectionEmbeddingProfile = {
  ...TEST_CARD_PROFILE,
  id: "card-test-production-v1",
  modelRevision: "rev_0001",
  execution: {
    kind: "local",
    adapter: "transformers-js-onnx",
    adapterVersion: "4.2.0",
    artifactRepository: "example/model-ONNX",
    artifactRevision: "rev_artifact",
    artifactPath: "onnx/model.onnx",
    artifactSha256: "a".repeat(64),
    assetManifestSha256: "b".repeat(64),
    precision: "fp32",
  },
  pooling: "cls",
  cardInputTransformVersion: "card-selection-text-v2",
  queryInputTransformVersion: "card-selection-text-v2",
};

/** One meaning, and the surface forms that express it. */
export interface Concept {
  readonly axis: number;
  readonly terms: readonly string[];
}

/**
 * An embedding port that actually models synonymy, deterministically.
 *
 * `DeterministicCardEmbeddingAdapter` in `src/` hashes its input, so two
 * paraphrases land as far apart as two unrelated sentences. That adapter can
 * prove the hybrid path *runs*; it cannot prove the hybrid path *finds* anything
 * lexical matching would miss, because under a hash there is nothing to find.
 *
 * This one maps a declared list of surface forms onto one basis vector per
 * concept, so "연차" and "휴가" are literally the same point and their cosine is
 * exactly 1. Any text matching no concept lands on a reserved axis of its own,
 * orthogonal to every concept, so its cosine against each of them is exactly 0.
 * That makes both halves of the claim checkable: a Card the query means reaches
 * a similarity of 1, and a Card it does not means reaches 0 rather than
 * "something small".
 *
 * The concepts are stated by the test, which is what keeps this honest — a
 * fixture that inferred synonymy would be testing the fixture's inference.
 */
export class ConceptCardEmbeddingAdapter implements CardEmbeddingPort {
  readonly providerKind = "test" as const;
  /** How many times `embed` was called, so a test can assert "once per resolve". */
  calls = 0;
  /** Every batch's inputs, in order, for the same reason. */
  readonly batches: { readonly key: string; readonly text: string }[][] = [];
  readonly #concepts: readonly Concept[];
  readonly #dimensions: number;

  constructor(concepts: readonly Concept[], dimensions = 4) {
    this.#concepts = concepts;
    this.#dimensions = dimensions;
  }

  async embed(
    request: CardEmbeddingRequest,
  ): Promise<readonly CardEmbeddingOutput[]> {
    request.signal?.throwIfAborted();
    this.calls += 1;
    this.batches.push(
      request.inputs.map((input) => ({ key: input.key, text: input.text })),
    );

    return request.inputs.map((input) => ({
      key: input.key,
      vector: this.#vectorFor(input.text),
    }));
  }

  #vectorFor(text: string): readonly number[] {
    const vector = new Array<number>(this.#dimensions).fill(0);
    const concept = this.#concepts.find((candidate) =>
      candidate.terms.some((term) => text.includes(term)),
    );
    // The last axis is the "no concept" axis, orthogonal to every concept axis.
    vector[concept?.axis ?? this.#dimensions - 1] = 1;
    return vector;
  }
}

/** A port that always fails, for the degradation branches. */
export class FailingCardEmbeddingAdapter implements CardEmbeddingPort {
  readonly providerKind = "test" as const;
  readonly #code: "provider_unavailable" | "embedding_artifact_unavailable";

  constructor(
    code: "provider_unavailable" | "embedding_artifact_unavailable" = "provider_unavailable",
  ) {
    this.#code = code;
  }

  embed(): Promise<readonly CardEmbeddingOutput[]> {
    return Promise.reject(new CardEmbeddingFault(this.#code, true));
  }
}

/**
 * A Card about annual leave, written so that no keyword of its own appears in
 * `SYNONYM_QUERY`.
 *
 * Its Scope is an HTTP one, so a plan built from it needs no executor and the
 * selection can be asserted on its own.
 */
export function createLeavePolicyCard(): ApprovedCard {
  return {
    cardId: "card_leave_policy",
    versionId: "cardv_leave_policy_v1",
    meaning: {
      description: "연차 일수와 신청 절차",
      representativeQuestions: ["연차는 며칠까지 쓸 수 있나요?"],
      aliases: ["annual leave"],
      keywords: ["연차"],
    },
    policy: { sensitive: false, allowedUsage: ["retrieval"] },
    scopes: [
      {
        kind: "http_source",
        reference: { scopeId: "scope_leave_api", scopeVersion: "scopev_0001" },
        connector: "hr.api",
        method: "GET",
        path: "/leave/{employeeId}",
        operationId: "getLeaveBalance",
        parameters: [{ location: "path", name: "employeeId", required: true }],
      },
    ],
  };
}

/**
 * A Card about something else entirely, as the control.
 *
 * It shares no term with the query and belongs to no concept the query names, so
 * it must stay out of the answer under every mode. Without it, "the semantic
 * path admitted a Card" would be indistinguishable from "the semantic path
 * admits everything".
 */
export function createShippingCard(): ApprovedCard {
  return {
    cardId: "card_shipping",
    versionId: "cardv_shipping_v1",
    meaning: {
      description: "배송 추적 번호 조회",
      representativeQuestions: ["운송장 번호는 어디서 보나요?"],
      aliases: ["shipment tracking"],
      keywords: ["배송"],
    },
    policy: { sensitive: false, allowedUsage: ["retrieval"] },
    scopes: [
      {
        kind: "http_source",
        reference: {
          scopeId: "scope_shipping_api",
          scopeVersion: "scopev_0001",
        },
        connector: "logistics.api",
        method: "GET",
        path: "/shipments/{trackingId}",
        operationId: "getShipment",
        parameters: [{ location: "path", name: "trackingId", required: true }],
      },
    ],
  };
}

/**
 * A question about annual leave that says "휴가" where the Card says "연차".
 *
 * Neither of the Card's declared terms — "연차", "annual leave" — occurs in it,
 * so `query-scoring.ts` can only reach its indirect bigram signal, which stays
 * well below the admit threshold. That is exactly the gap the semantic path
 * exists to close.
 */
export const SYNONYM_QUERY = "휴가를 며칠이나 쓸 수 있는지 알려줘";

/** "휴가" and "연차" are one meaning; "배송" is a different one. */
export const LEAVE_CONCEPTS: readonly Concept[] = [
  { axis: 0, terms: ["연차", "휴가"] },
  { axis: 1, terms: ["배송", "운송장"] },
];
