import {
  assertProductionEmbeddingProvider,
  EmbeddingProviderFault,
  isDocumentRetrievalEmbeddingProfile,
  type EmbeddingPort,
  type EmbeddingProfile,
  type QueryEmbeddingProviderRegistration,
} from "@contextctl/ingestion-indexing";
import {
  assertCardEmbeddingProviderKind,
  isCardSelectionEmbeddingProfile,
  type CardEmbeddingPort,
  type CardSelectionProfile,
} from "@contextctl/selection-delivery";

import {
  describeRemoteBinding,
  type RemoteEmbeddingBindingReport,
} from "./remote-binding.js";
import {
  embeddingLayerVariables,
  type EmbeddingExecutionMode,
  type EmbeddingLayer,
  type EmbeddingLayerConfiguration,
} from "./configuration.js";
import {
  assertModeMatchesExecution,
  cardProfileExecutionKind,
  documentProfileExecutionKind,
  type CardEmbeddingProviderFactory,
  type DocumentEmbeddingProviderFactory,
} from "./provider-factory.js";

export const EMBEDDING_ASSET_DIRECTORY_VARIABLE =
  "CONTEXTCTL_EMBEDDING_ASSET_DIRECTORY";

/**
 * A reachable remote profile with no configured binding to reach it.
 *
 * The only composition failure that needs a code of its own. Missing local
 * assets already have one the design assigned — `embedding_artifact_unavailable`
 * — and reporting them as something else would break the closed-failure contract
 * every other layer matches on.
 */
export type EmbeddingCompositionProblemCode = "remote_binding_missing";

/**
 * A binding the daemon is on the hook for and cannot produce.
 *
 * Closed failure, never a substitution. An index published under one profile can
 * only be searched with query vectors from that same profile, so a composition
 * that quietly bound something else would return results computed in a different
 * vector space and report them as ordinary hits.
 */
export class EmbeddingCompositionError extends Error {
  constructor(
    readonly code: EmbeddingCompositionProblemCode,
    readonly layer: EmbeddingLayer,
    readonly profileId: string,
    /** The variable an operator should set. Never a value. */
    readonly variable: string,
  ) {
    super(
      `${layer} embedding cannot be composed for profile ${profileId}: ${code}`,
    );
    this.name = "EmbeddingCompositionError";
  }
}

/** One layer as an operator-facing summary. Carries no credential. */
export interface EmbeddingLayerReport {
  readonly layer: EmbeddingLayer;
  readonly mode: EmbeddingExecutionMode;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly remote?: RemoteEmbeddingBindingReport;
}

export interface DocumentEmbeddingCompositionInput {
  readonly configuration: EmbeddingLayerConfiguration;
  /** The profile the publish path writes under right now. */
  readonly currentProfile: EmbeddingProfile;
  /**
   * Older profiles an approved Card still reaches, if any.
   *
   * Restored so a query against an index published under one of them can still
   * resolve a provider. The registry matches on the exact profile, so an
   * unregistered older profile is not a slow query — it is a closed failure.
   */
  readonly reachableProfiles: readonly EmbeddingProfile[];
  readonly securityDomain: string;
  readonly artifactDirectory?: string | undefined;
  readonly factory: DocumentEmbeddingProviderFactory;
  /**
   * A caller-supplied provider, bypassing the factory entirely.
   *
   * The only way a provider for a profile with no production execution
   * semantics reaches the graph, since no factory branch can build one.
   */
  readonly providerOverride?: EmbeddingPort | undefined;
}

export interface DocumentEmbeddingComposition {
  /** The provider the publish path writes with. */
  readonly provider: EmbeddingPort;
  /** One registration per required profile, current one first. */
  readonly registrations: readonly QueryEmbeddingProviderRegistration[];
  readonly report: EmbeddingLayerReport;
  /** Profiles bound only because something still reaches them. */
  readonly restoredProfiles: readonly string[];
}

export interface CardEmbeddingCompositionInput {
  readonly configuration: EmbeddingLayerConfiguration;
  readonly profile: CardSelectionProfile;
  readonly artifactDirectory?: string | undefined;
  readonly factory: CardEmbeddingProviderFactory;
  readonly providerOverride?: CardEmbeddingPort | undefined;
}

export interface CardEmbeddingComposition {
  readonly provider: CardEmbeddingPort;
  readonly report: EmbeddingLayerReport;
}

/**
 * Builds the document layer.
 *
 * Deliberately a separate function from the Card one, taking a separate
 * configuration and returning a separate result. Nothing in either reads the
 * other, which is what makes all four combinations one code path rather than
 * four: the layer does not know, and cannot ask, how the other was bound.
 */
export function composeDocumentEmbedding(
  input: DocumentEmbeddingCompositionInput,
): DocumentEmbeddingComposition {
  const { configuration, currentProfile } = input;
  assertModeMatchesExecution(
    "document",
    configuration.mode,
    documentProfileExecutionKind(currentProfile),
    currentProfile.id,
  );

  const provider = buildDocumentProvider(input, currentProfile, true);
  const registrations: QueryEmbeddingProviderRegistration[] = [
    {
      securityDomain: input.securityDomain,
      embeddingProfile: currentProfile,
      providerId: documentProviderId(configuration, input.securityDomain, currentProfile),
      provider,
    },
  ];

  const restoredProfiles: string[] = [];
  for (const profile of input.reachableProfiles) {
    if (
      profile.id === currentProfile.id &&
      profile.version === currentProfile.version
    ) {
      continue;
    }
    registrations.push({
      securityDomain: input.securityDomain,
      embeddingProfile: profile,
      providerId: documentProviderId(configuration, input.securityDomain, profile),
      provider: buildDocumentProvider(input, profile, false),
    });
    restoredProfiles.push(`${profile.id} ${profile.version}`);
  }

  return {
    provider,
    registrations,
    report: layerReport(
      "document",
      configuration,
      currentProfile.id,
      currentProfile.version,
    ),
    restoredProfiles,
  };
}

/**
 * Builds one document provider, for the current profile or a restored one.
 *
 * A profile's own execution kind decides how it is reached, not the configured
 * mode. The two agree for the current profile — `assertModeMatchesExecution`
 * refused them otherwise — but a restored profile is whatever it was published
 * under, and a local one keeps needing its artifact after the layer has moved to
 * a hosted provider.
 *
 * A binding is not part of vector semantics, so one configured endpoint may
 * serve every remote profile a deployment ever published under. What it cannot
 * do is serve a local one.
 */
function buildDocumentProvider(
  input: DocumentEmbeddingCompositionInput,
  profile: EmbeddingProfile,
  isCurrent: boolean,
): EmbeddingPort {
  const execution = documentProfileExecutionKind(profile);
  if (execution === undefined) {
    if (input.providerOverride !== undefined) return input.providerOverride;
    throw new EmbeddingCompositionError(
      "remote_binding_missing",
      "document",
      profile.id,
      embeddingLayerVariables("document").mode,
    );
  }
  if (isCurrent && input.providerOverride !== undefined) {
    // Checked, not trusted. A production profile declares how its vectors were
    // made, and a supplied provider that reports a different kind would produce
    // vectors the profile misdescribes — the deterministic adapter reports
    // `test` and is refused here, which is what keeps it from becoming an
    // operating fallback by way of an injected option.
    if (isDocumentRetrievalEmbeddingProfile(profile)) {
      assertProductionEmbeddingProvider(profile, input.providerOverride);
    }
    return input.providerOverride;
  }
  if (execution === "remote") {
    const layer = input.configuration;
    if (layer.mode !== "remote") {
      throw new EmbeddingCompositionError(
        "remote_binding_missing",
        "document",
        profile.id,
        embeddingLayerVariables("document").endpoint,
      );
    }
    return input.factory.createRemote({ profile, binding: layer.binding });
  }
  return input.factory.createLocal({
    profile,
    artifactDirectory: requireArtifactDirectory(input.artifactDirectory),
  });
}

/** Builds the Card layer, reading nothing about how the document layer was bound. */
export function composeCardEmbedding(
  input: CardEmbeddingCompositionInput,
): CardEmbeddingComposition {
  const { configuration, profile } = input;
  assertModeMatchesExecution(
    "card",
    configuration.mode,
    cardProfileExecutionKind(profile),
    profile.id,
  );

  if (input.providerOverride !== undefined) {
    // Same check as the document layer, for the same reason: a production Card
    // profile refuses a provider whose kind does not match, so a deterministic
    // adapter cannot reach a Card index whose profile claims a model.
    if (isCardSelectionEmbeddingProfile(profile)) {
      assertCardEmbeddingProviderKind(
        profile,
        input.providerOverride,
        profile.execution.kind,
      );
    }
    return {
      provider: input.providerOverride,
      report: layerReport("card", configuration, profile.id, profile.version),
    };
  }

  const provider =
    configuration.mode === "remote"
      ? input.factory.createRemote({ profile, binding: configuration.binding })
      : input.factory.createLocal({
          profile,
          artifactDirectory: requireArtifactDirectory(input.artifactDirectory),
        });

  return {
    provider,
    report: layerReport("card", configuration, profile.id, profile.version),
  };
}

/**
 * The artifact directory, or a refusal naming the variable that supplies it.
 *
 * Called only on paths that actually load a model, which is what keeps a fully
 * remote deployment from being asked for a directory it has no reason to have.
 */
function requireArtifactDirectory(directory: string | undefined): string {
  if (directory === undefined) {
    // The design's own code for an artifact that is not ready, and the one the
    // process entry point matches on to print installation guidance. A new code
    // here would be a second name for a failure the rest of the system already
    // recognises.
    throw new EmbeddingProviderFault("embedding_artifact_unavailable", false);
  }
  return directory;
}

/**
 * The allowlist key a document profile registers under.
 *
 * A remote layer uses the operator's provider id, because that is the value a
 * security domain's allowlist is written against. A local layer keeps the
 * existing `local.<domain>.<profile>` shape so a publish path composed from
 * Ingestion's own helper registers the same identity rather than a second one
 * that differs only in its label.
 */
function documentProviderId(
  configuration: EmbeddingLayerConfiguration,
  securityDomain: string,
  profile: EmbeddingProfile,
): string {
  if (
    configuration.mode === "remote" &&
    documentProfileExecutionKind(profile) === "remote"
  ) {
    return configuration.binding.providerId;
  }
  return `local.${securityDomain}.${profile.id}`;
}

function layerReport(
  layer: EmbeddingLayer,
  configuration: EmbeddingLayerConfiguration,
  profileId: string,
  profileVersion: string,
): EmbeddingLayerReport {
  if (configuration.mode === "local") {
    return { layer, mode: "local", profileId, profileVersion };
  }
  return {
    layer,
    mode: "remote",
    profileId,
    profileVersion,
    remote: describeRemoteBinding(
      configuration.binding,
      embeddingLayerVariables(layer).apiKey,
    ),
  };
}
