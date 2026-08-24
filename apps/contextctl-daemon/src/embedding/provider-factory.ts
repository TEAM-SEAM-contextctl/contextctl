import { isDeepStrictEqual } from "node:util";

import {
  DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE,
  isDocumentRetrievalEmbeddingProfile,
  OpenAiCompatibleEmbeddingAdapter,
  TransformersJsLocalEmbeddingAdapter,
  type DocumentRetrievalEmbeddingProfile,
  type EmbeddingPort,
  type EmbeddingProfile,
  type LocalDocumentEmbeddingInferenceResource,
  type LocalDocumentEmbeddingExecution,
} from "@contextctl/ingestion-indexing";
import {
  isCardSelectionEmbeddingProfile,
  OpenAiCompatibleCardEmbeddingAdapter,
  TransformersJsLocalCardEmbeddingAdapter,
  type CardEmbeddingPort,
  type CardSelectionProfile,
  type LocalCardEmbeddingInferenceResource,
} from "@contextctl/selection-delivery";

import type { EmbeddingLayer, EmbeddingExecutionMode } from "./configuration.js";
import type { RemoteEmbeddingBinding } from "./remote-binding.js";
import { WorkerThreadLocalEmbeddingInferenceResource } from "../runtime/worker-thread-local-embedding-inference-resource.js";

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
 * A requested adapter/profile combination that the owning domain cannot bind.
 *
 * Thrown rather than substituted. The whole point of the two-layer split is that
 * a Card vector and a document vector come from independently chosen providers,
 * so quietly answering a Card request with a document adapter would produce
 * vectors that are wrong in a way nothing downstream can detect. A named,
 * greppable failure makes an invalid production graph fail during composition.
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

type SharedLocalEmbeddingInferenceResource =
  LocalDocumentEmbeddingInferenceResource & LocalCardEmbeddingInferenceResource;

interface LocalEmbeddingWorkerEntry {
  readonly artifactDirectory: string;
  readonly execution: LocalDocumentEmbeddingExecution;
  readonly worker: WorkerThreadLocalEmbeddingInferenceResource;
}

/**
 * Owns physical local sessions without owning either domain's embedding port.
 *
 * An exact execution match receives the same object. Different artifacts or
 * runtime semantics receive different workers, and no profile is translated
 * into another profile merely to make sharing possible.
 */
export class LocalEmbeddingInferenceResourcePool {
  readonly #injected: readonly LocalDocumentEmbeddingInferenceResource[];
  readonly #workers: LocalEmbeddingWorkerEntry[] = [];
  readonly #providerResources = new WeakMap<object, SharedLocalEmbeddingInferenceResource>();

  constructor(
    injected: readonly LocalDocumentEmbeddingInferenceResource[] = [],
  ) {
    this.#injected = injected;
  }

  acquireDocument(input: {
    readonly profile: EmbeddingProfile;
    readonly artifactDirectory: string;
  }): LocalDocumentEmbeddingInferenceResource {
    if (!isDocumentRetrievalEmbeddingProfile(input.profile)) {
      throw new EmbeddingAdapterUnavailableError("document", "local", "Ingestion");
    }
    return this.#acquire(input.profile, input.artifactDirectory);
  }

  acquireCard(input: {
    readonly profile: CardSelectionProfile;
    readonly artifactDirectory: string;
  }): LocalCardEmbeddingInferenceResource {
    if (
      !isCardSelectionEmbeddingProfile(input.profile) ||
      input.profile.execution.kind !== "local"
    ) {
      throw new EmbeddingAdapterUnavailableError("card", "local", "Selection");
    }
    const injected = this.#findInjected(input.profile.execution);
    if (injected !== undefined) return asCardResource(injected);
    const physicalProfile = DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE;
    if (
      physicalProfile.execution.kind !== "local" ||
      !isDeepStrictEqual(physicalProfile.execution, input.profile.execution)
    ) {
      throw new EmbeddingAdapterUnavailableError("card", "local", "Selection");
    }
    return asCardResource(this.#acquire(physicalProfile, input.artifactDirectory));
  }

  bindProvider(
    provider: object,
    resource: LocalDocumentEmbeddingInferenceResource | LocalCardEmbeddingInferenceResource,
  ): void {
    this.#providerResources.set(provider, resource as SharedLocalEmbeddingInferenceResource);
  }

  resourceFor(provider: object): SharedLocalEmbeddingInferenceResource | undefined {
    return this.#providerResources.get(provider);
  }

  async ready(): Promise<void> {
    await Promise.all(
      this.#workers.map(async ({ worker }) => await worker.ready()),
    );
  }

  async close(): Promise<void> {
    await Promise.all(
      this.#workers.map(async ({ worker }) => await worker.close()),
    );
  }

  #acquire(
    profile: DocumentRetrievalEmbeddingProfile,
    artifactDirectory: string,
  ): LocalDocumentEmbeddingInferenceResource {
    if (profile.execution.kind !== "local") {
      throw new EmbeddingAdapterUnavailableError("document", "local", "Ingestion");
    }
    const injected = this.#findInjected(profile.execution);
    if (injected !== undefined) return injected;
    const existing = this.#workers.find(
      (entry) =>
        entry.artifactDirectory === artifactDirectory &&
        isDeepStrictEqual(entry.execution, profile.execution),
    );
    if (existing !== undefined) return existing.worker;
    const execution = profile.execution;
    const worker = new WorkerThreadLocalEmbeddingInferenceResource({
      artifactDirectory,
      profile,
    });
    this.#workers.push({
      artifactDirectory,
      execution,
      worker,
    });
    return worker;
  }

  #findInjected(execution: unknown): LocalDocumentEmbeddingInferenceResource | undefined {
    return this.#injected.find((candidate) =>
      isDeepStrictEqual(candidate.execution, execution),
    );
  }
}

function asCardResource(
  resource: LocalDocumentEmbeddingInferenceResource,
): LocalCardEmbeddingInferenceResource {
  return resource as SharedLocalEmbeddingInferenceResource;
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
  readonly #resources: LocalEmbeddingInferenceResourcePool;

  constructor(
    resources:
      | LocalEmbeddingInferenceResourcePool
      | readonly LocalDocumentEmbeddingInferenceResource[] = [],
  ) {
    this.#resources =
      resources instanceof LocalEmbeddingInferenceResourcePool
        ? resources
        : new LocalEmbeddingInferenceResourcePool(resources);
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
    const resource = this.#resources.acquireDocument(input);
    const provider = new TransformersJsLocalEmbeddingAdapter({
      inferenceResource: resource,
      profile: input.profile,
    });
    this.#resources.bindProvider(provider, resource);
    return provider;
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

  /** Loads every local session before ingress opens. */
  async ready(): Promise<void> {
    await this.#resources.ready();
  }

  /** Terminates the persistent execution workers during daemon shutdown. */
  async close(): Promise<void> {
    await this.#resources.close();
  }
}

/**
 * Binds the Card adapters Selection owns and exports.
 *
 * Both branches construct a provider Selection owns and bind its own profile.
 * A matching local execution may share the daemon-owned physical inference
 * resource with Ingestion, but no domain port wraps or translates the other.
 */
export class SelectionCardEmbeddingProviderFactory
  implements CardEmbeddingProviderFactory
{
  readonly #resources: LocalEmbeddingInferenceResourcePool;

  constructor(resources = new LocalEmbeddingInferenceResourcePool()) {
    this.#resources = resources;
  }

  createLocal(input: {
    readonly profile: CardSelectionProfile;
    readonly artifactDirectory: string;
  }): CardEmbeddingPort {
    if (
      !isCardSelectionEmbeddingProfile(input.profile) ||
      input.profile.execution.kind !== "local"
    ) {
      throw new EmbeddingAdapterUnavailableError("card", "local", "Selection");
    }
    const resource = this.#resources.acquireCard(input);
    const provider = new TransformersJsLocalCardEmbeddingAdapter({
      inferenceResource: resource,
      profile: input.profile,
    });
    this.#resources.bindProvider(provider, resource);
    return provider;
  }

  createRemote(input: {
    readonly profile: CardSelectionProfile;
    readonly binding: RemoteEmbeddingBinding;
  }): CardEmbeddingPort {
    if (
      !isCardSelectionEmbeddingProfile(input.profile) ||
      input.profile.execution.kind !== "remote"
    ) {
      throw new EmbeddingAdapterUnavailableError("card", "remote", "Selection");
    }
    return new OpenAiCompatibleCardEmbeddingAdapter({
      endpoint: input.binding.endpoint,
      profile: input.profile,
      headers: {
        authorization: `Bearer ${input.binding.credential.reveal()}`,
      },
    });
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
