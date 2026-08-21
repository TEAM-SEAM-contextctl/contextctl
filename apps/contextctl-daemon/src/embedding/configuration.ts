import { isAbsolute } from "node:path";

import {
  assertValidEmbeddingProfile,
  DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
  isDocumentRetrievalEmbeddingProfile,
  type DocumentRetrievalEmbeddingProfile,
  type EmbeddingProfile,
} from "@contextctl/ingestion-indexing";
import {
  assertValidCardSelectionProfile,
  CARD_SELECTION_EMBEDDING_PROFILE,
  isCardSelectionEmbeddingProfile,
  type CardSelectionEmbeddingProfile,
} from "@contextctl/selection-delivery";

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
  /** Exact bindings retained for document profiles that are still reachable. */
  readonly retainedDocumentBindings?: readonly DocumentProfileBinding[];
}

export type DocumentProfileBinding =
  | {
      readonly profileId: string;
      readonly profileVersion: string;
      readonly mode: "local";
      readonly artifactDirectory: string;
    }
  | {
      readonly profileId: string;
      readonly profileVersion: string;
      readonly mode: "remote";
      readonly binding: RemoteEmbeddingBinding;
    };

export const DOCUMENT_EMBEDDING_MODE_VARIABLE =
  "CONTEXTCTL_DOCUMENT_EMBEDDING_MODE";
export const DOCUMENT_EMBEDDING_ENDPOINT_VARIABLE =
  "CONTEXTCTL_DOCUMENT_EMBEDDING_ENDPOINT";
export const DOCUMENT_EMBEDDING_API_KEY_VARIABLE =
  "CONTEXTCTL_DOCUMENT_EMBEDDING_API_KEY";
export const DOCUMENT_EMBEDDING_PROVIDER_ID_VARIABLE =
  "CONTEXTCTL_DOCUMENT_EMBEDDING_PROVIDER_ID";
export const DOCUMENT_EMBEDDING_PROFILE_VARIABLE =
  "CONTEXTCTL_DOCUMENT_EMBEDDING_PROFILE";

export const CARD_EMBEDDING_MODE_VARIABLE = "CONTEXTCTL_CARD_EMBEDDING_MODE";
export const CARD_EMBEDDING_ENDPOINT_VARIABLE =
  "CONTEXTCTL_CARD_EMBEDDING_ENDPOINT";
export const CARD_EMBEDDING_API_KEY_VARIABLE =
  "CONTEXTCTL_CARD_EMBEDDING_API_KEY";
export const CARD_EMBEDDING_PROVIDER_ID_VARIABLE =
  "CONTEXTCTL_CARD_EMBEDDING_PROVIDER_ID";
export const CARD_EMBEDDING_PROFILE_VARIABLE =
  "CONTEXTCTL_CARD_EMBEDDING_PROFILE";
export const DOCUMENT_RETAINED_EMBEDDING_BINDINGS_VARIABLE =
  "CONTEXTCTL_DOCUMENT_RETAINED_EMBEDDING_BINDINGS";

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

export type EmbeddingProfileConfigurationProblemCode =
  | "profile_missing"
  | "profile_invalid"
  | "profile_mode_mismatch"
  | "retained_binding_missing"
  | "retained_binding_mode_mismatch";

/** A profile setting that cannot safely identify a vector family. */
export class EmbeddingProfileConfigurationError extends Error {
  constructor(
    readonly code: EmbeddingProfileConfigurationProblemCode,
    readonly layer: EmbeddingLayer,
    readonly variable: string,
  ) {
    super(`${layer} embedding profile is invalid: ${code}`);
    this.name = "EmbeddingProfileConfigurationError";
  }
}

export interface ActiveEmbeddingProfiles {
  readonly document: DocumentRetrievalEmbeddingProfile;
  readonly card: CardSelectionEmbeddingProfile;
}

/**
 * Reads the exact vector family each layer will produce.
 *
 * Local profiles have domain-owned defaults. Remote execution has no safe
 * default: an endpoint may front any model, width or revision, so the complete
 * domain profile must be supplied and validated rather than inferred from the
 * URL or copied from the local model.
 */
export function readActiveEmbeddingProfiles(
  environment: Readonly<Partial<Record<string, string>>>,
  configuration: EmbeddingCompositionConfiguration,
): ActiveEmbeddingProfiles {
  return {
    document: readDocumentProfile(environment, configuration.document.mode),
    card: readCardProfile(environment, configuration.card.mode),
  };
}

/** Ensures every older document vector family has its own exact binding. */
export function assertRequiredDocumentProfileBindings(
  configuration: EmbeddingCompositionConfiguration,
  profiles: readonly EmbeddingProfile[],
): void {
  const current = profiles[0];
  for (const profile of profiles) {
    if (profile.id === current?.id && profile.version === current.version) {
      continue;
    }
    const retained = (configuration.retainedDocumentBindings ?? []).find(
      (binding) =>
        binding.profileId === profile.id &&
        binding.profileVersion === profile.version,
    );
    if (retained === undefined) {
      throw new EmbeddingProfileConfigurationError(
        "retained_binding_missing",
        "document",
        DOCUMENT_RETAINED_EMBEDDING_BINDINGS_VARIABLE,
      );
    }
    const execution = isDocumentRetrievalEmbeddingProfile(profile)
      ? profile.execution.kind
      : undefined;
    if (execution === undefined || execution !== retained.mode) {
      throw new EmbeddingProfileConfigurationError(
        "retained_binding_mode_mismatch",
        "document",
        DOCUMENT_RETAINED_EMBEDDING_BINDINGS_VARIABLE,
      );
    }
  }
}

function readDocumentProfile(
  environment: Readonly<Partial<Record<string, string>>>,
  mode: EmbeddingExecutionMode,
): DocumentRetrievalEmbeddingProfile {
  const raw = environment[DOCUMENT_EMBEDDING_PROFILE_VARIABLE];
  if (raw === undefined || raw.trim() === "") {
    if (mode === "local") return DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE;
    throw new EmbeddingProfileConfigurationError(
      "profile_missing",
      "document",
      DOCUMENT_EMBEDDING_PROFILE_VARIABLE,
    );
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isExactDocumentProfile(parsed)) throw new TypeError();
    const profile = parsed;
    assertValidEmbeddingProfile(profile);
    if (!isDocumentRetrievalEmbeddingProfile(profile)) throw new TypeError();
    if (profile.execution.kind !== mode) {
      throw new EmbeddingProfileConfigurationError(
        "profile_mode_mismatch",
        "document",
        DOCUMENT_EMBEDDING_PROFILE_VARIABLE,
      );
    }
    return profile;
  } catch (error) {
    if (error instanceof EmbeddingProfileConfigurationError) throw error;
    throw new EmbeddingProfileConfigurationError(
      "profile_invalid",
      "document",
      DOCUMENT_EMBEDDING_PROFILE_VARIABLE,
    );
  }
}

function readCardProfile(
  environment: Readonly<Partial<Record<string, string>>>,
  mode: EmbeddingExecutionMode,
): CardSelectionEmbeddingProfile {
  const raw = environment[CARD_EMBEDDING_PROFILE_VARIABLE];
  if (raw === undefined || raw.trim() === "") {
    if (mode === "local") return CARD_SELECTION_EMBEDDING_PROFILE;
    throw new EmbeddingProfileConfigurationError(
      "profile_missing",
      "card",
      CARD_EMBEDDING_PROFILE_VARIABLE,
    );
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isExactCardProfile(parsed)) throw new TypeError();
    const profile = parsed;
    assertValidCardSelectionProfile(profile);
    if (!isCardSelectionEmbeddingProfile(profile)) throw new TypeError();
    if (profile.execution.kind !== mode) {
      throw new EmbeddingProfileConfigurationError(
        "profile_mode_mismatch",
        "card",
        CARD_EMBEDDING_PROFILE_VARIABLE,
      );
    }
    return profile;
  } catch (error) {
    if (error instanceof EmbeddingProfileConfigurationError) throw error;
    throw new EmbeddingProfileConfigurationError(
      "profile_invalid",
      "card",
      CARD_EMBEDDING_PROFILE_VARIABLE,
    );
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
    retainedDocumentBindings: readRetainedDocumentBindings(
      environment,
      securityDomain,
    ),
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
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(providerId)) {
    throw new RemoteEmbeddingBindingError(
      "provider_id_invalid",
      layer,
      variables.providerId,
    );
  }

  return {
    providerId,
    endpoint,
    credential: new EmbeddingCredential(rawKey),
    credentialSource: variables.apiKey,
    securityDomain,
  };
}

/**
 * Reads exact bindings for older document profiles.
 *
 * The JSON contains no secret value. A remote entry names the environment
 * variable holding its credential, which lets key rotation remain a runtime
 * concern while preserving the exact profile-to-provider association.
 */
function readRetainedDocumentBindings(
  environment: Readonly<Partial<Record<string, string>>>,
  securityDomain: string,
): readonly DocumentProfileBinding[] {
  const raw = environment[DOCUMENT_RETAINED_EMBEDDING_BINDINGS_VARIABLE];
  if (raw === undefined || raw.trim() === "") return [];
  let entries: unknown;
  try {
    entries = JSON.parse(raw);
  } catch {
    throw new RemoteEmbeddingBindingError(
      "retained_binding_invalid",
      "document",
      DOCUMENT_RETAINED_EMBEDDING_BINDINGS_VARIABLE,
    );
  }
  if (!Array.isArray(entries) || entries.length > 64) {
    throw new RemoteEmbeddingBindingError(
      "retained_binding_invalid",
      "document",
      DOCUMENT_RETAINED_EMBEDDING_BINDINGS_VARIABLE,
    );
  }

  const bindings = entries.map((entry) =>
    parseRetainedDocumentBinding(entry, environment, securityDomain),
  );
  const identities = new Set<string>();
  for (const binding of bindings) {
    const identity = `${binding.profileId}\u0000${binding.profileVersion}`;
    if (identities.has(identity)) {
      throw new RemoteEmbeddingBindingError(
        "retained_binding_duplicate",
        "document",
        DOCUMENT_RETAINED_EMBEDDING_BINDINGS_VARIABLE,
      );
    }
    identities.add(identity);
  }
  return bindings;
}

function parseRetainedDocumentBinding(
  value: unknown,
  environment: Readonly<Partial<Record<string, string>>>,
  securityDomain: string,
): DocumentProfileBinding {
  if (!isRecord(value)) return invalidRetainedBinding();
  const profileId = nonEmptyString(value.profileId);
  const profileVersion = nonEmptyString(value.profileVersion);
  const mode = value.mode;
  if (profileId === undefined || profileVersion === undefined) {
    return invalidRetainedBinding();
  }
  if (mode === "local") {
    if (
      !hasExactKeys(value, [
        "profileId",
        "profileVersion",
        "mode",
        "artifactDirectory",
      ] as const)
    ) {
      return invalidRetainedBinding();
    }
    const artifactDirectory = nonEmptyString(value.artifactDirectory);
    if (artifactDirectory === undefined || !isAbsolute(artifactDirectory)) {
      return invalidRetainedBinding();
    }
    return { profileId, profileVersion, mode, artifactDirectory };
  }
  if (mode !== "remote") return invalidRetainedBinding();
  if (
    !hasExactKeys(value, [
      "profileId",
      "profileVersion",
      "mode",
      "endpoint",
      "providerId",
      "credentialVariable",
    ] as const)
  ) {
    return invalidRetainedBinding();
  }

  const endpointRaw = nonEmptyString(value.endpoint);
  const providerId = nonEmptyString(value.providerId);
  const credentialVariable = nonEmptyString(value.credentialVariable);
  if (
    endpointRaw === undefined ||
    providerId === undefined ||
    credentialVariable === undefined ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(credentialVariable) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(providerId)
  ) {
    return invalidRetainedBinding();
  }
  const credential = environment[credentialVariable];
  if (credential === undefined || credential.trim() === "") {
    throw new RemoteEmbeddingBindingError(
      "credential_missing",
      "document",
      credentialVariable,
    );
  }
  return {
    profileId,
    profileVersion,
    mode,
    binding: {
      providerId,
      endpoint: validateRemoteEndpoint(
        endpointRaw,
        "document",
        DOCUMENT_RETAINED_EMBEDDING_BINDINGS_VARIABLE,
      ),
      credential: new EmbeddingCredential(credential),
      credentialSource: credentialVariable,
      securityDomain,
    },
  };
}

function invalidRetainedBinding(): never {
  throw new RemoteEmbeddingBindingError(
    "retained_binding_invalid",
    "document",
    DOCUMENT_RETAINED_EMBEDDING_BINDINGS_VARIABLE,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

const DOCUMENT_PROFILE_KEYS = [
  "id",
  "version",
  "model",
  "modelRevision",
  "execution",
  "dimensions",
  "pooling",
  "normalization",
  "distance",
  "documentInputTransformVersion",
  "queryInputTransformVersion",
  "modelMaxTokens",
  "admissionLimit",
  "maxInputTokens",
  "textMeasureProfileVersion",
] as const;

const LOCAL_EXECUTION_KEYS = [
  "kind",
  "adapter",
  "adapterVersion",
  "artifactRepository",
  "artifactRevision",
  "artifactPath",
  "artifactSha256",
  "assetManifestSha256",
  "precision",
] as const;

const REMOTE_EXECUTION_KEYS = [
  "kind",
  "adapter",
  "adapterVersion",
  "model",
] as const;

const CARD_PROFILE_KEYS = [
  "id",
  "version",
  "model",
  "modelRevision",
  "execution",
  "dimensions",
  "pooling",
  "normalization",
  "distance",
  "selectionTextSchemaVersion",
  "cardInputTransformVersion",
  "queryInputTransformVersion",
  "admissionLimits",
] as const;

function isExactDocumentProfile(
  value: unknown,
): value is DocumentRetrievalEmbeddingProfile {
  if (!isRecord(value) || !hasExactKeys(value, DOCUMENT_PROFILE_KEYS)) {
    return false;
  }
  if (
    !isRecord(value.admissionLimit) ||
    !hasExactKeys(value.admissionLimit, [
      "textMeasureProfileVersion",
      "maxUnits",
    ] as const) ||
    !isRecord(value.execution)
  ) {
    return false;
  }
  return value.execution.kind === "local"
    ? hasExactKeys(value.execution, LOCAL_EXECUTION_KEYS)
    : value.execution.kind === "remote" &&
        hasExactKeys(value.execution, REMOTE_EXECUTION_KEYS);
}

function isExactCardProfile(
  value: unknown,
): value is CardSelectionEmbeddingProfile {
  if (!isRecord(value) || !hasExactKeys(value, CARD_PROFILE_KEYS)) {
    return false;
  }
  if (
    !isRecord(value.admissionLimits) ||
    !hasExactKeys(value.admissionLimits, [
      "textMeasureProfileVersion",
      "maxCardUnits",
      "maxQueryUnits",
    ] as const) ||
    !isRecord(value.execution)
  ) {
    return false;
  }
  return value.execution.kind === "local"
    ? hasExactKeys(value.execution, LOCAL_EXECUTION_KEYS)
    : value.execution.kind === "remote" &&
        hasExactKeys(value.execution, REMOTE_EXECUTION_KEYS);
}

function hasExactKeys<const Keys extends readonly string[]>(
  value: Record<string, unknown>,
  keys: Keys,
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
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
