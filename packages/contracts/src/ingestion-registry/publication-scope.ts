import { z } from "zod";

import {
  canonicalContractByteLength,
  validateSortedUnique,
} from "../contract-validation.js";
import {
  DocumentIdSchema,
  DocumentIndexIdSchema,
  IndexVersionSchema,
  PublicationScopeIdSchema,
  PublicationScopeVersionSchema,
  SemanticUnitIdSchema,
  SourceIdSchema,
} from "../identifiers.js";

export const MAX_PUBLISHED_SCOPE_BYTES = 16 * 1_024;
export const MAX_SCOPE_SET_SIZE = 256;
export const MAX_SQL_COORDINATE_COLUMNS = 4_096;

/** Deterministic column partitions used by SQL Scope producers. */
export function groupPublishedSqlColumns(
  columns: readonly string[],
): readonly (readonly string[])[] {
  if (columns.length === 0 || columns.length > MAX_SQL_COORDINATE_COLUMNS) {
    throw new TypeError("SQL coordinate column count is outside the supported range");
  }
  const sorted = [...columns].sort();
  if (
    new Set(sorted).size !== sorted.length ||
    sorted.some((column) => !coordinateText().safeParse(column).success)
  ) {
    throw new TypeError("SQL coordinate columns must be unique safe names");
  }
  const groups: string[][] = [];
  for (let offset = 0; offset < sorted.length; offset += MAX_SCOPE_SET_SIZE) {
    groups.push(sorted.slice(offset, offset + MAX_SCOPE_SET_SIZE));
  }
  return groups;
}

const UnsafeCoordinateCharacters =
  /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const coordinateText = (max = 256) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !UnsafeCoordinateCharacters.test(value), {
      message: "coordinate text contains unsafe control characters",
    });

/** Logical index identity. Physical connector bindings remain in Indexing. */
export const PublishedDocumentIndexRefSchema = z
  .object({
    documentIndexId: DocumentIndexIdSchema,
    sourceId: SourceIdSchema,
    documentId: DocumentIdSchema,
    indexVersion: IndexVersionSchema,
  })
  .strict();

export const PublishedScopeRefSchema = z
  .object({
    scopeId: PublicationScopeIdSchema,
    scopeVersion: PublicationScopeVersionSchema,
  })
  .strict();

const PublishedDocumentSelectorSchema = z
  .object({ kind: z.literal("document") })
  .strict();

const PublishedSemanticUnitsSelectorSchema = z
  .object({
    kind: z.literal("semantic_units"),
    semanticUnitIds: z
      .array(SemanticUnitIdSchema)
      .min(1)
      .max(MAX_SCOPE_SET_SIZE),
  })
  .strict()
  .superRefine((selector, context) => {
    validateSortedUnique(selector.semanticUnitIds, "semantic unit IDs", context);
  });

export const HttpParameterRefSchema = z
  .object({
    location: z.enum(["path", "query"]),
    name: coordinateText(128),
    required: z.boolean(),
  })
  .strict()
  .superRefine((parameter, context) => {
    if (parameter.location === "path" && !parameter.required) {
      context.addIssue({
        code: "custom",
        path: ["required"],
        message: "path parameters must be required",
      });
    }
  });

/** Registry-facing managed-document retrieval range. */
export const PublishedDocumentScopeSchema = PublishedScopeRefSchema.extend({
  kind: z.literal("managed_document"),
  documentIndex: PublishedDocumentIndexRefSchema,
  selector: z.discriminatedUnion("kind", [
    PublishedDocumentSelectorSchema,
    PublishedSemanticUnitsSelectorSchema,
  ]),
})
  .strict()
  .superRefine(validateScopeByteLimit);

export const PublishedSqlScopeSchema = PublishedScopeRefSchema.extend({
  kind: z.literal("sql_source"),
  connector: coordinateText(),
  schema: coordinateText(),
  table: coordinateText(),
  columns: z.array(coordinateText()).min(1).max(MAX_SCOPE_SET_SIZE),
})
  .strict()
  .superRefine((scope, context) => {
    validateSortedUnique(scope.columns, "SQL columns", context);
    validateScopeByteLimit(scope, context);
  });

export const PublishedHttpScopeSchema = PublishedScopeRefSchema.extend({
  kind: z.literal("http_source"),
  connector: coordinateText(),
  method: z.literal("GET"),
  path: z
    .string()
    .min(1)
    .max(2_048)
    .startsWith("/")
    .refine(
      (value) =>
        !UnsafeCoordinateCharacters.test(value) &&
        !value.includes("?") &&
        !value.includes("#"),
      { message: "HTTP path must be a safe path template" },
    ),
  operationId: coordinateText().optional(),
  parameters: z.array(HttpParameterRefSchema).max(64),
})
  .strict()
  .superRefine((scope, context) => {
    validateHttpParameters(scope.path, scope.parameters, context);
    validateScopeByteLimit(scope, context);
  });

/** Retrieval possibility observed by Ingestion and consumed only by Registry. */
export const PublishedScopeSchema = z.discriminatedUnion("kind", [
  PublishedDocumentScopeSchema,
  PublishedSqlScopeSchema,
  PublishedHttpScopeSchema,
]);

function validateScopeByteLimit(
  scope: unknown,
  context: z.RefinementCtx,
): void {
  if (canonicalContractByteLength(scope) > MAX_PUBLISHED_SCOPE_BYTES) {
    context.addIssue({
      code: "custom",
      message: "published scope exceeds the 16 KiB canonical limit",
    });
  }
}

function validateHttpParameters(
  path: string,
  parameters: readonly HttpParameterRef[],
  context: z.RefinementCtx,
): void {
  const keys = parameters.map(
    (parameter) => `${parameter.location}\u0000${parameter.name}`,
  );
  validateSortedUnique(keys, "HTTP parameters", context);
  const placeholders = [...path.matchAll(/\{([^{}]+)\}/gu)].map(
    (match) => match[1]!,
  );
  const pathParameters = parameters
    .filter((parameter) => parameter.location === "path")
    .map((parameter) => parameter.name);
  if (
    new Set(placeholders).size !== placeholders.length ||
    placeholders.length !== pathParameters.length ||
    placeholders.some((name) => !pathParameters.includes(name)) ||
    pathParameters.some((name) => !placeholders.includes(name))
  ) {
    context.addIssue({
      code: "custom",
      path: ["parameters"],
      message: "HTTP path placeholders and path parameters must match exactly",
    });
  }
}

export type PublishedDocumentIndexRef = z.infer<
  typeof PublishedDocumentIndexRefSchema
>;
export type PublishedScopeRef = z.infer<typeof PublishedScopeRefSchema>;
export type HttpParameterRef = z.infer<typeof HttpParameterRefSchema>;
export type PublishedDocumentScope = z.infer<
  typeof PublishedDocumentScopeSchema
>;
export type PublishedSqlScope = z.infer<typeof PublishedSqlScopeSchema>;
export type PublishedHttpScope = z.infer<typeof PublishedHttpScopeSchema>;
export type PublishedScope = z.infer<typeof PublishedScopeSchema>;
