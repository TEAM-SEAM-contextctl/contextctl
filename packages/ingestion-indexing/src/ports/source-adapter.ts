import type { KnowledgeSource } from "../domain/knowledge-source.js";

export interface SourceConfigurationResolver {
  resolve(reference: string, signal: AbortSignal): Promise<unknown>;
}

export interface CredentialResolver {
  resolve(reference: string, signal: AbortSignal): Promise<unknown>;
}

export interface SourceIdGenerator {
  nextSourceId(): string;
}

export interface ValidatedSourceConfiguration {
  readonly targetKey: string;
  readonly value: unknown;
}

export interface SourceAdapterContext {
  readonly source: KnowledgeSource;
  readonly configuration: unknown;
  readonly credential?: unknown;
  readonly signal: AbortSignal;
}

export interface SourceChangeSignal {
  readonly status: "changed" | "unchanged";
  readonly token?: string;
}

export interface ProbedObservationCapability {
  readonly name: string;
  readonly status: "available" | "unavailable";
  readonly diagnosticCode?: string;
}

export type SourceObservationAttempt =
  | { readonly status: "changed"; readonly payload: unknown }
  | { readonly status: "unchanged" };

export interface SourceAdapter {
  readonly sourceType: string;
  validateConfiguration(input: unknown): ValidatedSourceConfiguration;
  validateConnection(context: SourceAdapterContext): Promise<void>;
  probeCapabilities(
    context: SourceAdapterContext,
  ): Promise<readonly ProbedObservationCapability[]>;
  detectChange(
    context: SourceAdapterContext,
    previousToken?: string,
  ): Promise<SourceChangeSignal>;
  observe(context: SourceAdapterContext): Promise<SourceObservationAttempt>;
}

export interface SourceAdapterResolver {
  resolve(sourceType: string): SourceAdapter | undefined;
}

export type SourceAdapterFaultCode =
  | "connection_failed"
  | "invalid_configuration"
  | "invalid_format"
  | "permission_denied"
  | "target_not_found";

export class SourceAdapterFault extends Error {
  constructor(readonly code: SourceAdapterFaultCode) {
    super(`Source adapter failed: ${code}`);
    this.name = "SourceAdapterFault";
  }
}
