import type { IngestionPublicationV2 as IngestionPublication } from "@contextctl/contracts";

import {
  buildEmptyMarkdownPublication,
  buildMarkdownPublication,
} from "./build-markdown-publication.js";
import type { CaptureMarkdownCommand } from "./markdown-capture.js";
import type { IncrementalDocumentReindexer } from "./reindex-document-incrementally.js";
import type {
  RegisterSourceCommand,
  SourceManagement,
} from "./source-management.js";
import {
  DEFAULT_DOCUMENT_INDEXING_POLICY,
  type DocumentIndexingPolicySet,
} from "../domain/document-indexing-policy.js";
import {
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
import type { EmbeddingProfile } from "../domain/embedding-profile.js";
import {
  generateManagedChunks,
  type ManagedChunkIdSource,
} from "../domain/managed-chunk-generation.js";
import { reconcileSemanticUnitLineage } from "../domain/semantic-unit-lineage.js";
import { stableIdentity } from "../domain/revision-identity.js";
import type { MarkdownSourceSnapshot } from "../ports/document-capture.js";
import type {
  IngestionPublicationStore,
  MarkdownPublicationCheckpoint,
  MarkdownPublicationCheckpointStore,
  MarkdownPublicationEventSink,
  MarkdownPublicationStage,
  MarkdownPublicationStageEvent,
  MarkdownPublicationStageStatus,
  PublicationReadyNotifier,
} from "../ports/markdown-publication.js";

const DOWNSTREAM_STAGES: readonly MarkdownPublicationStage[] = [
  "capture",
  "segmentation",
  "chunking",
  "index_update",
  "ingestion_publication",
  "ready_notification",
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
  readonly checkpoints: MarkdownPublicationCheckpointStore;
  readonly captureMarkdown: (
    command: CaptureMarkdownCommand,
  ) => NormalizedDocument;
  readonly documentReindexer: IncrementalDocumentReindexer;
  readonly publications: IngestionPublicationStore;
  readonly readyNotifier: PublicationReadyNotifier;
  readonly events: MarkdownPublicationEventSink;
  readonly embeddingProfile: EmbeddingProfile;
  /** Stable identity of the durable daemon state this workflow belongs to. */
  readonly stateNamespaceId: string;
  /** One workflow instance is bound to exactly one provider security domain. */
  readonly securityDomain: string;
  readonly indexingPolicy?: DocumentIndexingPolicySet;
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
    await this.#flushPendingReady(operation);

    const registration = await operation.run("registration", async () => {
      const candidate = await this.#dependencies.sourceManagement.register(
        command.source,
      );
      return this.#dependencies.checkpoints.register(
        candidate,
        stableIdentity("doc", {
          sourceId: candidate.id,
          targetKey: candidate.targetKey,
        }),
      );
    });
    let checkpoint = registration.checkpoint;
    operation.bind({ sourceId: checkpoint.source.id });

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
      return { result, latest };
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
    if (!isMarkdownSourceSnapshot(observation.attempt.payload)) {
      throw operation.failure("capture", "invalid_markdown_snapshot");
    }
    const snapshot = observation.attempt.payload;
    const changeToken = observation.attempt.changeSignal.token;

    const observationId = stableIdentity("obs", {
      sourceId: checkpoint.source.id,
      changeToken,
    });
    operation.bind({ observationId });
    const previousDocument = checkpointDocument(checkpoint);
    const document = await operation.run("capture", () =>
      this.#dependencies.captureMarkdown({
        source: checkpoint.source,
        observationId,
        documentId: checkpoint.documentId,
        snapshot,
        ...(previousDocument === undefined
          ? {}
          : { previousDocument }),
      }),
    );
    const provisionalUnits = await operation.run("segmentation", () =>
      segmentNormalizedDocument({
        document,
        ids: new StableUnitIdSource(observationId),
        policy: this.#policy,
      }),
    );
    const semanticUnits = reconcileUnits(
      checkpoint,
      document,
      provisionalUnits,
      this.#policy,
    );
    const chunks = await operation.run("chunking", () =>
      generateManagedChunks({
        document,
        semanticUnits,
        ids: new StableChunkIdSource(observationId),
        policy: this.#policy,
      }),
    );
    const currentSnapshot: DocumentIndexingSnapshot = {
      document,
      semanticUnits,
      chunks,
      indexingPolicy: this.#policy,
      embeddingProfile: this.#dependencies.embeddingProfile,
      payloadSchemaVersion: 2,
    };
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
      await operation.run("ingestion_publication", () =>
        this.#dependencies.checkpoints.save({
          source: checkpoint.source,
          documentId: checkpoint.documentId,
          previousChangeToken: changeToken,
          indexingSnapshot: recoveredSnapshot,
        }),
      );
      await this.#flushPendingReady(operation);
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
    const previousSemanticUnits = checkpointSemanticUnits(checkpoint);

    const committed = await operation.run("ingestion_publication", async () => {
      const publication =
        indexed === undefined
          ? buildEmptyMarkdownPublication({
              document,
              producedAt: this.#clock(),
              ...(previousPublication === undefined
                ? {}
                : { previous: previousPublication }),
            })
          : buildMarkdownPublication({
              document,
              semanticUnits,
              manifest: indexed.publication.manifest,
              scopes: indexed.publication.scopes,
              ...(previousPublication === undefined
                ? {}
                : { previous: previousPublication }),
              ...(previousSemanticUnits === undefined
                ? {}
                : { previousSemanticUnits }),
              inheritableUnitIds: indexed.inheritableUnitIds,
            });
      const result = await this.#dependencies.publications.commitReady(
        publication,
      );
      await this.#dependencies.checkpoints.save({
        source: checkpoint.source,
        documentId: checkpoint.documentId,
        previousChangeToken: changeToken,
        indexingSnapshot,
      });
      return result;
    });
    await this.#flushPendingReady(operation);
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

  async #flushPendingReady(operation: OperationContext): Promise<void> {
    let pending;
    try {
      pending = await this.#dependencies.publications.pendingReady();
    } catch (error) {
      throw operation.failure(
        "ready_notification",
        safeDiagnosticCode(error),
      );
    }
    for (const notification of pending) {
      await operation.run("ready_notification", async () => {
        await this.#dependencies.readyNotifier.notify(notification);
        await this.#dependencies.publications.markReadyNotified(
          notification.publicationId,
        );
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

class StableUnitIdSource implements SemanticUnitIdSource {
  #next = 0;
  constructor(private readonly seed: string) {}
  nextUnitId(): string {
    return stableIdentity("unit", { seed: this.seed, ordinal: this.#next++ });
  }
}

class StableChunkIdSource implements ManagedChunkIdSource {
  #next = 0;
  constructor(private readonly seed: string) {}
  nextChunkId(): string {
    return stableIdentity("chk", { seed: this.seed, ordinal: this.#next++ });
  }
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
