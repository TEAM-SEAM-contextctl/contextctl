import {
  assertSourceActive,
  beginSourceObservation,
  completeSourceObservation,
  createSourceDiagnostic,
  createKnowledgeSource,
  disableSource,
  failSourceObservation,
  KnowledgeSourceTransitionError,
  KnowledgeSourceValidationError,
  markSourceReady,
  markSourceUnavailable,
  replaceSourceCredentialReference,
  type KnowledgeSource,
  type ObservationCapability,
  type SourceDiagnostic,
  type SourcePollingPolicy,
} from "../domain/knowledge-source.js";
import {
  createSourceObservation,
  type SourceObservation,
} from "../domain/source-observation.js";
import { isDigest, isId, isIsoTimestamp } from "../domain/model-validation.js";
import {
  SourceAdapterFault,
  type CredentialResolver,
  type SourceAdapter,
  type SourceAdapterContext,
  type SourceAdapterFaultCode,
  type SourceAdapterResolver,
  type SourceConfigurationResolver,
  type SourceRootIdGenerator,
  type SourceChangeSignal,
  type SourceObservationAttempt,
} from "../ports/source-adapter.js";
import type { SourceObservationStore } from "../ports/source-observation.js";
import {
  SourceObservationStoreConflict,
  SourceObservationStoreUnavailable,
} from "../ports/source-observation.js";

const INLINE_SECRET_KEYS = new Set([
  "accesstoken",
  "apikey",
  "authorization",
  "clientsecret",
  "credential",
  "credentials",
  "password",
  "privatekey",
  "secret",
  "token",
]);
const INLINE_SECRET_ASSIGNMENT_PATTERN =
  /(?:^|[?&#;,\s|])([a-z][a-z0-9_-]*)\s*[:=]/gi;

export type SourceManagementErrorCode =
  | SourceAdapterFaultCode
  | "adapter_failure"
  | "cancelled"
  | "configuration_unavailable"
  | "credential_unavailable"
  | "inline_credential"
  | "invalid_request"
  | "invalid_source_state"
  | "observation_in_progress"
  | "observation_store_conflict"
  | "observation_store_unavailable"
  | "timeout"
  | "unsupported_source_type";

export class SourceManagementError extends Error {
  constructor(
    readonly code: SourceManagementErrorCode,
    readonly sourceId?: string,
    readonly source?: KnowledgeSource,
  ) {
    super(`Source operation failed: ${code}`);
    this.name = "SourceManagementError";
  }
}

export interface RegisterSourceCommand {
  readonly sourceType: string;
  readonly displayName: string;
  readonly configReference: string;
  readonly credentialReference?: string;
  readonly polling: SourcePollingPolicy;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface SourceInspection {
  readonly source: KnowledgeSource;
}

export type SourceObservationResult =
  | {
      readonly source: KnowledgeSource;
      readonly changeSignal: SourceChangeSignal;
      readonly attempt: Extract<SourceObservationAttempt, { status: "changed" }>;
      readonly observation: SourceObservation;
      readonly observationStatus: "existing" | "stored";
    }
  | {
      readonly source: KnowledgeSource;
      readonly changeSignal: SourceChangeSignal;
      readonly attempt: Extract<SourceObservationAttempt, { status: "unchanged" }>;
    };

export interface RequestObservationOptions {
  readonly previousChangeToken?: string;
  readonly retentionLease?: {
    readonly leaseId: string;
    readonly durationMs: number;
  };
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface SourceManagementDependencies {
  readonly adapters: SourceAdapterResolver;
  readonly configurations: SourceConfigurationResolver;
  readonly credentials: CredentialResolver;
  readonly ids: SourceRootIdGenerator;
  readonly observations: SourceObservationStore;
  readonly defaultTimeoutMs: number;
  readonly clock?: () => string;
}

export class SourceManagement {
  readonly #dependencies: SourceManagementDependencies;
  readonly #clock: () => string;
  readonly #observationsInFlight = new Set<string>();

  constructor(dependencies: SourceManagementDependencies) {
    if (
      !Number.isSafeInteger(dependencies.defaultTimeoutMs) ||
      dependencies.defaultTimeoutMs <= 0
    ) {
      throw new RangeError("defaultTimeoutMs must be a positive integer");
    }
    this.#dependencies = dependencies;
    this.#clock = dependencies.clock ?? (() => new Date().toISOString());
  }

  async register(command: RegisterSourceCommand): Promise<KnowledgeSource> {
    const timeoutMs = this.#timeout(command.timeoutMs);
    try {
      return await runWithDeadline(async (signal) => {
        const adapter = this.#resolveAdapter(command.sourceType);
        const configuration = await this.#resolveConfiguration(
          command.configReference,
          signal,
        );
        assertNoInlineCredentials(configuration);
        const validated = adapter.validateConfiguration(configuration);
        assertSafeTargetKey(validated.targetKey);

        return createKnowledgeSource({
          id: this.#dependencies.ids.nextSourceId(),
          sourceType: command.sourceType,
          displayName: command.displayName,
          targetKey: validated.targetKey,
          configReference: command.configReference,
          ...(command.credentialReference === undefined
            ? {}
            : { credentialReference: command.credentialReference }),
          polling: command.polling,
        });
      }, timeoutMs, command.signal);
    } catch (error) {
      throw mapRuntimeError(error);
    }
  }

  async inspect(
    source: KnowledgeSource,
    options: {
      readonly signal?: AbortSignal;
      readonly timeoutMs?: number;
    } = {},
  ): Promise<SourceInspection> {
    const timeoutMs = this.#timeout(options.timeoutMs, source);
    this.#assertActive(source);
    try {
      return await runWithDeadline(async (signal) => {
        const adapter = this.#resolveAdapter(source.sourceType, source.id);
        const context = await this.#createContext(source, adapter, signal);
        await adapter.validateConnection({ ...context, signal });
        const capabilities = await adapter.probeCapabilities({
          ...context,
          signal,
        });
        return {
          source: markSourceReady(
            source,
            capabilities.map(toObservationCapability),
          ),
        };
      }, timeoutMs, options.signal);
    } catch (error) {
      const failure = mapRuntimeError(error, source.id);
      throw new SourceManagementError(
        failure.code,
        source.id,
        failure.code === "cancelled"
          ? source
          : markSourceUnavailable(source, failureDiagnostic(failure.code)),
      );
    }
  }

  async requestObservation(
    source: KnowledgeSource,
    options: RequestObservationOptions = {},
  ): Promise<SourceObservationResult> {
    const timeoutMs = this.#timeout(options.timeoutMs, source);
    assertRetentionLeaseOption(options.retentionLease, source.id);
    const runningSource = this.#beginObservation(source);
    try {
      return await runWithDeadline(async (signal) => {
        const adapter = this.#resolveAdapter(source.sourceType, source.id);
        const context = await this.#createContext(source, adapter, signal);
        const attempt = await adapter.observe(
          { ...context, signal },
          options.previousChangeToken,
        );
        if (attempt.status === "unchanged") {
          return {
            source: completeSourceObservation(runningSource, "unchanged"),
            changeSignal: {
              status: "unchanged",
              ...(options.previousChangeToken === undefined
                ? {}
                : { token: options.previousChangeToken }),
            },
            attempt,
          };
        }
        if (
          attempt.changeSignal.status !== "changed" ||
          attempt.changeSignal.token.trim().length === 0 ||
          !isIsoTimestamp(attempt.capturedAt) ||
          !isDigest(attempt.contentDigest)
        ) {
          throw new SourceManagementError("adapter_failure", source.id);
        }
        const candidate = createSourceObservation({
          id: this.#dependencies.ids.nextObservationId(),
          sourceId: source.id,
          capturedAt: attempt.capturedAt,
          contentDigest: attempt.contentDigest,
          payload: attempt.payload,
        });
        const acquiredAt = this.#now(source.id);
        const committed = await this.#dependencies.observations.commit({
          observation: candidate,
          signal,
          ...(options.retentionLease === undefined
            ? {}
            : {
                retentionLease: {
                  leaseId: options.retentionLease.leaseId,
                  observationId: candidate.id,
                  acquiredAt,
                  expiresAt: new Date(
                    Date.parse(acquiredAt) + options.retentionLease.durationMs,
                  ).toISOString(),
                },
              }),
        });
        return {
          source: completeSourceObservation(runningSource, "changed"),
          changeSignal: attempt.changeSignal,
          attempt: {
            ...attempt,
            capturedAt: committed.observation.capturedAt,
            contentDigest: committed.observation.contentDigest,
            payload: committed.observation.payload,
          },
          observation: committed.observation,
          observationStatus: committed.status,
        };
      }, timeoutMs, options.signal);
    } catch (error) {
      const failure = mapRuntimeError(error, source.id);
      throw new SourceManagementError(
        failure.code,
        source.id,
        failSourceObservation(
          runningSource,
          failureDiagnostic(failure.code),
        ),
      );
    } finally {
      this.#observationsInFlight.delete(source.id);
    }
  }

  replaceCredentialReference(
    source: KnowledgeSource,
    credentialReference?: string,
  ): KnowledgeSource {
    this.#assertNotObserving(source);
    try {
      return replaceSourceCredentialReference(source, credentialReference);
    } catch (error) {
      throw mapRuntimeError(error, source.id);
    }
  }

  disable(source: KnowledgeSource): KnowledgeSource {
    this.#assertNotObserving(source);
    try {
      return disableSource(source);
    } catch (error) {
      throw mapRuntimeError(error, source.id);
    }
  }

  #resolveAdapter(sourceType: string, sourceId?: string): SourceAdapter {
    const adapter = this.#dependencies.adapters.resolve(sourceType);
    if (adapter === undefined) {
      throw new SourceManagementError(
        "unsupported_source_type",
        sourceId,
      );
    }
    return adapter;
  }

  async #resolveConfiguration(
    reference: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    try {
      return await this.#dependencies.configurations.resolve(reference, signal);
    } catch {
      throw new SourceManagementError("configuration_unavailable");
    }
  }

  async #createContext(
    source: KnowledgeSource,
    adapter: SourceAdapter,
    signal: AbortSignal,
  ): Promise<Omit<SourceAdapterContext, "signal">> {
    const configuration = await this.#resolveConfiguration(
      source.configReference,
      signal,
    );
    assertNoInlineCredentials(configuration);

    let validated;
    try {
      validated = adapter.validateConfiguration(configuration);
    } catch (error) {
      throw mapAdapterError(error, source.id);
    }
    if (validated.targetKey !== source.targetKey) {
      throw new SourceManagementError("invalid_configuration", source.id);
    }
    assertSafeTargetKey(validated.targetKey, source.id);

    if (source.credentialReference === undefined) {
      return { source, configuration: validated.value };
    }
    try {
      const credential = await this.#dependencies.credentials.resolve(
        source.credentialReference as string,
        signal,
      );
      return { source, configuration: validated.value, credential };
    } catch {
      throw new SourceManagementError("credential_unavailable", source.id);
    }
  }

  #timeout(override?: number, source?: KnowledgeSource): number {
    if (override === undefined) {
      return this.#dependencies.defaultTimeoutMs;
    }
    if (!Number.isSafeInteger(override) || override <= 0) {
      throw new SourceManagementError(
        "invalid_request",
        source?.id,
        source,
      );
    }
    return override;
  }

  #now(sourceId: string): string {
    const value = this.#clock();
    if (!isIsoTimestamp(value)) {
      throw new SourceManagementError("invalid_request", sourceId);
    }
    return value;
  }

  #assertActive(source: KnowledgeSource): void {
    try {
      assertSourceActive(source);
    } catch (error) {
      throw mapRuntimeError(error, source.id);
    }
  }

  #assertNotObserving(source: KnowledgeSource): void {
    if (this.#observationsInFlight.has(source.id)) {
      throw new SourceManagementError(
        "observation_in_progress",
        source.id,
        source,
      );
    }
  }

  #beginObservation(source: KnowledgeSource): KnowledgeSource {
    this.#assertNotObserving(source);
    try {
      const running = beginSourceObservation(source);
      this.#observationsInFlight.add(source.id);
      return running;
    } catch (error) {
      throw mapRuntimeError(error, source.id);
    }
  }
}

class OperationInterruptedError extends Error {
  constructor(readonly reason: "cancelled" | "timeout") {
    super(`Operation ${reason}`);
    this.name = "OperationInterruptedError";
  }
}

async function runWithDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<T> {
  if (parentSignal?.aborted === true) {
    throw new OperationInterruptedError("cancelled");
  }

  const controller = new AbortController();
  let interruption: "cancelled" | "timeout" = "timeout";
  const onParentAbort = (): void => {
    interruption = "cancelled";
    controller.abort();
  };
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await Promise.race([
      operation(controller.signal).catch((error: unknown) => {
        if (controller.signal.aborted) {
          throw new OperationInterruptedError(interruption);
        }
        throw error;
      }),
      new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(new OperationInterruptedError(interruption)),
          { once: true },
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

function mapRuntimeError(
  error: unknown,
  sourceId?: string,
): SourceManagementError {
  if (error instanceof SourceManagementError) {
    if (error.sourceId === undefined && sourceId !== undefined) {
      return new SourceManagementError(error.code, sourceId);
    }
    return error;
  }
  if (error instanceof OperationInterruptedError) {
    return new SourceManagementError(error.reason, sourceId);
  }
  if (error instanceof SourceObservationStoreConflict) {
    return new SourceManagementError("observation_store_conflict", sourceId);
  }
  if (error instanceof SourceObservationStoreUnavailable) {
    return new SourceManagementError("observation_store_unavailable", sourceId);
  }
  return mapAdapterError(error, sourceId);
}

function assertRetentionLeaseOption(
  lease: RequestObservationOptions["retentionLease"],
  sourceId: string,
): void {
  if (
    lease !== undefined &&
    (!isId(lease.leaseId, "lease") ||
      !Number.isSafeInteger(lease.durationMs) ||
      lease.durationMs <= 0)
  ) {
    throw new SourceManagementError("invalid_request", sourceId);
  }
}

function mapAdapterError(
  error: unknown,
  sourceId?: string,
): SourceManagementError {
  if (error instanceof SourceAdapterFault) {
    return new SourceManagementError(error.code, sourceId);
  }
  if (error instanceof KnowledgeSourceValidationError) {
    return new SourceManagementError("invalid_configuration", sourceId);
  }
  if (error instanceof KnowledgeSourceTransitionError) {
    return new SourceManagementError("invalid_source_state", sourceId);
  }
  return new SourceManagementError("adapter_failure", sourceId);
}

function failureDiagnostic(code: SourceManagementErrorCode): SourceDiagnostic {
  return createSourceDiagnostic(code, `Source operation failed: ${code}`);
}

function toObservationCapability(
  capability: Awaited<
    ReturnType<SourceAdapter["probeCapabilities"]>
  >[number],
): ObservationCapability {
  if (capability.status === "available") {
    return { name: capability.name, status: "available" };
  }
  const code = capability.diagnosticCode ?? "capability_unavailable";
  return {
    name: capability.name,
    status: "unavailable",
    diagnostic: createSourceDiagnostic(
      code,
      `Source capability unavailable: ${code}`,
    ),
  };
}

function assertNoInlineCredentials(value: unknown): void {
  const seen = new Set<object>();
  const visit = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      assertNoStringCredentials(candidate);
      return;
    }
    if (candidate === null || typeof candidate !== "object") {
      return;
    }
    if (seen.has(candidate)) {
      return;
    }
    seen.add(candidate);
    for (const [key, nested] of Object.entries(candidate)) {
      if (INLINE_SECRET_KEYS.has(key.toLowerCase().replaceAll(/[_-]/g, ""))) {
        throw new SourceManagementError("inline_credential");
      }
      visit(nested);
    }
  };
  visit(value);
}

function assertNoStringCredentials(value: string): void {
  for (const match of value.matchAll(INLINE_SECRET_ASSIGNMENT_PATTERN)) {
    const key = match[1];
    if (
      key !== undefined &&
      INLINE_SECRET_KEYS.has(key.toLowerCase().replaceAll(/[_-]/g, ""))
    ) {
      throw new SourceManagementError("inline_credential");
    }
  }
  try {
    const url = new URL(value);
    if (url.username.length > 0 || url.password.length > 0) {
      throw new SourceManagementError("inline_credential");
    }
    for (const key of url.searchParams.keys()) {
      if (INLINE_SECRET_KEYS.has(key.toLowerCase().replaceAll(/[_-]/g, ""))) {
        throw new SourceManagementError("inline_credential");
      }
    }
  } catch (error) {
    if (error instanceof SourceManagementError) {
      throw error;
    }
  }
}

function assertSafeTargetKey(targetKey: string, sourceId?: string): void {
  try {
    assertNoInlineCredentials(targetKey);
  } catch (error) {
    if (
      error instanceof SourceManagementError &&
      error.code === "inline_credential"
    ) {
      throw new SourceManagementError("inline_credential", sourceId);
    }
    throw error;
  }
}
