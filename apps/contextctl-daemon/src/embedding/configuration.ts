import {
  EmbeddingCredential,
  RemoteEmbeddingBindingError,
  validateRemoteEndpoint,
  type RemoteEmbeddingBinding,
} from "./remote-binding.js";

/**
 * Which of the two embedding layers a value belongs to.
 *
 * Document retrieval and Card selection are separate families: separate
 * profiles, separate vectors, separate indexes and separate rebuild lifecycles.
 * Every configuration value below is therefore read per layer, and this type is
 * what keeps a helper from being reused across the boundary without saying which
 * side it is on.
 */
export type EmbeddingLayer = "document" | "card";

export type EmbeddingExecutionMode = "local" | "remote";

/**
 * One layer's configured execution.
 *
 * A discriminated union rather than a mode plus optional fields, so a remote
 * layer without a binding is not representable. The alternative — `mode:
 * "remote"` beside `binding?: RemoteEmbeddingBinding` — type-checks at every
 * call site and fails at the one that dereferences it.
 */
export type EmbeddingLayerConfiguration =
  | { readonly mode: "local" }
  | { readonly mode: "remote"; readonly binding: RemoteEmbeddingBinding };

/**
 * How both layers were configured.
 *
 * Two independent fields, never collapsed into one setting. The design keeps the
 * families independent precisely so a deployment can send Card text to a hosted
 * provider while document chunks stay on the machine, or the reverse; a single
 * `embeddingMode` would make that unrepresentable and would silently couple two
 * rebuild lifecycles that have nothing to do with each other.
 *
 * All four combinations are legal and all four are assembled by the same code
 * path — there is no branch anywhere that treats `local/local` as the real case
 * and the others as variants.
 */
export interface EmbeddingCompositionConfiguration {
  readonly document: EmbeddingLayerConfiguration;
  readonly card: EmbeddingLayerConfiguration;
}

export const DOCUMENT_EMBEDDING_MODE_VARIABLE =
  "CONTEXTCTL_DOCUMENT_EMBEDDING_MODE";
export const DOCUMENT_EMBEDDING_ENDPOINT_VARIABLE =
  "CONTEXTCTL_DOCUMENT_EMBEDDING_ENDPOINT";
export const DOCUMENT_EMBEDDING_API_KEY_VARIABLE =
  "CONTEXTCTL_DOCUMENT_EMBEDDING_API_KEY";
export const DOCUMENT_EMBEDDING_PROVIDER_ID_VARIABLE =
  "CONTEXTCTL_DOCUMENT_EMBEDDING_PROVIDER_ID";

export const CARD_EMBEDDING_MODE_VARIABLE = "CONTEXTCTL_CARD_EMBEDDING_MODE";
export const CARD_EMBEDDING_ENDPOINT_VARIABLE =
  "CONTEXTCTL_CARD_EMBEDDING_ENDPOINT";
export const CARD_EMBEDDING_API_KEY_VARIABLE =
  "CONTEXTCTL_CARD_EMBEDDING_API_KEY";
export const CARD_EMBEDDING_PROVIDER_ID_VARIABLE =
  "CONTEXTCTL_CARD_EMBEDDING_PROVIDER_ID";

interface LayerVariables {
  readonly mode: string;
  readonly endpoint: string;
  readonly apiKey: string;
  readonly providerId: string;
}

const LAYER_VARIABLES: Readonly<Record<EmbeddingLayer, LayerVariables>> = {
  document: {
    mode: DOCUMENT_EMBEDDING_MODE_VARIABLE,
    endpoint: DOCUMENT_EMBEDDING_ENDPOINT_VARIABLE,
    apiKey: DOCUMENT_EMBEDDING_API_KEY_VARIABLE,
    providerId: DOCUMENT_EMBEDDING_PROVIDER_ID_VARIABLE,
  },
  card: {
    mode: CARD_EMBEDDING_MODE_VARIABLE,
    endpoint: CARD_EMBEDDING_ENDPOINT_VARIABLE,
    apiKey: CARD_EMBEDDING_API_KEY_VARIABLE,
    providerId: CARD_EMBEDDING_PROVIDER_ID_VARIABLE,
  },
};

/** The variable names one layer reads, for status output and diagnostics. */
export function embeddingLayerVariables(layer: EmbeddingLayer): LayerVariables {
  return LAYER_VARIABLES[layer];
}

export class EmbeddingModeError extends Error {
  constructor(
    readonly layer: EmbeddingLayer,
    readonly variable: string,
  ) {
    super(`${layer} embedding mode must be "local" or "remote"`);
    this.name = "EmbeddingModeError";
  }
}

/**
 * Reads both layers out of the environment, independently.
 *
 * `local` is the default for each layer on its own, which is what makes an
 * unconfigured daemon behave exactly as it did before this surface existed. It
 * is a default, not a fallback: a layer that asked for `remote` and could not be
 * bound raises rather than quietly becoming local, because the two produce
 * incomparable vectors and the operator asked for one of them specifically.
 *
 * `securityDomain` is passed in rather than read here. It is a property of the
 * deployment, not of either embedding layer, and both bindings have to be
 * checked against the same one.
 */
export function readEmbeddingCompositionConfiguration(
  environment: Readonly<Partial<Record<string, string>>>,
  securityDomain: string,
): EmbeddingCompositionConfiguration {
  return {
    document: readLayerConfiguration(environment, "document", securityDomain),
    card: readLayerConfiguration(environment, "card", securityDomain),
  };
}

function readLayerConfiguration(
  environment: Readonly<Partial<Record<string, string>>>,
  layer: EmbeddingLayer,
  securityDomain: string,
): EmbeddingLayerConfiguration {
  const variables = LAYER_VARIABLES[layer];
  const mode = readMode(environment[variables.mode], layer, variables.mode);
  if (mode === "local") {
    return { mode: "local" };
  }
  return {
    mode: "remote",
    binding: readRemoteBinding(environment, layer, securityDomain),
  };
}

function readMode(
  raw: string | undefined,
  layer: EmbeddingLayer,
  variable: string,
): EmbeddingExecutionMode {
  if (raw === undefined || raw.trim() === "") {
    return "local";
  }
  const value = raw.trim().toLowerCase();
  if (value === "local" || value === "remote") {
    return value;
  }
  throw new EmbeddingModeError(layer, variable);
}

/**
 * Assembles one layer's remote binding, refusing a partial one.
 *
 * A half-configured remote layer is the failure mode worth designing against:
 * an operator who set an endpoint but whose key never made it into the process
 * would, under a forgiving reader, get a working daemon that had silently stayed
 * local — and would find out when the vectors in their index turned out to be
 * from the wrong model. Each missing piece names its own variable so the fix is
 * a single line of shell.
 */
function readRemoteBinding(
  environment: Readonly<Partial<Record<string, string>>>,
  layer: EmbeddingLayer,
  securityDomain: string,
): RemoteEmbeddingBinding {
  const variables = LAYER_VARIABLES[layer];

  const rawEndpoint = environment[variables.endpoint];
  if (rawEndpoint === undefined || rawEndpoint.trim() === "") {
    throw new RemoteEmbeddingBindingError(
      "endpoint_missing",
      layer,
      variables.endpoint,
    );
  }
  const endpoint = validateRemoteEndpoint(
    rawEndpoint.trim(),
    layer,
    variables.endpoint,
  );

  const rawKey = environment[variables.apiKey];
  if (rawKey === undefined || rawKey.trim() === "") {
    throw new RemoteEmbeddingBindingError(
      "credential_missing",
      layer,
      variables.apiKey,
    );
  }

  // Defaulted from the layer and the domain rather than left required. The id is
  // an allowlist key, and a deployment with one provider per layer would
  // otherwise have to invent a name whose only job is to match itself.
  const rawProviderId = environment[variables.providerId];
  const providerId =
    rawProviderId === undefined || rawProviderId.trim() === ""
      ? `remote.${securityDomain}.${layer}`
      : rawProviderId.trim();

  return {
    providerId,
    endpoint,
    credential: new EmbeddingCredential(rawKey),
    securityDomain,
  };
}

/**
 * Whether this configuration needs no local model at all.
 *
 * Only half the question. A daemon whose *configured* layers are both remote may
 * still have to read local assets, because an approved Card can still reference
 * a Scope published under a local profile and that Scope has to stay searchable.
 * See `requiredLocalEmbeddingProfiles`, which answers the whole question; this
 * one answers the part that can be decided from configuration alone.
 */
export function bothLayersConfiguredRemote(
  configuration: EmbeddingCompositionConfiguration,
): boolean {
  return (
    configuration.document.mode === "remote" &&
    configuration.card.mode === "remote"
  );
}
