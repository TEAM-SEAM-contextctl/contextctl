import { z } from "zod";

import {
  canonicalContractByteLength,
  canonicalContractJson,
  ContractValidationError,
  parseContract,
  validateSortedUnique,
} from "../contract-validation.js";
import {
  CanonicalTimestampSchema,
  ContentDigestSchema,
  KnowledgeUnitIdSchema,
  ObservationIdSchema,
  PublicationIdSchema,
  SourceIdSchema,
} from "../identifiers.js";
import {
  PublishedKnowledgeUnitSchema,
  type PublishedKnowledgeUnit,
} from "./published-knowledge-unit.js";
import type { PublishedScope } from "./publication-scope.js";

export const INGESTION_PUBLICATION_SCHEMA_VERSION = 2;
export const MAX_PUBLICATION_BYTES = 16 * 1_024 * 1_024;
export const MAX_PUBLICATION_UNITS = 10_000;
export const MAX_PUBLICATION_CHANGES = 10_000;

export const PublishedChangedFieldSchema = z.enum([
  "facts",
  "kind",
  "provenance",
  "published.scopes",
  "source.coordinate",
]);

const AddedChangeSchema = z
  .object({
    kind: z.literal("added"),
    knowledgeUnitId: KnowledgeUnitIdSchema,
    currentContentDigest: ContentDigestSchema,
  })
  .strict();

const UpdatedChangeSchema = z
  .object({
    kind: z.literal("updated"),
    knowledgeUnitId: KnowledgeUnitIdSchema,
    previousContentDigest: ContentDigestSchema,
    currentContentDigest: ContentDigestSchema,
    changedFields: z.array(PublishedChangedFieldSchema).min(1).max(5),
  })
  .strict()
  .superRefine((change, context) => {
    validateSortedUnique(change.changedFields, "changed fields", context);
    if (change.previousContentDigest === change.currentContentDigest) {
      context.addIssue({
        code: "custom",
        path: ["currentContentDigest"],
        message: "updated knowledge must have a new content digest",
      });
    }
  });

const RemovedChangeSchema = z
  .object({
    kind: z.literal("removed"),
    knowledgeUnitId: KnowledgeUnitIdSchema,
    previousContentDigest: ContentDigestSchema,
  })
  .strict();

export const PublishedChangeSchema = z.discriminatedUnion("kind", [
  AddedChangeSchema,
  UpdatedChangeSchema,
  RemovedChangeSchema,
]);

/** Immutable Ingestion-to-Registry lifecycle handoff. */
export const IngestionPublicationSchema = z
  .object({
    schemaVersion: z.literal(INGESTION_PUBLICATION_SCHEMA_VERSION),
    publicationId: PublicationIdSchema,
    sourceId: SourceIdSchema,
    observationId: ObservationIdSchema,
    previousPublicationId: PublicationIdSchema.optional(),
    producedAt: CanonicalTimestampSchema,
    knowledgeUnits: z.array(PublishedKnowledgeUnitSchema).max(MAX_PUBLICATION_UNITS),
    changes: z.array(PublishedChangeSchema).max(MAX_PUBLICATION_CHANGES),
  })
  .strict()
  .superRefine(validatePublication);

export type PublishedChangedField = z.infer<typeof PublishedChangedFieldSchema>;
export type PublishedChange = z.infer<typeof PublishedChangeSchema>;
export type IngestionPublication = z.infer<typeof IngestionPublicationSchema>;

export function parseIngestionPublication(input: unknown): IngestionPublication {
  return parseContract(
    "IngestionPublication",
    IngestionPublicationSchema,
    normalizeRootArrays(input),
  );
}

function normalizeRootArrays(input: unknown): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }
  const record = input as Readonly<Record<string, unknown>>;
  return {
    ...record,
    ...(Array.isArray(record.knowledgeUnits)
      ? {
          knowledgeUnits: [...record.knowledgeUnits].sort((left, right) =>
            compareRecordKey(left, right, "id"),
          ),
        }
      : {}),
    ...(Array.isArray(record.changes)
      ? {
          changes: [...record.changes].sort((left, right) =>
            compareRecordKey(left, right, "knowledgeUnitId"),
          ),
        }
      : {}),
  };
}

function compareRecordKey(
  left: unknown,
  right: unknown,
  key: string,
): number {
  const leftValue = recordString(left, key);
  const rightValue = recordString(right, key);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function recordString(value: unknown, key: string): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  const candidate = (value as Readonly<Record<string, unknown>>)[key];
  return typeof candidate === "string" ? candidate : "";
}

/** Independently verifies the declared delta against the exact predecessor. */
export function assertIngestionPublicationTransition(
  previous: IngestionPublication | undefined,
  current: IngestionPublication,
): void {
  const messages: string[] = [];
  if (previous === undefined) {
    if (current.previousPublicationId !== undefined) {
      messages.push("initial publication must not declare a predecessor");
    }
  } else {
    if (current.previousPublicationId !== previous.publicationId) {
      messages.push("publication predecessor does not match the source head");
    }
    if (current.sourceId !== previous.sourceId) {
      messages.push("publication predecessor belongs to another source");
    }
  }

  const expected = computePublicationChanges(previous, current.knowledgeUnits);
  if (canonicalContractJson(expected) !== canonicalContractJson(current.changes)) {
    messages.push("publication changes do not match the exact predecessor delta");
  }
  if (previous !== undefined) {
    const previousById = new Map(previous.knowledgeUnits.map((unit) => [unit.id, unit]));
    const changedIds = new Set(current.changes.map((change) => change.knowledgeUnitId));
    for (const unit of current.knowledgeUnits) {
      const prior = previousById.get(unit.id);
      if (
        prior !== undefined &&
        !changedIds.has(unit.id) &&
        canonicalContractJson(prior) !== canonicalContractJson(unit)
      ) {
        messages.push(`unchanged knowledge unit ${unit.id} must be byte-identical`);
      }
    }
  }
  if (messages.length > 0) {
    throw new ContractValidationError(
      "IngestionPublicationTransition",
      messages.map((message) => ({ code: "custom", path: ["changes"], message })),
    );
  }
}

export function computePublicationChanges(
  previous: IngestionPublication | undefined,
  current: readonly PublishedKnowledgeUnit[],
): readonly PublishedChange[] {
  if (previous === undefined) {
    return current.map((unit) => ({
      kind: "added" as const,
      knowledgeUnitId: unit.id,
      currentContentDigest: unit.contentDigest,
    }));
  }
  const previousById = new Map(previous.knowledgeUnits.map((unit) => [unit.id, unit]));
  const currentIds = new Set(current.map((unit) => unit.id));
  const changes: PublishedChange[] = [];
  for (const unit of current) {
    const prior = previousById.get(unit.id);
    if (prior === undefined) {
      changes.push({
        kind: "added",
        knowledgeUnitId: unit.id,
        currentContentDigest: unit.contentDigest,
      });
      continue;
    }
    const changedFields = changedKnowledgeUnitFields(prior, unit);
    if (changedFields.length > 0) {
      changes.push({
        kind: "updated",
        knowledgeUnitId: unit.id,
        previousContentDigest: prior.contentDigest,
        currentContentDigest: unit.contentDigest,
        changedFields: [...changedFields],
      });
    }
  }
  for (const unit of previous.knowledgeUnits) {
    if (!currentIds.has(unit.id)) {
      changes.push({
        kind: "removed",
        knowledgeUnitId: unit.id,
        previousContentDigest: unit.contentDigest,
      });
    }
  }
  return changes.sort((left, right) =>
    left.knowledgeUnitId < right.knowledgeUnitId ? -1 : left.knowledgeUnitId > right.knowledgeUnitId ? 1 : 0,
  );
}

export function changedKnowledgeUnitFields(
  previous: PublishedKnowledgeUnit,
  current: PublishedKnowledgeUnit,
): readonly PublishedChangedField[] {
  const fields: ReadonlyArray<readonly [PublishedChangedField, unknown, unknown]> = [
    ["facts", previous.facts, current.facts],
    ["kind", previous.kind, current.kind],
    ["provenance", previous.provenance, current.provenance],
    ["published.scopes", previous.publishedScopes, current.publishedScopes],
    ["source.coordinate", previous.sourceCoordinate, current.sourceCoordinate],
  ];
  return fields
    .filter(([, left, right]) => canonicalContractJson(left) !== canonicalContractJson(right))
    .map(([name]) => name)
    .sort();
}

function validatePublication(
  publication: z.infer<typeof IngestionPublicationSchema>,
  context: z.RefinementCtx,
): void {
  if (canonicalContractByteLength(publication) > MAX_PUBLICATION_BYTES) {
    context.addIssue({ code: "custom", message: "publication exceeds the 16 MiB canonical limit" });
  }
  if (publication.previousPublicationId === publication.publicationId) {
    context.addIssue({ code: "custom", path: ["previousPublicationId"], message: "publication cannot reference itself" });
  }
  validateSortedUnique(publication.knowledgeUnits.map((unit) => unit.id), "knowledge units", context);
  validateSortedUnique(publication.changes.map((change) => change.knowledgeUnitId), "publication changes", context);

  const units = new Map(publication.knowledgeUnits.map((unit) => [unit.id, unit]));
  const documentUnits = new Map<string, string>();
  const scopeDefinitions = new Map<string, string>();
  const changes = new Map(publication.changes.map((change) => [change.knowledgeUnitId, change]));

  publication.knowledgeUnits.forEach((unit, unitIndex) => {
    if (unit.sourceCoordinate.sourceId !== publication.sourceId) {
      addIssue(context, ["knowledgeUnits", unitIndex, "sourceCoordinate", "sourceId"], "knowledge unit must belong to the publication source");
    }
    const change = changes.get(unit.id);
    if (
      (publication.previousPublicationId === undefined || change?.kind === "added" || change?.kind === "updated") &&
      unit.provenance.observationId !== publication.observationId
    ) {
      addIssue(context, ["knowledgeUnits", unitIndex, "provenance", "observationId"], "new or changed knowledge must use the current observation");
    }
    if (unit.sourceCoordinate.kind === "document") {
      if (unit.id !== unit.sourceCoordinate.semanticUnitId) {
        addIssue(context, ["knowledgeUnits", unitIndex, "sourceCoordinate", "semanticUnitId"], "document unit identity must match its semantic coordinate");
      }
      if (documentUnits.has(unit.sourceCoordinate.semanticUnitId)) {
        addIssue(context, ["knowledgeUnits", unitIndex, "sourceCoordinate", "semanticUnitId"], "semantic unit coordinate must be unique");
      }
      documentUnits.set(unit.sourceCoordinate.semanticUnitId, unit.sourceCoordinate.documentId);
    }
    validateCoordinateKind(unit, unitIndex, context);
  });

  publication.knowledgeUnits.forEach((unit, unitIndex) => {
    unit.publishedScopes.forEach((scope, scopeIndex) => {
      validateScopeCoordinate(publication.sourceId, unit, scope, unitIndex, scopeIndex, documentUnits, context);
      const reference = `${scope.scopeId}\u0000${scope.scopeVersion}`;
      const definition = canonicalContractJson(scope);
      const prior = scopeDefinitions.get(reference);
      if (prior !== undefined && prior !== definition) {
        addIssue(context, ["knowledgeUnits", unitIndex, "publishedScopes", scopeIndex], "the same scope revision must have one immutable definition");
      }
      scopeDefinitions.set(reference, definition);
    });
  });
  validateDeclaredChanges(publication, units, context);
}

function validateCoordinateKind(unit: PublishedKnowledgeUnit, index: number, context: z.RefinementCtx): void {
  const valid =
    (["document", "section", "segment"].includes(unit.kind) && unit.sourceCoordinate.kind === "document") ||
    (unit.kind === "table" && unit.sourceCoordinate.kind === "sql_table") ||
    (unit.kind === "operation" && unit.sourceCoordinate.kind === "http_operation");
  if (!valid) addIssue(context, ["knowledgeUnits", index, "sourceCoordinate", "kind"], "knowledge unit kind and source coordinate are incompatible");
}

function validateScopeCoordinate(
  sourceId: string,
  unit: PublishedKnowledgeUnit,
  scope: PublishedScope,
  unitIndex: number,
  scopeIndex: number,
  documentUnits: ReadonlyMap<string, string>,
  context: z.RefinementCtx,
): void {
  const path = ["knowledgeUnits", unitIndex, "publishedScopes", scopeIndex];
  const coordinate = unit.sourceCoordinate;
  if (coordinate.kind === "document" && scope.kind === "managed_document") {
    if (scope.documentIndex.sourceId !== sourceId || scope.documentIndex.documentId !== coordinate.documentId) addIssue(context, path, "document scope must use the unit source and document");
    if (scope.selector.kind === "semantic_units") {
      if (!scope.selector.semanticUnitIds.includes(coordinate.semanticUnitId)) addIssue(context, [...path, "selector"], "semantic scope must include the unit coordinate");
      if (scope.selector.semanticUnitIds.some((id) => documentUnits.get(id) !== coordinate.documentId)) addIssue(context, [...path, "selector"], "semantic scope may reference only units from the same document");
    }
    return;
  }
  if (coordinate.kind === "sql_table" && scope.kind === "sql_source") {
    if (scope.schema !== coordinate.schema || scope.table !== coordinate.table || scope.columns.some((column) => !coordinate.columns.includes(column))) addIssue(context, path, "SQL scope must be a subset of the exact coordinate");
    return;
  }
  if (coordinate.kind === "http_operation" && scope.kind === "http_source") {
    if (scope.method !== coordinate.method || scope.path !== coordinate.path || scope.operationId !== coordinate.operationId || canonicalContractJson(scope.parameters) !== canonicalContractJson(coordinate.parameters)) addIssue(context, path, "HTTP scope must match the exact operation coordinate");
    return;
  }
  addIssue(context, [...path, "kind"], "scope kind and source coordinate are incompatible");
}

function validateDeclaredChanges(
  publication: IngestionPublication,
  units: ReadonlyMap<string, PublishedKnowledgeUnit>,
  context: z.RefinementCtx,
): void {
  const added = new Set<string>();
  publication.changes.forEach((change, index) => {
    const current = units.get(change.knowledgeUnitId);
    if (publication.previousPublicationId === undefined && change.kind !== "added") addIssue(context, ["changes", index, "kind"], "initial publication may contain only added changes");
    if (change.kind === "added") added.add(change.knowledgeUnitId);
    if (change.kind === "removed" && current !== undefined) addIssue(context, ["changes", index], "removed knowledge must not appear in current units");
    if (change.kind !== "removed" && current === undefined) addIssue(context, ["changes", index], "added or updated knowledge must appear in current units");
    if (change.kind !== "removed" && current?.contentDigest !== change.currentContentDigest) addIssue(context, ["changes", index, "currentContentDigest"], "change digest must match current knowledge");
  });
  if (publication.previousPublicationId === undefined) {
    for (const unit of units.values()) if (!added.has(unit.id)) addIssue(context, ["changes"], `initial knowledge unit ${unit.id} requires an added change`);
  }
}

function addIssue(context: z.RefinementCtx, path: PropertyKey[], message: string): void {
  context.addIssue({ code: "custom", path, message });
}
