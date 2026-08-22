import { isDeepStrictEqual } from "node:util";

import {
  isDocumentRetrievalEmbeddingProfile,
  OpenAiCompatibleEmbeddingAdapter,
  TransformersJsLocalEmbeddingAdapter,
  type EmbeddingPort,
  type EmbeddingProfile,
  type LocalDocumentEmbeddingInferenceResource,
} from "@contextctl/ingestion-indexing";
import {
  isCardSelectionEmbeddingProfile,
  type CardEmbeddingPort,
  type CardSelectionProfile,
} from "@contextctl/selection-delivery";

import type { EmbeddingLayer, EmbeddingExecutionMode } from "./configuration.js";
import type { RemoteEmbeddingBinding } from "./remote-binding.js";

/**
 * How the composition asks for a document embedding provider.
 *
 * A seam rather than a direct constructor call, and the reason is ownership: the
 * adapters belong to their domains, and this file is the composition root, so
 * the root states what it needs and the domain supplies it. Tests inject fakes
 * through the same interface, which is what lets all four layer combinations be
 * exercised before either domain's concrete remote adapter is final.
 *
 * Neither method may wrap the other layer's port. A factory that satisfied
 * `CardEmbeddingPort` by adapting an `EmbeddingPort` would put a translation the
 * daemon owns in the middle of two domains that are supposed to own their own.
 */
export interface DocumentEmbeddingProviderFactory {
  createLocal(input: {
    readonly profile: EmbeddingProfile;
    readonly artifactDirectory: string;
  }): EmbeddingPort;
  createRemote(input: {
    readonly profile: EmbeddingProfile;
    readonly binding: RemoteEmbeddingBinding;
  }): EmbeddingPort;
}

export interface CardEmbeddingProviderFactory {
  createLocal(input: {
    readonly profile: CardSelectionProfile;
    readonly artifactDirectory: string;
  }): CardEmbeddingPort;
  createRemote(input: {
    readonly profile: CardSelectionProfile;
    readonly binding: RemoteEmbeddingBinding;
  }): CardEmbeddingPort;
}

/**
 * An adapter the owning domain has not shipped yet.
 *
 * Thrown rather than substituted. The whole point of the two-layer split is that
 * a Card vector and a document vector come from independently chosen providers,
 * so quietly answering a Card request with a document adapter would produce
 * vectors that are wrong in a way nothing downstream can detect. A named,
 * greppable failure is what makes the rebase step obvious once the domain branch
 * lands.
 */
export class EmbeddingAdapterUnavailableError extends Error {
  constructor(
    readonly layer: EmbeddingLayer,
    readonly mode: EmbeddingExecutionMode,
    readonly owner: string,
  ) {
    super(
      `no ${mode} ${layer} embedding adapter is available; ${owner} owns it`,
    );
    this.name = "EmbeddingAdapterUnavailableError";
  }
}

/**
 * Binds the adapters Ingestion ships today.
 *
 * Both branches construct a provider Ingestion owns and hand it its own profile,
 * so nothing here interprets vector semantics. The remote branch is the only
 * place a credential is unwrapped, and it goes straight onto the header the
 * adapter puts on the wire.
 */
export class IngestionDocumentEmbeddingProviderFactory
  implements DocumentEmbeddingProviderFactory
{
  readonly #localResources: readonly LocalDocumentEmbeddingInferenceResource[];

  constructor(
    localResources: readonly LocalDocumentEmbeddingInferenceResource[] = [],
  ) {
    this.#localResources = localResources;
  }

  createLocal(input: {
    readonly profile: EmbeddingProfile;
    readonly artifactDirectory: string;
  }): EmbeddingPort {
    if (!isDocumentRetrievalEmbeddingProfile(input.profile)) {
      throw new EmbeddingAdapterUnavailableError(
        "document",
        "local",
        "Ingestion",
      );
    }
    const profile = input.profile;
    const resource = this.#localResources.find((candidate) =>
      isDeepStrictEqual(candidate.execution, profile.execution),
    );
    return new TransformersJsLocalEmbeddingAdapter(
      resource === undefined
        ? {
            artifactDirectory: input.artifactDirectory,
            profile,
          }
        : { inferenceResource: resource, profile },
    );
  }

  createRemote(input: {
    readonly profile: EmbeddingProfile;
    readonly binding: RemoteEmbeddingBinding;
  }): EmbeddingPort {
    if (!isDocumentRetrievalEmbeddingProfile(input.profile)) {
      throw new EmbeddingAdapterUnavailableError(
        "document",
        "remote",
        "Ingestion",
      );
    }
    return new OpenAiCompatibleEmbeddingAdapter({
      endpoint: input.binding.endpoint,
      profile: input.profile,
      headers: {
        authorization: `Bearer ${input.binding.credential.reveal()}`,
      },
    });
  }
}

/**
 * Binds the Card adapters, as far as Selection has shipped them.
 *
 * Both branches currently refuse. Selection owns `CardEmbeddingPort` and has not
 * published a provider that implements it directly for either execution mode —
 * the local path in the graph today runs through a translation adapter this
 * package still holds, which is being retired rather than extended, and there is
 * no remote Card adapter at all.
 *
 * Refusing is the correct interim behaviour, not a placeholder. Every other
 * option available here is one of the things the composition is forbidden to do:
 * wrapping Ingestion's port would rebuild the translation being removed, and
 * falling back to the deterministic adapter would put hash vectors in an index
 * whose profile claims a model. A composition that needs Card embedding before
 * Selection ships its adapters injects one through this interface.
 */
export class SelectionCardEmbeddingProviderFactory
  implements CardEmbeddingProviderFactory
{
  createLocal(input: {
    readonly profile: CardSelectionProfile;
    readonly artifactDirectory: string;
  }): CardEmbeddingPort {
    void input;
    throw new EmbeddingAdapterUnavailableError("card", "local", "Selection");
  }

  createRemote(input: {
    readonly profile: CardSelectionProfile;
    readonly binding: RemoteEmbeddingBinding;
  }): CardEmbeddingPort {
    void input;
    throw new EmbeddingAdapterUnavailableError("card", "remote", "Selection");
  }
}

export type EmbeddingModeProfileMismatchCode =
  /** The layer asked for remote and the profile pins a local artifact. */
  | "profile_is_local"
  /** The layer asked for local and the profile names a remote provider. */
  | "profile_is_remote"
  /** The layer asked for remote and the profile has no execution semantics. */
  | "profile_has_no_execution";

/**
 * Configuration and profile disagree about how vectors are made.
 *
 * A refusal rather than a precedence rule. The two values answer different
 * questions — the profile states what a vector means, the configuration states
 * which binding reaches a provider — and when they contradict each other there
 * is no reading that is safe to assume. Preferring the profile would ignore an
 * operator who deliberately moved to a hosted provider; preferring the
 * configuration would publish vectors under a profile that describes a different
 * model.
 */
export class EmbeddingModeProfileMismatchError extends Error {
  constructor(
    readonly layer: EmbeddingLayer,
    readonly mode: EmbeddingExecutionMode,
    readonly code: EmbeddingModeProfileMismatchCode,
    readonly profileId: string,
  ) {
    super(
      `${layer} embedding is configured ${mode} but its profile disagrees: ${code}`,
    );
    this.name = "EmbeddingModeProfileMismatchError";
  }
}

/**
 * How a profile says its vectors are produced.
 *
 * `undefined` means the profile carries no production execution block at all,
 * which is what the deterministic test profiles look like. Distinguished from
 * `local` on purpose: treating "no execution" as local would make a test
 * composition demand an installed artifact.
 */
export function documentProfileExecutionKind(
  profile: EmbeddingProfile,
): EmbeddingExecutionMode | undefined {
  if (!isDocumentRetrievalEmbeddingProfile(profile)) return undefined;
  return profile.execution.kind === "local" ? "local" : "remote";
}

export function cardProfileExecutionKind(
  profile: CardSelectionProfile,
): EmbeddingExecutionMode | undefined {
  if (!isCardSelectionEmbeddingProfile(profile)) return undefined;
  return profile.execution.kind === "local" ? "local" : "remote";
}

/**
 * Refuses a layer whose configured mode contradicts its profile.
 *
 * A profile with no execution semantics is allowed under `local` and refused
 * under `remote`. The asymmetry is deliberate: "local" is also what an
 * unconfigured daemon reports, so a deterministic profile running under it is
 * the ordinary test composition, whereas asking for `remote` is always an
 * explicit act and deserves a profile that actually names a provider.
 */
export function assertModeMatchesExecution(
  layer: EmbeddingLayer,
  mode: EmbeddingExecutionMode,
  execution: EmbeddingExecutionMode | undefined,
  profileId: string,
): void {
  if (execution === undefined) {
    if (mode === "remote") {
      throw new EmbeddingModeProfileMismatchError(
        layer,
        mode,
        "profile_has_no_execution",
        profileId,
      );
    }
    return;
  }
  if (execution === mode) return;
  throw new EmbeddingModeProfileMismatchError(
    layer,
    mode,
    execution === "local" ? "profile_is_local" : "profile_is_remote",
    profileId,
  );
}
