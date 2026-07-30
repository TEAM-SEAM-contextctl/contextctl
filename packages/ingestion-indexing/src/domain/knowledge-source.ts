import { isId } from "./model-validation.js";

const MACHINE_NAME_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const MAX_DIAGNOSTIC_LENGTH = 256;

export type SourceLifecycleStatus = "active" | "disabled";

export interface SourcePollingPolicy {
  readonly enabled: boolean;
  readonly intervalMs?: number;
}

export interface SourceDiagnostic {
  readonly code: string;
  readonly detail: string;
}

export interface ObservationCapability {
  readonly name: string;
  readonly status: "available" | "unavailable";
  readonly diagnostic?: SourceDiagnostic;
}

export type SourceInspectionStatus =
  | { readonly state: "unverified" }
  | {
      readonly state: "unavailable";
      readonly diagnostic: SourceDiagnostic;
    }
  | {
      readonly state: "ready";
      readonly capabilities: readonly ObservationCapability[];
    };

export type SourceExecutionStatus =
  | { readonly state: "idle" }
  | { readonly state: "running" }
  | {
      readonly state: "succeeded";
      readonly outcome: "changed" | "unchanged";
    }
  | {
      readonly state: "failed";
      readonly diagnostic: SourceDiagnostic;
    };

export interface KnowledgeSource {
  readonly id: string;
  readonly sourceType: string;
  readonly displayName: string;
  readonly targetKey: string;
  readonly configReference: string;
  readonly credentialReference?: string;
  readonly lifecycleStatus: SourceLifecycleStatus;
  readonly inspectionStatus: SourceInspectionStatus;
  readonly executionStatus: SourceExecutionStatus;
  readonly polling: SourcePollingPolicy;
}

export interface CreateKnowledgeSourceInput {
  readonly id: string;
  readonly sourceType: string;
  readonly displayName: string;
  readonly targetKey: string;
  readonly configReference: string;
  readonly credentialReference?: string;
  readonly polling: SourcePollingPolicy;
}

export class KnowledgeSourceValidationError extends Error {
  readonly code = "invalid_source";

  constructor(readonly field: string) {
    super(`KnowledgeSource field is invalid: ${field}`);
    this.name = "KnowledgeSourceValidationError";
  }
}

export class KnowledgeSourceTransitionError extends Error {
  readonly code = "invalid_source_transition";

  constructor(readonly transition: string) {
    super(`KnowledgeSource transition is invalid: ${transition}`);
    this.name = "KnowledgeSourceTransitionError";
  }
}

export function createKnowledgeSource(
  input: CreateKnowledgeSourceInput,
): KnowledgeSource {
  validateSourceId(input.id);
  validateMachineName("sourceType", input.sourceType);
  validateText("displayName", input.displayName);
  validateText("targetKey", input.targetKey);
  validateText("configReference", input.configReference);
  if (input.credentialReference !== undefined) {
    validateText("credentialReference", input.credentialReference);
  }
  validatePollingPolicy(input.polling);

  return {
    ...input,
    lifecycleStatus: "active",
    inspectionStatus: { state: "unverified" },
    executionStatus: { state: "idle" },
  };
}

export function markSourceReady(
  source: KnowledgeSource,
  capabilities: readonly ObservationCapability[],
): KnowledgeSource {
  assertActive(source);
  const normalized = normalizeCapabilities(capabilities);
  return {
    ...source,
    inspectionStatus: { state: "ready", capabilities: normalized },
  };
}

export function markSourceUnavailable(
  source: KnowledgeSource,
  diagnostic: SourceDiagnostic,
): KnowledgeSource {
  assertActive(source);
  return {
    ...source,
    inspectionStatus: {
      state: "unavailable",
      diagnostic: createSourceDiagnostic(diagnostic.code, diagnostic.detail),
    },
  };
}

export function beginSourceObservation(
  source: KnowledgeSource,
): KnowledgeSource {
  assertActive(source);
  if (source.inspectionStatus.state !== "ready") {
    throw new KnowledgeSourceTransitionError(
      "observation requires a ready source",
    );
  }
  if (source.executionStatus.state === "running") {
    throw new KnowledgeSourceTransitionError(
      "observation is already in progress",
    );
  }
  return { ...source, executionStatus: { state: "running" } };
}

export function completeSourceObservation(
  source: KnowledgeSource,
  outcome: "changed" | "unchanged",
): KnowledgeSource {
  if (source.executionStatus.state !== "running") {
    throw new KnowledgeSourceTransitionError(
      "observation completion requires a running source",
    );
  }
  return { ...source, executionStatus: { state: "succeeded", outcome } };
}

export function failSourceObservation(
  source: KnowledgeSource,
  diagnostic: SourceDiagnostic,
): KnowledgeSource {
  if (source.executionStatus.state !== "running") {
    throw new KnowledgeSourceTransitionError(
      "observation failure requires a running source",
    );
  }
  return {
    ...source,
    executionStatus: {
      state: "failed",
      diagnostic: createSourceDiagnostic(diagnostic.code, diagnostic.detail),
    },
  };
}

export function disableSource(source: KnowledgeSource): KnowledgeSource {
  if (source.executionStatus.state === "running") {
    throw new KnowledgeSourceTransitionError(
      "a running source cannot be disabled",
    );
  }
  return { ...source, lifecycleStatus: "disabled" };
}

export function replaceSourceCredentialReference(
  source: KnowledgeSource,
  credentialReference?: string,
): KnowledgeSource {
  assertActive(source);
  if (source.executionStatus.state === "running") {
    throw new KnowledgeSourceTransitionError(
      "a running source cannot change credentials",
    );
  }
  if (credentialReference !== undefined) {
    validateText("credentialReference", credentialReference);
    return { ...source, credentialReference };
  }
  const { credentialReference: _removed, ...withoutCredential } = source;
  return withoutCredential;
}

export function assertSourceActive(source: KnowledgeSource): void {
  assertActive(source);
}

export function createSourceDiagnostic(
  code: string,
  detail: string,
): SourceDiagnostic {
  validateMachineName("diagnostic.code", code);
  const normalizedDetail = detail.replaceAll(/[\r\n\t]+/g, " ").trim();
  if (normalizedDetail.length === 0) {
    throw new KnowledgeSourceValidationError("diagnostic.detail");
  }
  return {
    code,
    detail: normalizedDetail.slice(0, MAX_DIAGNOSTIC_LENGTH),
  };
}

function normalizeCapabilities(
  capabilities: readonly ObservationCapability[],
): readonly ObservationCapability[] {
  const names = new Set<string>();
  const normalized = capabilities.map((capability) => {
    validateMachineName("capability.name", capability.name);
    if (names.has(capability.name)) {
      throw new KnowledgeSourceValidationError("capabilities");
    }
    names.add(capability.name);
    if (
      capability.status === "available" &&
      capability.diagnostic !== undefined
    ) {
      throw new KnowledgeSourceValidationError("capability.diagnostic");
    }
    if (
      capability.status === "unavailable" &&
      capability.diagnostic === undefined
    ) {
      throw new KnowledgeSourceValidationError("capability.diagnostic");
    }
    if (capability.diagnostic === undefined) {
      return capability;
    }
    return {
      ...capability,
      diagnostic: createSourceDiagnostic(
        capability.diagnostic.code,
        capability.diagnostic.detail,
      ),
    };
  });
  return [...normalized].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

function validateSourceId(value: string): void {
  if (!isId(value, "src")) {
    throw new KnowledgeSourceValidationError("id");
  }
}

function validateMachineName(field: string, value: string): void {
  if (!MACHINE_NAME_PATTERN.test(value)) {
    throw new KnowledgeSourceValidationError(field);
  }
}

function validateText(field: string, value: string): void {
  if (value.trim().length === 0 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new KnowledgeSourceValidationError(field);
  }
}

function validatePollingPolicy(policy: SourcePollingPolicy): void {
  if (policy.enabled) {
    if (
      policy.intervalMs === undefined ||
      !Number.isSafeInteger(policy.intervalMs) ||
      policy.intervalMs <= 0
    ) {
      throw new KnowledgeSourceValidationError("polling.intervalMs");
    }
    return;
  }
  if (policy.intervalMs !== undefined) {
    throw new KnowledgeSourceValidationError("polling.intervalMs");
  }
}

function assertActive(source: KnowledgeSource): void {
  if (source.lifecycleStatus !== "active") {
    throw new KnowledgeSourceTransitionError("source is disabled");
  }
}
