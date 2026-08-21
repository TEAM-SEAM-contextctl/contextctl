import type { IngestionPublication } from "@contextctl/contracts";

import {
  buildEmptyMarkdownPublication,
  buildMarkdownPublication,
} from "./build-markdown-publication.js";
import type { CaptureMarkdownCommand } from "./markdown-capture.js";
import type {
  IncrementalDocumentReindexer,
  PreparedReindexDocumentPublication,
} from "./reindex-document-incrementally.js";
import type {
  RegisterSourceCommand,
  SourceManagement,
} from "./source-management.js";
import {
  DEFAULT_DOCUMENT_INDEXING_POLICY,
  type DocumentIndexingPolicySet,
} from "../domain/document-indexing-policy.js";
import {
  assertValidDocumentIndexingSnapshot,
  planDocumentIncrementalUpdate,
  type DocumentIndexingSnapshot,
} from "../domain/document-incremental-update.js";
import type {
  DocumentSemanticUnit,
  NormalizedDocument,
} from "../domain/document-model.js";
import {
  segmentNormalizedDocument,
  type SemanticUnitIdSource,
} from "../domain/document-segmentation.js";
import {
  embeddingProfilesMatch,
  type EmbeddingProfile,
} from "../domain/embedding-profile.js";
import {
  generateManagedChunks,
  type ManagedChunkIdSource,
} from "../domain/managed-chunk-generation.js";
import { reconcileSemanticUnitLineage } from "../domain/semantic-unit-lineage.js";
import { canonicalJson } from "../domain/revision-identity.js";
import type { MarkdownSourceSnapshot } from "../ports/document-capture.js";
import type {
  IngestionPublicationStore,
  MarkdownPublicationCheckpoint,
  MarkdownPublicationCheckpointStore,
  MarkdownPublicationEventSink,
  MarkdownPublicationStage,
  MarkdownPublicationStageEvent,
  MarkdownPublicationStageStatus,
  PublicationRecoveryIntent,
  PublicationRootIdGenerator,
} from "../ports/markdown-publication.js";
import type { SourceObservationStore } from "../ports/source-observation.js";

export const DEFAULT_MARKDOWN_OBSERVATION_RETENTION_LEASE_MS =
  60 * 60 * 1_000;

const DOWNSTREAM_STAGES: readonly MarkdownPublicationStage[] = [
  "capture",
  "segmentation",
  "chunking",
  "index_update",
  "ingestion_publication",
];

export interface PublishMarkdownSourceCommand {
  readonly source: RegisterSourceCommand;
  readonly connectorId: string;
  readonly securityDomain: string;
  readonly signal?: AbortSignal;
}

export interface MarkdownPublicationDiagnostic {
  readonly stage: MarkdownPublicationStage;
  readonly status: Exclude<MarkdownPublicationStageStatus, "started">;
  readonly code?: string;
}

export interface PublishMarkdownSourceResult {
  readonly status: "already_published" | "published" | "unchanged";
  readonly sourceId: string;
  readonly observationId?: string;
  readonly indexVersion?: string;
  readonly publication?: IngestionPublication;
  readonly diagnostics: readonly MarkdownPublicationDiagnostic[];
}

export type MarkdownPublicationWorkflowErrorCode =
  | "invalid_request"
  | "stage_failed";

export class MarkdownPublicationWorkflowError extends Error {
  constructor(
    readonly code: MarkdownPublicationWorkflowErrorCode,
    readonly stage: MarkdownPublicationStage,
    readonly diagnosticCode: string,
    readonly diagnostics: readonly MarkdownPublicationDiagnostic[],
  ) {
    super(`Markdown publication failed: ${stage}:${diagnosticCode}`);
    this.name = "MarkdownPublicationWorkflowError";
  }
}

export interface MarkdownPublicationWorkflowDependencies {
  readonly sourceManagement: SourceManagement;
  readonly observations: SourceObservationStore;
  readonly checkpoints: MarkdownPublicationCheckpointStore;
  readonly captureMarkdown: (
    command: CaptureMarkdownCommand,
  ) => NormalizedDocument;
  readonly documentReindexer: IncrementalDocumentReindexer;
  readonly publications: IngestionPublicationStore;
  readonly ids: PublicationRootIdGenerator;
  readonly structuralIds: SemanticUnitIdSource & ManagedChunkIdSource;
  readonly events: MarkdownPublicationEventSink;
  readonly embeddingProfile: EmbeddingProfile;
  /** Stable identity of the durable daemon state this workflow belongs to. */
  readonly stateNamespaceId: string;
  /** One workflow instance is bound to exactly one provider security domain. */
  readonly securityDomain: string;
  readonly indexingPolicy?: DocumentIndexingPolicySet;
  readonly observationRetentionLeaseMs?: number;
  readonly clock?: () => string;
}

/**
 * Runs the first complete Ingestion path without creating Cards or selecting
 * them. Registry receives only the committed contract and an ID notification.
 */
export class MarkdownPublicationWorkflow {
  readonly #dependencies: MarkdownPublicationWorkflowDependencies;
  readonly #policy: DocumentIndexingPolicySet;
  readonly #clock: () => string;
  readonly #observationRetentionLeaseMs: number;
  #nextOperation = 1;

  constructor(dependencies: MarkdownPublicationWorkflowDependencies) {
    if (
      dependencies.securityDomain.trim() === "" ||
      dependencies.stateNamespaceId.trim() === ""
    ) {
      throw new TypeError("Markdown publication security domain is invalid");
    }
    this.#dependencies = dependencies;
    this.#policy = dependencies.indexingPolicy ?? DEFAULT_DOCUMENT_INDEXING_POLICY;
    this.#clock = dependencies.clock ?? (() => new Date().toISOString());
    this.#observationRetentionLeaseMs =
      dependencies.observationRetentionLeaseMs ??
      DEFAULT_MARKDOWN_OBSERVATION_RETENTION_LEASE_MS;
    if (
      !Number.isSafeInteger(this.#observationRetentionLeaseMs) ||
      this.#observationRetentionLeaseMs <= 0
    ) {
      throw new TypeError("Markdown observation retention lease is invalid");
    }
  }

  async publish(
    command: PublishMarkdownSourceCommand,
  ): Promise<PublishMarkdownSourceResult> {
    const securityDomainDenied =
      command.securityDomain.trim() !== "" &&
      command.securityDomain !== this.#dependencies.securityDomain;
    if (
      command.source.sourceType !== "markdown" ||
      command.connectorId.trim() === "" ||
      command.securityDomain.trim() === "" ||
      command.securityDomain !== this.#dependencies.securityDomain ||
      command.signal?.aborted === true
    ) {
      throw new MarkdownPublicationWorkflowError(
        "invalid_request",
        "registration",
        securityDomainDenied
          ? "security_domain_not_allowed"
          : "invalid_request",
        [
          {
            stage: "registration",
            status: "failed",
            code: securityDomainDenied
              ? "security_domain_not_allowed"
              : "invalid_request",
          },
        ],
      );
    }
    const operation = new OperationContext(
      `markdown-publication-${String(this.#nextOperation++)}`,
      this.#dependencies.events,
      this.#clock,
    );
    const registration = await operation.run("registration", async () => {
      const candidate = await this.#dependencies.sourceManagement.register(
        command.source,
      );
      return this.#dependencies.checkpoints.register(
        candidate,
        this.#dependencies.ids.nextDocumentId(),
      );
    });
    let checkpoint = registration.checkpoint;
    operation.bind({ sourceId: checkpoint.source.id });

    const recovered = await this.#recoverBeforeObservation(
      command,
      checkpoint,
      operation,
    );
    if (recovered !== undefined) return recovered;

    const inspection = await operation.run("inspection", async () => {
      const result = await this.#dependencies.sourceManagement.inspect(
        checkpoint.source,
        {
          ...(command.signal === undefined ? {} : { signal: command.signal }),
          ...(command.source.timeoutMs === undefined
            ? {}
            : { timeoutMs: command.source.timeoutMs }),
        },
      );
      assertDocumentCaptureAvailable(result.source);
      await this.#dependencies.checkpoints.save({
        ...checkpoint,
        source: result.source,
      });
      return result;
    });
    checkpoint = { ...checkpoint, source: inspection.source };

    const observed = await operation.run("observation", async () => {
      await this.#ensureComparisonBaseline(checkpoint);
      const retentionLeaseId = `lease_${operation.operationId}`;
      const result = await this.#dependencies.sourceManagement.requestObservation(
        checkpoint.source,
        {
          ...(checkpoint.previousChangeToken === undefined
            ? {}
            : { previousChangeToken: checkpoint.previousChangeToken }),
          ...(command.signal === undefined ? {} : { signal: command.signal }),
          ...(command.source.timeoutMs === undefined
            ? {}
            : { timeoutMs: command.source.timeoutMs }),
          retentionLease: {
            leaseId: retentionLeaseId,
            durationMs: this.#observationRetentionLeaseMs,
          },
        },
      );
      await this.#dependencies.checkpoints.save({
        ...checkpoint,
        source: result.source,
      });
      const latest =
        result.attempt.status === "unchanged"
          ? await this.#dependencies.publications.latestForSource(
              result.source.id,
            )
          : undefined;
      return { result, latest, retentionLeaseId };
    });
    const observation = observed.result;
    checkpoint = { ...checkpoint, source: observation.source };
    if (observation.attempt.status === "unchanged") {
      operation.markSkipped(DOWNSTREAM_STAGES, "source_unchanged");
      const latest = observed.latest;
      const indexVersion =
        latest === undefined ? undefined : managedIndexVersion(latest);
      return {
        status: "unchanged",
        sourceId: checkpoint.source.id,
        ...(latest === undefined
          ? {}
          : {
              observationId: latest.observationId,
              publication: latest,
              ...(indexVersion === undefined ? {} : { indexVersion }),
            }),
        diagnostics: operation.diagnostics,
      };
    }
    if (!("observation" in observation)) {
      throw operation.failure("observation", "observation_not_stored");
    }
    const observationId = observation.observation.id;
    operation.bind({ observationId });
    try {
      return await this.#publishSnapshot(
        command,
        checkpoint,
        {
          observationId,
          snapshot: observation.attempt.payload,
          changeToken: observation.attempt.changeSignal.token,
        },
        operation,
      );
    } finally {
      try {
        await this.#dependencies.observations.releaseRetentionLease(
          observed.retentionLeaseId,
          observationId,
        );
      } catch {
        // The bounded lease expires without risking a referenced snapshot.
      }
    }
  }

  async #recoverBeforeObservation(
    command: PublishMarkdownSourceCommand,
    checkpoint: MarkdownPublicationCheckpoint,
    operation: OperationContext,
  ): Promise<PublishMarkdownSourceResult | undefined> {
    let pending: PublicationRecoveryIntent | undefined;
    let latest: IngestionPublication | undefined;
    try {
      [pending, latest] = await Promise.all([
        this.#dependencies.publications.pendingRecoveryIntentForSource(
          checkpoint.source.id,
        ),
        this.#dependencies.publications.latestForSource(checkpoint.source.id),
      ]);
    } catch (error) {
      throw operation.failure(
        "ingestion_publication",
        safeDiagnosticCode(error),
      );
    }

    if (pending !== undefined) {
      if (
        pending.state !== "pending" ||
        pending.publication.sourceId !== checkpoint.source.id ||
        pending.publication.previousPublicationId !== latest?.publicationId
      ) {
        throw operation.failure(
          "ingestion_publication",
          "publication_conflict",
        );
      }
      operation.markSkipped(
        ["inspection", "observation"],
        "publication_recovery",
      );
      return this.#resumeStoredObservation(
        command,
        checkpoint,
        pending.publication.observationId,
        operation,
        pending,
      );
    }

    if (checkpoint.pendingIndexingSnapshot !== undefined) {
      operation.markSkipped(
        ["inspection", "observation"],
        "structural_identity_recovery",
      );
      return this.#resumeStoredObservation(
        command,
        checkpoint,
        checkpoint.pendingIndexingSnapshot.document.observationId,
        operation,
      );
    }

    if (
      latest !== undefined &&
      checkpoint.observationId !== latest.observationId
    ) {
      operation.markSkipped(
        ["inspection", "observation"],
        "checkpoint_recovery",
      );
      return this.#resumeStoredObservation(
        command,
        checkpoint,
        latest.observationId,
        operation,
      );
    }
    return undefined;
  }

  async #resumeStoredObservation(
    command: PublishMarkdownSourceCommand,
    checkpoint: MarkdownPublicationCheckpoint,
    observationId: string,
    operation: OperationContext,
    recoveryIntent?: PublicationRecoveryIntent,
  ): Promise<PublishMarkdownSourceResult> {
    let observation;
    try {
      observation = await this.#dependencies.observations.find(observationId);
    } catch (error) {
      throw operation.failure("capture", safeDiagnosticCode(error));
    }
    if (
      observation?.sourceId !== checkpoint.source.id ||
      !isMarkdownSourceSnapshot(observation.payload) ||
      observation.payload.contentDigest !== observation.contentDigest
    ) {
      throw operation.failure("capture", "observation_baseline_corrupt");
    }
    operation.bind({ observationId });
    return this.#publishSnapshot(
      command,
      checkpoint,
      {
        observationId,
        snapshot: observation.payload,
        changeToken: observation.contentDigest,
        ...(recoveryIntent === undefined ? {} : { recoveryIntent }),
      },
      operation,
    );
  }

  async #publishSnapshot(
    command: PublishMarkdownSourceCommand,
    checkpoint: MarkdownPublicationCheckpoint,
    input: {
      readonly observationId: string;
      readonly snapshot: unknown;
      readonly changeToken: string;
      readonly recoveryIntent?: PublicationRecoveryIntent;
    },
    operation: OperationContext,
  ): Promise<PublishMarkdownSourceResult> {
    if (!isMarkdownSourceSnapshot(input.snapshot)) {
      throw operation.failure("capture", "invalid_markdown_snapshot");
    }
    const { observationId, snapshot, changeToken } = input;
    let currentSnapshot: DocumentIndexingSnapshot | undefined;
    try {
      currentSnapshot = recoverPendingIndexingSnapshot({
        checkpoint,
        observationId,
        snapshot,
        policy: this.#policy,
        embeddingProfile: this.#dependencies.embeddingProfile,
      });
    } catch (error) {
      throw operation.failure("chunking", safeDiagnosticCode(error));
    }
    if (currentSnapshot === undefined) {
      const previousDocument = checkpointDocument(checkpoint);
      const document = await operation.run("capture", () =>
        this.#dependencies.captureMarkdown({
          source: checkpoint.source,
          observationId,
          documentId: checkpoint.documentId,
          snapshot,
          ...(previousDocument === undefined ? {} : { previousDocument }),
        }),
      );
      const provisionalUnits = await operation.run("segmentation", () =>
        segmentNormalizedDocument({
          document,
          ids: this.#dependencies.structuralIds,
          policy: this.#policy,
        }),
      );
      const semanticUnits = reconcileUnits(
        checkpoint,
        document,
        provisionalUnits,
        this.#policy,
      );
      currentSnapshot = await operation.run("chunking", async () => {
        const chunks = generateManagedChunks({
          document,
          semanticUnits,
          ids: this.#dependencies.structuralIds,
          policy: this.#policy,
        });
        const issued: DocumentIndexingSnapshot = {
          document,
          semanticUnits,
          chunks,
          indexingPolicy: this.#policy,
          embeddingProfile: this.#dependencies.embeddingProfile,
          payloadSchemaVersion: 2,
        };
        assertValidDocumentIndexingSnapshot(issued);
        await this.#dependencies.checkpoints.save({
          ...checkpoint,
          pendingIndexingSnapshot: issued,
        });
        return issued;
      });
    } else {
      operation.markSkipped(
        ["capture", "segmentation", "chunking"],
        "structural_identity_recovery",
      );
    }
    const { document, semanticUnits, chunks } = currentSnapshot;
    let previousPublication: IngestionPublication | undefined;
    try {
      previousPublication =
        await this.#dependencies.publications.latestForSource(
          checkpoint.source.id,
        );
    } catch (error) {
      throw operation.failure(
        "ingestion_publication",
        safeDiagnosticCode(error),
      );
    }

    if (previousPublication?.observationId === observationId) {
      operation.markSkipped(["index_update"], "observation_already_published");
      const recoveredSnapshot = recoverCommittedSnapshot(
        checkpoint.indexingSnapshot,
        currentSnapshot,
      );
      await operation.run("ingestion_publication", async () => {
        await this.#dependencies.checkpoints.save({
          source: checkpoint.source,
          documentId: checkpoint.documentId,
          observationId,
          previousChangeToken: changeToken,
          indexingSnapshot: recoveredSnapshot,
        });
        await this.#dependencies.observations.markComparisonBaseline({
          sourceId: checkpoint.source.id,
          observationId,
          ...(checkpoint.observationId === undefined
            ? {}
            : { expectedObservationId: checkpoint.observationId }),
        });
      });
      const existingIndexVersion = managedIndexVersion(previousPublication);
      return {
        status: "already_published",
        sourceId: checkpoint.source.id,
        observationId,
        ...(existingIndexVersion === undefined
          ? {}
          : { indexVersion: existingIndexVersion }),
        publication: previousPublication,
        diagnostics: operation.diagnostics,
      };
    }

    const previousSemanticUnits = checkpointSemanticUnits(checkpoint);
    let recoveryIntent = input.recoveryIntent;
    let publicationId = recoveryIntent?.publication.publicationId;
    const nextPublicationId = (): string => {
      publicationId ??= this.#dependencies.ids.nextPublicationId();
      return publicationId;
    };
    const buildIndexedPublication = (
      indexPublication: PreparedReindexDocumentPublication,
    ): IngestionPublication =>
      buildMarkdownPublication({
        publicationId: nextPublicationId(),
        document,
        semanticUnits,
        manifest: indexPublication.publication.manifest,
        scopes: indexPublication.publication.scopes,
        ...(previousPublication === undefined
          ? {}
          : { previous: previousPublication }),
        ...(previousSemanticUnits === undefined
          ? {}
          : { previousSemanticUnits }),
        inheritableUnitIds: indexPublication.inheritableUnitIds,
      });

    const indexed =
      chunks.length === 0
        ? undefined
        : await operation.run("index_update", () =>
            this.#dependencies.documentReindexer.reindex({
              stateNamespaceId: this.#dependencies.stateNamespaceId,
              connectorId: command.connectorId,
              securityDomain: command.securityDomain,
              ...(checkpoint.indexingSnapshot === undefined
                ? {}
                : { previous: checkpoint.indexingSnapshot }),
              current: currentSnapshot,
              semanticScopes: semanticUnits
                .filter((unit) => unit.kind !== "document")
                .map((unit) => ({ semanticUnitIds: [unit.id] })),
              ...(recoveryIntent === undefined
                ? {}
                : { publishedAt: recoveryIntent.publication.producedAt }),
              beforeCatalogCommit: async (prepared) => {
                const result =
                  await this.#dependencies.publications.prepareRecoveryIntent(
                    buildIndexedPublication(prepared),
                  );
                recoveryIntent = result.intent;
              },
              ...(command.signal === undefined
                ? {}
                : { signal: command.signal }),
            }),
          );
    if (indexed === undefined) {
      operation.markSkipped(["index_update"], "empty_document");
    } else {
      operation.bind({ indexVersion: indexed.publication.manifest.indexVersion });
    }
    const indexingSnapshot: DocumentIndexingSnapshot = {
      ...currentSnapshot,
      chunks: indexed?.plan.chunks ?? currentSnapshot.chunks,
    };

    const committed = await operation.run("ingestion_publication", async () => {
      const candidate =
        indexed === undefined
          ? buildEmptyMarkdownPublication({
              publicationId: nextPublicationId(),
              document,
              producedAt:
                recoveryIntent?.publication.producedAt ?? this.#clock(),
              ...(previousPublication === undefined
                ? {}
                : { previous: previousPublication }),
            })
          : buildIndexedPublication({
              publication: indexed.publication,
              inheritableUnitIds: indexed.inheritableUnitIds,
            });
      if (indexed !== undefined && recoveryIntent === undefined) {
        throw new StageFault("publication_commit_incomplete");
      }
      const prepared =
        await this.#dependencies.publications.prepareRecoveryIntent(candidate);
      recoveryIntent = prepared.intent;
      const result = await this.#dependencies.publications.commitReady(
        recoveryIntent.publication,
      );
      await this.#dependencies.checkpoints.save({
        source: checkpoint.source,
        documentId: checkpoint.documentId,
        observationId,
        previousChangeToken: changeToken,
        indexingSnapshot,
      });
      await this.#dependencies.observations.markComparisonBaseline({
        sourceId: checkpoint.source.id,
        observationId,
        ...(checkpoint.observationId === undefined
          ? {}
          : { expectedObservationId: checkpoint.observationId }),
      });
      return result;
    });
    return {
      status: committed.status,
      sourceId: checkpoint.source.id,
      observationId,
      ...(indexed === undefined
        ? {}
        : { indexVersion: indexed.publication.manifest.indexVersion }),
      publication: committed.publication,
      diagnostics: operation.diagnostics,
    };
  }

  async #ensureComparisonBaseline(
    checkpoint: MarkdownPublicationCheckpoint,
  ): Promise<void> {
    if (checkpoint.observationId === undefined) return;
    const baseline = await this.#dependencies.observations.find(
      checkpoint.observationId,
    );
    if (
      baseline?.sourceId !== checkpoint.source.id ||
      !isMarkdownSourceSnapshot(baseline.payload)
    ) {
      throw new StageFault("observation_baseline_corrupt");
    }
    const current = await this.#dependencies.observations.comparisonForSource(
      checkpoint.source.id,
    );
    if (current?.id !== baseline.id) {
      const persisted = await this.#dependencies.checkpoints.findBySourceId(
        checkpoint.source.id,
      );
      if (persisted?.observationId !== checkpoint.observationId) {
        throw new StageFault("observation_baseline_stale");
      }
      await this.#dependencies.observations.markComparisonBaseline({
        sourceId: checkpoint.source.id,
        observationId: baseline.id,
        ...(current === undefined
          ? {}
          : { expectedObservationId: current.id }),
      });
    }
  }
}

function assertDocumentCaptureAvailable(
  source: MarkdownPublicationCheckpoint["source"],
): void {
  if (
    source.inspectionStatus.state !== "ready" ||
    !source.inspectionStatus.capabilities.some(
      (capability) =>
        capability.name === "document_capture" &&
        capability.status === "available",
    )
  ) {
    throw new StageFault("document_capture_unavailable");
  }
}

function reconcileUnits(
  checkpoint: MarkdownPublicationCheckpoint,
  document: NormalizedDocument,
  provisionalUnits: readonly DocumentSemanticUnit[],
  policy: DocumentIndexingPolicySet,
): readonly DocumentSemanticUnit[] {
  const previousDocument = checkpointDocument(checkpoint);
  const previousUnits = checkpointSemanticUnits(checkpoint);
  if (
    previousDocument === undefined ||
    previousUnits === undefined
  ) {
    return provisionalUnits;
  }
  return reconcileSemanticUnitLineage({
    previousDocument,
    previousUnits,
    currentDocument: document,
    currentUnits: provisionalUnits,
    policy,
  }).units;
}

function checkpointDocument(checkpoint: MarkdownPublicationCheckpoint) {
  return checkpoint.indexingSnapshot?.document ?? checkpoint.document;
}

function checkpointSemanticUnits(checkpoint: MarkdownPublicationCheckpoint) {
  return checkpoint.indexingSnapshot?.semanticUnits ?? checkpoint.semanticUnits;
}

function recoverCommittedSnapshot(
  previous: DocumentIndexingSnapshot | undefined,
  current: DocumentIndexingSnapshot,
): DocumentIndexingSnapshot {
  if (previous === undefined) return current;
  return {
    ...current,
    chunks: planDocumentIncrementalUpdate({ previous, current }).chunks,
  };
}

function managedIndexVersion(
  publication: IngestionPublication,
): string | undefined {
  for (const unit of publication.knowledgeUnits) {
    for (const scope of unit.publishedScopes) {
      if (scope.kind === "managed_document") {
        return scope.documentIndex.indexVersion;
      }
    }
  }
  return undefined;
}

function recoverPendingIndexingSnapshot(input: {
  readonly checkpoint: MarkdownPublicationCheckpoint;
  readonly observationId: string;
  readonly snapshot: MarkdownSourceSnapshot;
  readonly policy: DocumentIndexingPolicySet;
  readonly embeddingProfile: EmbeddingProfile;
}): DocumentIndexingSnapshot | undefined {
  const pending = input.checkpoint.pendingIndexingSnapshot;
  if (pending === undefined) return undefined;
  try {
    assertValidDocumentIndexingSnapshot(pending, "previous");
  } catch {
    throw new StageFault("pending_structural_snapshot_corrupt");
  }
  if (
    pending.document.sourceId !== input.checkpoint.source.id ||
    pending.document.documentId !== input.checkpoint.documentId ||
    pending.document.observationId !== input.observationId ||
    pending.document.contentDigest !== input.snapshot.contentDigest ||
    canonicalJson(pending.indexingPolicy) !== canonicalJson(input.policy) ||
    !embeddingProfilesMatch(
      pending.embeddingProfile,
      input.embeddingProfile,
    )
  ) {
    throw new StageFault("pending_structural_snapshot_conflict");
  }
  return pending;
}

class StageFault extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "StageFault";
  }
}

class OperationContext {
  readonly diagnostics: MarkdownPublicationDiagnostic[] = [];
  readonly #binding: {
    sourceId?: string;
    observationId?: string;
    indexVersion?: string;
  } = {};

  constructor(
    readonly operationId: string,
    private readonly events: MarkdownPublicationEventSink,
    private readonly clock: () => string,
  ) {}

  bind(binding: {
    readonly sourceId?: string;
    readonly observationId?: string;
    readonly indexVersion?: string;
  }): void {
    Object.assign(this.#binding, binding);
  }

  async run<T>(stage: MarkdownPublicationStage, task: () => T | Promise<T>): Promise<T> {
    this.#record(stage, "started");
    try {
      const result = await task();
      this.diagnostics.push({ stage, status: "completed" });
      this.#record(stage, "completed");
      return result;
    } catch (error) {
      throw this.failure(stage, safeDiagnosticCode(error));
    }
  }

  markSkipped(stages: readonly MarkdownPublicationStage[], code: string): void {
    for (const stage of stages) {
      this.diagnostics.push({ stage, status: "skipped", code });
      this.#record(stage, "skipped", code);
    }
  }

  failure(
    stage: MarkdownPublicationStage,
    diagnosticCode: string,
  ): MarkdownPublicationWorkflowError {
    this.diagnostics.push({ stage, status: "failed", code: diagnosticCode });
    this.#record(stage, "failed", diagnosticCode);
    return new MarkdownPublicationWorkflowError(
      "stage_failed",
      stage,
      diagnosticCode,
      [...this.diagnostics],
    );
  }

  #record(
    stage: MarkdownPublicationStage,
    status: MarkdownPublicationStageStatus,
    diagnosticCode?: string,
  ): void {
    const event: MarkdownPublicationStageEvent = {
      occurredAt: this.clock(),
      operationId: this.operationId,
      stage,
      status,
      ...this.#binding,
      ...(diagnosticCode === undefined ? {} : { diagnosticCode }),
    };
    this.events.record(event);
  }
}

function safeDiagnosticCode(error: unknown): string {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[a-z][a-z0-9_]*$/.test(error.code)
  ) {
    return error.code;
  }
  return "unexpected_failure";
}

function isMarkdownSourceSnapshot(
  value: unknown,
): value is MarkdownSourceSnapshot {
  return (
    value !== null &&
    typeof value === "object" &&
    "kind" in value &&
    value.kind === "markdown" &&
    "targetKey" in value &&
    typeof value.targetKey === "string" &&
    "capturedAt" in value &&
    typeof value.capturedAt === "string" &&
    "content" in value &&
    typeof value.content === "string" &&
    "contentDigest" in value &&
    typeof value.contentDigest === "string"
  );
}
