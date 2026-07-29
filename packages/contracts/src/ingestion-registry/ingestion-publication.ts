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
import { PublishedKnowledgeUnitSchema } from "./published-knowledge-unit.js";

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

    unit.publishedScopes.forEach((scope, scopeIndex) => {
      if (
        scope.kind === "managed_document" &&
        scope.documentIndex.sourceId !== publication.sourceId
      ) {
        context.addIssue({
          code: "custom",
          path: [
            "knowledgeUnits",
            unitIndex,
            "publishedScopes",
            scopeIndex,
            "documentIndex",
            "sourceId",
          ],
          message: "document index must belong to the publication source",
        });
      }

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
