import { z } from "zod";

import {
  MachineNameSchema,
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

const ContractSchemaVersion = z.literal(1);

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
    changedFields: z.array(MachineNameSchema).min(1),
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

/**
 * Immutable handoff produced by Ingestion for Registry after one successful
 * source observation. Registry translates it into its own lifecycle model.
 */
export const IngestionPublicationSchema = z
  .object({
    schemaVersion: ContractSchemaVersion,
    publicationId: PublicationIdSchema,
    sourceId: SourceIdSchema,
    observationId: ObservationIdSchema,
    previousPublicationId: PublicationIdSchema.optional(),
    producedAt: CanonicalTimestampSchema,
    knowledgeUnits: z.array(PublishedKnowledgeUnitSchema),
    changes: z.array(PublishedChangeSchema),
  })
  .strict()
  .superRefine((publication, context) => {
    validatePublication(publication, context);
  });

export type PublishedChange = z.infer<typeof PublishedChangeSchema>;
export type IngestionPublication = z.infer<
  typeof IngestionPublicationSchema
>;

/** Parses untrusted input into the strict Ingestion-to-Registry contract. */
export function parseIngestionPublication(
  input: unknown,
): IngestionPublication {
  return parseContract(
    "IngestionPublication",
    IngestionPublicationSchema,
    input,
  );
}

function validatePublication(
  publication: z.infer<typeof IngestionPublicationSchema>,
  context: z.RefinementCtx,
): void {
  if (publication.previousPublicationId === publication.publicationId) {
    context.addIssue({
      code: "custom",
      path: ["previousPublicationId"],
      message: "publication cannot reference itself as previous",
    });
  }

  const units = new Map<string, (typeof publication.knowledgeUnits)[number]>();
  const documentUnits = new Map<string, string>();
  const scopeDefinitions = new Map<string, string>();

  publication.knowledgeUnits.forEach((unit, unitIndex) => {
    if (units.has(unit.id)) {
      context.addIssue({
        code: "custom",
        path: ["knowledgeUnits", unitIndex, "id"],
        message: "knowledge unit ID must be unique",
      });
    }
    units.set(unit.id, unit);
    if (unit.sourceCoordinate.kind === "document") {
      const previousDocumentId = documentUnits.get(
        unit.sourceCoordinate.semanticUnitId,
      );
      if (previousDocumentId !== undefined) {
        context.addIssue({
          code: "custom",
          path: [
            "knowledgeUnits",
            unitIndex,
            "sourceCoordinate",
            "semanticUnitId",
          ],
          message:
            "semantic unit coordinate must be unique within the publication",
        });
      } else {
        documentUnits.set(
          unit.sourceCoordinate.semanticUnitId,
          unit.sourceCoordinate.documentId,
        );
      }
    }

    if (
      unit.sourceCoordinate.sourceId !== publication.sourceId ||
      unit.provenance.observationId !== publication.observationId
    ) {
      context.addIssue({
        code: "custom",
        path: ["knowledgeUnits", unitIndex],
        message: "knowledge unit must belong to the publication snapshot",
      });
    }

    validateCoordinateKind(unit, unitIndex, context);
  });

  publication.knowledgeUnits.forEach((unit, unitIndex) => {
    unit.publishedScopes.forEach((scope, scopeIndex) => {
      validateScopeCoordinate(
        publication.sourceId,
        unit,
        scope,
        unitIndex,
        scopeIndex,
        documentUnits,
        context,
      );

      const reference = `${scope.scopeId}:${scope.scopeVersion}`;
      const definition = JSON.stringify(scope);
      const previousDefinition = scopeDefinitions.get(reference);
      if (
        previousDefinition !== undefined &&
        previousDefinition !== definition
      ) {
        context.addIssue({
          code: "custom",
          path: ["knowledgeUnits", unitIndex, "publishedScopes", scopeIndex],
          message: "the same scope revision must have one immutable definition",
        });
      }
      scopeDefinitions.set(reference, definition);
    });
  });

  validateChanges(publication, units, context);
}

function validateCoordinateKind(
  unit: PublishedKnowledgeUnit,
  unitIndex: number,
  context: z.RefinementCtx,
): void {
  const coordinateKind = unit.sourceCoordinate.kind;
  const valid =
    ((unit.kind === "document" || unit.kind === "section") &&
      coordinateKind === "document") ||
    (unit.kind === "table" && coordinateKind === "sql_table") ||
    (unit.kind === "operation" && coordinateKind === "http_operation");

  if (!valid) {
    context.addIssue({
      code: "custom",
      path: ["knowledgeUnits", unitIndex, "sourceCoordinate", "kind"],
      message: `knowledge unit kind ${unit.kind} is incompatible with ${coordinateKind} coordinate`,
    });
  }
}

function validateScopeCoordinate(
  publicationSourceId: string,
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
    if (scope.documentIndex.sourceId !== publicationSourceId) {
      addScopeIssue(
        context,
        [...path, "documentIndex", "sourceId"],
        "document index must belong to the publication source",
      );
    }
    if (scope.documentIndex.documentId !== coordinate.documentId) {
      addScopeIssue(
        context,
        [...path, "documentIndex", "documentId"],
        "document scope must use the knowledge unit document",
      );
    }
    if (scope.selector.kind === "semantic_units") {
      if (!scope.selector.semanticUnitIds.includes(coordinate.semanticUnitId)) {
        addScopeIssue(
          context,
          [...path, "selector", "semanticUnitIds"],
          "semantic scope must include the knowledge unit coordinate",
        );
      }
      scope.selector.semanticUnitIds.forEach((semanticUnitId, selectorIndex) => {
        if (documentUnits.get(semanticUnitId) !== coordinate.documentId) {
          addScopeIssue(
            context,
            [...path, "selector", "semanticUnitIds", selectorIndex],
            "semantic scope may reference only published units from the same document",
          );
        }
      });
    }
    return;
  }

  if (coordinate.kind === "sql_table" && scope.kind === "sql_source") {
    if (scope.table !== coordinate.table) {
      addScopeIssue(
        context,
        [...path, "table"],
        "SQL scope must use the knowledge unit table",
      );
    }
    scope.columns.forEach((column, columnIndex) => {
      if (!coordinate.columns.includes(column)) {
        addScopeIssue(
          context,
          [...path, "columns", columnIndex],
          "SQL scope column must exist in the knowledge unit coordinate",
        );
      }
    });
    return;
  }

  if (coordinate.kind === "http_operation" && scope.kind === "http_source") {
    if (scope.method !== coordinate.method || scope.path !== coordinate.path) {
      addScopeIssue(
        context,
        path,
        "HTTP scope must use the knowledge unit method and path",
      );
    }
    return;
  }

  addScopeIssue(
    context,
    [...path, "kind"],
    `scope kind ${scope.kind} is incompatible with ${coordinate.kind} coordinate`,
  );
}

function addScopeIssue(
  context: z.RefinementCtx,
  path: PropertyKey[],
  message: string,
): void {
  context.addIssue({ code: "custom", path, message });
}

function validateChanges(
  publication: z.infer<typeof IngestionPublicationSchema>,
  units: ReadonlyMap<string, (typeof publication.knowledgeUnits)[number]>,
  context: z.RefinementCtx,
): void {
  const changedUnits = new Set<string>();
  const initialAddedUnits = new Set<string>();

  publication.changes.forEach((change, index) => {
    if (changedUnits.has(change.knowledgeUnitId)) {
      context.addIssue({
        code: "custom",
        path: ["changes", index, "knowledgeUnitId"],
        message: "knowledge unit may appear in changes only once",
      });
    }
    changedUnits.add(change.knowledgeUnitId);

    if (publication.previousPublicationId === undefined) {
      if (change.kind !== "added") {
        context.addIssue({
          code: "custom",
          path: ["changes", index, "kind"],
          message: "initial publication may contain only added changes",
        });
      } else {
        initialAddedUnits.add(change.knowledgeUnitId);
      }
    }

    const currentUnit = units.get(change.knowledgeUnitId);
    if (change.kind === "removed" && currentUnit !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["changes", index],
        message: "removed knowledge unit must not appear in current units",
      });
    }
    if (change.kind !== "removed") {
      if (currentUnit === undefined) {
        context.addIssue({
          code: "custom",
          path: ["changes", index, "knowledgeUnitId"],
          message: "added or updated knowledge unit must appear in current units",
        });
      } else if (currentUnit.contentDigest !== change.currentContentDigest) {
        context.addIssue({
          code: "custom",
          path: ["changes", index, "currentContentDigest"],
          message: "change digest must match the current knowledge unit",
        });
      }
    }
  });

  if (publication.previousPublicationId === undefined) {
    for (const unitId of units.keys()) {
      if (!initialAddedUnits.has(unitId)) {
        context.addIssue({
          code: "custom",
          path: ["changes"],
          message: `initial knowledge unit ${unitId} requires an added change`,
        });
      }
    }
  }
}
