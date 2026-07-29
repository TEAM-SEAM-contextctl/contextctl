import { z } from "zod";

import {
  NonEmptyTextSchema,
  validateSortedUnique,
} from "../contract-validation.js";
import {
  ConnectorIdSchema,
  DocumentIdSchema,
  DocumentIndexIdSchema,
  IndexVersionSchema,
  PublicationScopeIdSchema,
  PublicationScopeVersionSchema,
  SemanticUnitIdSchema,
  SourceIdSchema,
} from "../identifiers.js";

/**
 * Pins the document index produced by Ingestion without exposing a physical
 * collection, namespace, vendor filter, or credential to Registry.
 */
export const PublishedDocumentIndexRefSchema = z
  .object({
    documentIndexId: DocumentIndexIdSchema,
    sourceId: SourceIdSchema,
    documentId: DocumentIdSchema,
    indexVersion: IndexVersionSchema,
    connectorId: ConnectorIdSchema,
    accessHandle: z.string().min(1).max(2_048).regex(/^[^\u0000-\u001f]+$/),
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
    semanticUnitIds: z.array(SemanticUnitIdSchema).min(1),
  })
  .strict()
  .superRefine((selector, context) => {
    validateSortedUnique(
      selector.semanticUnitIds,
      "semantic unit IDs",
      context,
    );
  });

/**
 * A managed-document retrieval range produced by Ingestion for Registry to
 * evaluate and translate. It is not an approved Card scope for Selection.
 */
export const PublishedDocumentScopeSchema = PublishedScopeRefSchema.extend({
  kind: z.literal("managed_document"),
  documentIndex: PublishedDocumentIndexRefSchema,
  selector: z.discriminatedUnion("kind", [
    PublishedDocumentSelectorSchema,
    PublishedSemanticUnitsSelectorSchema,
  ]),
}).strict();

export const PublishedSqlScopeSchema = PublishedScopeRefSchema.extend({
  kind: z.literal("sql_source"),
  connector: ConnectorIdSchema,
  table: NonEmptyTextSchema,
  columns: z.array(NonEmptyTextSchema).min(1),
})
  .strict()
  .superRefine((scope, context) => {
    validateSortedUnique(scope.columns, "SQL columns", context);
  });

export const PublishedHttpScopeSchema = PublishedScopeRefSchema.extend({
  kind: z.literal("http_source"),
  connector: ConnectorIdSchema,
  method: z.string().regex(/^[A-Z]+$/, "expected uppercase HTTP method"),
  path: z.string().startsWith("/"),
}).strict();

/**
 * Retrieval possibility observed and published by Ingestion. Registry is the
 * sole consumer and owns any translation into its approved Card read model.
 */
export const PublishedScopeSchema = z.discriminatedUnion("kind", [
  PublishedDocumentScopeSchema,
  PublishedSqlScopeSchema,
  PublishedHttpScopeSchema,
]);

export type PublishedDocumentIndexRef = z.infer<
  typeof PublishedDocumentIndexRefSchema
>;
export type PublishedScopeRef = z.infer<typeof PublishedScopeRefSchema>;
export type PublishedDocumentScope = z.infer<
  typeof PublishedDocumentScopeSchema
>;
export type PublishedSqlScope = z.infer<typeof PublishedSqlScopeSchema>;
export type PublishedHttpScope = z.infer<typeof PublishedHttpScopeSchema>;
export type PublishedScope = z.infer<typeof PublishedScopeSchema>;
