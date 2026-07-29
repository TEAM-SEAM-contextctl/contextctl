import { z } from "zod";

import {
  MachineNameSchema,
  NonEmptyTextSchema,
  validateSortedUnique,
} from "../contract-validation.js";
import {
  ContentDigestSchema,
  DocumentIdSchema,
  KnowledgeUnitIdSchema,
  ObservationIdSchema,
  SemanticUnitIdSchema,
  SourceIdSchema,
} from "../identifiers.js";
import {
  PublishedScopeSchema,
  type PublishedScope,
} from "./publication-scope.js";

const PublishedDocumentCoordinateSchema = z
  .object({
    kind: z.literal("document"),
    sourceId: SourceIdSchema,
    documentId: DocumentIdSchema,
    semanticUnitId: SemanticUnitIdSchema,
  })
  .strict();

const PublishedSqlCoordinateSchema = z
  .object({
    kind: z.literal("sql_table"),
    sourceId: SourceIdSchema,
    schema: NonEmptyTextSchema,
    table: NonEmptyTextSchema,
    columns: z.array(NonEmptyTextSchema).min(1),
  })
  .strict()
  .superRefine((coordinate, context) => {
    validateSortedUnique(coordinate.columns, "SQL coordinate columns", context);
  });

const PublishedHttpCoordinateSchema = z
  .object({
    kind: z.literal("http_operation"),
    sourceId: SourceIdSchema,
    method: z.string().regex(/^[A-Z]+$/, "expected uppercase HTTP method"),
    path: z.string().startsWith("/"),
  })
  .strict();

export const PublishedSourceCoordinateSchema = z.discriminatedUnion("kind", [
  PublishedDocumentCoordinateSchema,
  PublishedSqlCoordinateSchema,
  PublishedHttpCoordinateSchema,
]);

const PublishedFactScalarSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
]);

export const PublishedFactSchema = z
  .object({
    name: MachineNameSchema,
    value: z.union([
      PublishedFactScalarSchema,
      z.array(PublishedFactScalarSchema).min(1),
    ]),
  })
  .strict();

/** Observation and policy metadata needed to reproduce a published unit. */
export const PublicationProvenanceSchema = z
  .object({
    observationId: ObservationIdSchema,
    producer: z
      .object({
        id: MachineNameSchema,
        version: NonEmptyTextSchema,
      })
      .strict(),
    policyVersions: z.record(MachineNameSchema, NonEmptyTextSchema),
  })
  .strict();

/**
 * The smallest Registry-facing description of one useful knowledge region.
 * It carries deterministic evidence and Ingestion-published scopes, but no raw
 * source payload, chunk text, embedding, or vector-store record.
 */
export const PublishedKnowledgeUnitSchema = z
  .object({
    id: KnowledgeUnitIdSchema,
    kind: z.enum(["document", "section", "table", "operation"]),
    sourceCoordinate: PublishedSourceCoordinateSchema,
    evidence: z.array(PublishedFactSchema).min(1),
    publishedScopes: z.array(PublishedScopeSchema).min(1),
    provenance: PublicationProvenanceSchema,
    contentDigest: ContentDigestSchema,
  })
  .strict()
  .superRefine((unit, context) => {
    validateUniquePublishedScopeRefs(unit.publishedScopes, context);
  });

function validateUniquePublishedScopeRefs(
  scopes: readonly PublishedScope[],
  context: z.RefinementCtx,
): void {
  const references = new Set<string>();
  scopes.forEach((scope, index) => {
    const reference = `${scope.scopeId}:${scope.scopeVersion}`;
    if (references.has(reference)) {
      context.addIssue({
        code: "custom",
        path: ["publishedScopes", index],
        message: "published scope revision must not be repeated",
      });
    }
    references.add(reference);
  });
}

export type PublishedSourceCoordinate = z.infer<
  typeof PublishedSourceCoordinateSchema
>;
export type PublishedFact = z.infer<typeof PublishedFactSchema>;
export type PublicationProvenance = z.infer<
  typeof PublicationProvenanceSchema
>;
export type PublishedKnowledgeUnit = z.infer<
  typeof PublishedKnowledgeUnitSchema
>;
