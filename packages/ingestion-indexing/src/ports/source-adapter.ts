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

export interface SourceRootIdGenerator extends SourceIdGenerator {
  nextObservationId(): string;
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

export interface ObservedSourceChangeSignal {
  readonly status: "changed";
  readonly token: string;
}

export interface ProbedObservationCapability {
  readonly name: string;
  readonly status: "available" | "unavailable";
  readonly diagnosticCode?: string;
}

export type SourceObservationAttempt =
  | {
      readonly status: "changed";
      readonly payload: unknown;
      /** Canonical capture time supplied by the adapter. */
      readonly capturedAt: string;
      /** Digest of canonical source content, excluding volatile capture metadata. */
      readonly contentDigest: string;
      readonly changeSignal: ObservedSourceChangeSignal;
    }
  | { readonly status: "unchanged" };

export interface SourceAdapter {
  readonly sourceType: string;
  validateConfiguration(input: unknown): ValidatedSourceConfiguration;
  validateConnection(context: SourceAdapterContext): Promise<void>;
  probeCapabilities(
    context: SourceAdapterContext,
  ): Promise<readonly ProbedObservationCapability[]>;
  /**
   * Captures one authoritative snapshot and compares its token with the
   * previous observation. Implementations must not split change detection and
   * capture across independently mutable reads.
   */
  observe(
    context: SourceAdapterContext,
    previousToken?: string,
  ): Promise<SourceObservationAttempt>;
}

export interface SourceAdapterResolver {
  resolve(sourceType: string): SourceAdapter | undefined;
}

export type SourceAdapterFaultCode =
  | "connection_failed"
  | "invalid_configuration"
  | "invalid_format"
  | "permission_denied"
  | "source_unstable"
  | "target_not_found";

export class SourceAdapterFault extends Error {
  constructor(readonly code: SourceAdapterFaultCode) {
    super(`Source adapter failed: ${code}`);
    this.name = "SourceAdapterFault";
  }
}
