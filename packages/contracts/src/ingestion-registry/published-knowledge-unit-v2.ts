import { createHash } from "node:crypto";

import { z } from "zod";

import {
  canonicalContractByteLength,
  canonicalContractJson,
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
  HttpParameterRefSchema,
  MAX_SQL_COORDINATE_COLUMNS,
  PublishedScopeSchema,
  type PublishedScope,
} from "./publication-scope-v2.js";

const BoundedCoordinateTextSchema = z.string().min(1).max(256);

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
    schema: BoundedCoordinateTextSchema,
    table: BoundedCoordinateTextSchema,
    columns: z
      .array(BoundedCoordinateTextSchema)
      .min(1)
      .max(MAX_SQL_COORDINATE_COLUMNS),
  })
  .strict()
  .superRefine((coordinate, context) => {
    validateSortedUnique(coordinate.columns, "SQL coordinate columns", context);
  });

const PublishedHttpCoordinateSchema = z
  .object({
    kind: z.literal("http_operation"),
    sourceId: SourceIdSchema,
    method: z.literal("GET"),
    path: z.string().min(1).max(2_048).startsWith("/"),
    operationId: BoundedCoordinateTextSchema.optional(),
    parameters: z.array(HttpParameterRefSchema).max(64),
  })
  .strict();

export const PublishedSourceCoordinateSchema = z.discriminatedUnion("kind", [
  PublishedDocumentCoordinateSchema,
  PublishedSqlCoordinateSchema,
  PublishedHttpCoordinateSchema,
]);

export const PublicationFactNameSchema = z.enum([
  "document.title",
  "document.media_type",
  "section.path",
  "section.label",
  "unit.kind",
  "structure.block_kinds",
  "structure.block_count",
  "keywords.derived",
  "sql.schema",
  "sql.table",
  "sql.columns",
  "sql.column_types",
  "sql.primary_key",
  "sql.related_tables",
  "sql.approximate_row_count",
  "http.operation_id",
  "http.summary",
  "http.request_schema_digest",
  "http.response_schema_digest",
  "http.auth_schemes",
]);

const PublishedFactScalarSchema = z.union([
  z.string().min(1).max(2_048),
  z.number().finite(),
]);

export const PublishedFactSchema = z
  .object({
    name: PublicationFactNameSchema,
    value: z.union([
      PublishedFactScalarSchema,
      z.array(PublishedFactScalarSchema).min(1).max(64),
    ]),
  })
  .strict();

export const PublicationPolicyNameSchema = z.enum([
  "capture",
  "parser",
  "normalization",
  "lineage",
  "segmentation",
  "chunking",
  "text.measure",
  "embedding",
  "payload",
  "schema.extraction",
  "reference.resolution",
  "permission.observation",
]);
const VersionTokenSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[^\s\u0000-\u001f\u007f-\u009f]+$/u);

/** Observation and policy metadata needed to reproduce a published unit. */
export const PublicationProvenanceSchema = z
  .object({
    observationId: ObservationIdSchema,
    producer: z
      .object({
        id: VersionTokenSchema,
        version: VersionTokenSchema,
      })
      .strict(),
    policyVersions: z
      .partialRecord(PublicationPolicyNameSchema, VersionTokenSchema)
      .refine((value) => Object.keys(value).length <= 12, {
        message: "publication provenance may contain at most 12 policies",
      }),
  })
  .strict();

const DOCUMENT_FACTS = new Set<PublicationFactName>([
  "document.title",
  "document.media_type",
  "section.path",
  "section.label",
  "unit.kind",
  "structure.block_kinds",
  "structure.block_count",
  "keywords.derived",
]);
const TABLE_FACTS = new Set<PublicationFactName>([
  "sql.schema",
  "sql.table",
  "sql.columns",
  "sql.column_types",
  "sql.primary_key",
  "sql.related_tables",
  "sql.approximate_row_count",
]);
const OPERATION_FACTS = new Set<PublicationFactName>([
  "http.operation_id",
  "http.summary",
  "http.request_schema_digest",
  "http.response_schema_digest",
  "http.auth_schemes",
]);

/** The smallest Registry-facing description of one useful knowledge region. */
export const PublishedKnowledgeUnitSchema = z
  .object({
    id: KnowledgeUnitIdSchema,
    kind: z.enum(["document", "section", "segment", "table", "operation"]),
    sourceCoordinate: PublishedSourceCoordinateSchema,
    facts: z.array(PublishedFactSchema).max(64),
    publishedScopes: z.array(PublishedScopeSchema).min(1).max(64),
    provenance: PublicationProvenanceSchema,
    contentDigest: ContentDigestSchema,
  })
  .strict()
  .superRefine((unit, context) => {
    validateFacts(unit, context);
    validateUniquePublishedScopeRefs(unit.publishedScopes, context);
    if (unit.contentDigest !== computePublishedKnowledgeUnitDigest(unit)) {
      context.addIssue({
        code: "custom",
        path: ["contentDigest"],
        message: "content digest must match publication-unit-v2",
      });
    }
  });

export function computePublishedKnowledgeUnitDigest(
  unit: Omit<PublishedKnowledgeUnit, "contentDigest"> | PublishedKnowledgeUnit,
): string {
  const { contentDigest: _contentDigest, ...content } = unit as PublishedKnowledgeUnit;
  return `sha256:${createHash("sha256")
    .update(canonicalContractJson(content))
    .digest("hex")}`;
}

function validateFacts(
  unit: Omit<PublishedKnowledgeUnit, "contentDigest"> & {
    readonly contentDigest?: string;
  },
  context: z.RefinementCtx,
): void {
  const names = unit.facts.map((fact) => fact.name);
  validateSortedUnique(names, "publication fact names", context);
  if (canonicalContractByteLength(unit.facts) > 16 * 1_024) {
    context.addIssue({
      code: "custom",
      path: ["facts"],
      message: "publication facts exceed the 16 KiB canonical limit",
    });
  }
  const allowed =
    unit.kind === "table"
      ? TABLE_FACTS
      : unit.kind === "operation"
        ? OPERATION_FACTS
        : DOCUMENT_FACTS;
  unit.facts.forEach((fact, index) => {
    if (!allowed.has(fact.name)) {
      context.addIssue({
        code: "custom",
        path: ["facts", index, "name"],
        message: `fact ${fact.name} is not allowed for ${unit.kind}`,
      });
    }
    validateFactValue(unit, fact, index, context);
  });
}

function validateFactValue(
  unit: Pick<PublishedKnowledgeUnit, "kind" | "sourceCoordinate" | "facts">,
  fact: PublishedFact,
  index: number,
  context: z.RefinementCtx,
): void {
  const value = fact.value;
  const issue = (message: string): void =>
    context.addIssue({ code: "custom", path: ["facts", index, "value"], message });
  const sortedStringArray =
    Array.isArray(value) &&
    value.every((item) => typeof item === "string") &&
    [...new Set(value)].sort().every((item, itemIndex) => item === value[itemIndex]);
  if (
    ["document.title", "section.label", "http.operation_id", "http.summary", "sql.schema", "sql.table"].includes(fact.name) &&
    (typeof value !== "string" || value.length === 0)
  ) issue("fact requires a non-empty string");
  if (
    fact.name === "document.media_type" &&
    !["text/markdown", "text/plain", "application/pdf"].includes(String(value))
  ) issue("document media type is unsupported");
  if (
    fact.name === "unit.kind" &&
    (typeof value !== "string" || value !== unit.kind || !["document", "section", "segment"].includes(value))
  ) issue("unit.kind fact must match the document unit kind");
  if (
    ["structure.block_count", "sql.approximate_row_count"].includes(fact.name) &&
    (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
  ) issue("count fact requires a non-negative safe integer");
  if (
    ["structure.block_kinds", "keywords.derived", "sql.columns", "sql.related_tables", "http.auth_schemes"].includes(fact.name) &&
    !sortedStringArray
  ) issue("fact requires a sorted unique string array");
  if (
    fact.name === "section.path" &&
    (!Array.isArray(value) ||
      !value.every((item) => typeof item === "string" && item.length > 0))
  ) issue("section path requires an ordered non-empty string array");
  if (
    ["http.request_schema_digest", "http.response_schema_digest"].includes(fact.name) &&
    (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value))
  ) issue("schema fact requires a SHA-256 digest");

  if (unit.sourceCoordinate.kind === "sql_table") {
    const coordinate = unit.sourceCoordinate;
    if (fact.name === "sql.schema" && value !== coordinate.schema) issue("SQL schema fact must match the coordinate");
    if (fact.name === "sql.table" && value !== coordinate.table) issue("SQL table fact must match the coordinate");
    if (fact.name === "sql.columns" && canonicalContractJson(value) !== canonicalContractJson(coordinate.columns)) issue("SQL column facts must match the coordinate");
    if (fact.name === "sql.column_types") {
      const columns = unit.facts.find((candidate) => candidate.name === "sql.columns")?.value;
      if (!Array.isArray(value) || !value.every((item) => typeof item === "string") || !Array.isArray(columns) || value.length !== columns.length) issue("SQL column types must align with SQL columns");
    }
    if (fact.name === "sql.primary_key" && (!Array.isArray(value) || !value.every((item) => typeof item === "string" && coordinate.columns.includes(item)) || new Set(value).size !== value.length)) issue("SQL primary key must contain unique coordinate columns");
  }
  if (
    unit.sourceCoordinate.kind === "http_operation" &&
    fact.name === "http.operation_id" &&
    value !== unit.sourceCoordinate.operationId
  ) issue("HTTP operation ID fact must match the coordinate");
}

function validateUniquePublishedScopeRefs(
  scopes: readonly PublishedScope[],
  context: z.RefinementCtx,
): void {
  const references = scopes.map((scope) => `${scope.scopeId}\u0000${scope.scopeVersion}`);
  validateSortedUnique(references, "published scope revisions", context);
}

export type PublishedSourceCoordinate = z.infer<typeof PublishedSourceCoordinateSchema>;
export type PublicationFactName = z.infer<typeof PublicationFactNameSchema>;
export type PublishedFact = z.infer<typeof PublishedFactSchema>;
export type PublicationProvenance = z.infer<typeof PublicationProvenanceSchema>;
export type PublishedKnowledgeUnit = z.infer<typeof PublishedKnowledgeUnitSchema>;
