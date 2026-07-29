import { z } from "zod";
import {
  CanonicalTimestampSchema,
  ConnectorIdSchema,
  ContentDigestSchema,
  DocumentIdSchema,
  DocumentIndexIdSchema,
  IndexVersionSchema,
  KnowledgeUnitIdSchema,
  ObservationIdSchema,
  PublicationIdSchema,
  RetrievalScopeIdSchema,
  RetrievalScopeVersionSchema,
  SemanticUnitIdSchema,
  SourceIdSchema,
} from "./identifiers.js";

const ContractSchemaVersion = z.literal(1);
const NonEmptyText = z.string().min(1);
const MachineName = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);

export const DocumentIndexRefSchema = z
  .object({
    documentIndexId: DocumentIndexIdSchema,
    sourceId: SourceIdSchema,
    documentId: DocumentIdSchema,
    indexVersion: IndexVersionSchema,
    connectorId: ConnectorIdSchema,
    accessHandle: z.string().min(1).max(2_048).regex(/^[^\u0000-\u001f]+$/),
  })
  .strict();

export const RetrievalScopeRefSchema = z
  .object({
    scopeId: RetrievalScopeIdSchema,
    scopeVersion: RetrievalScopeVersionSchema,
  })
  .strict();

const DocumentSelectorSchema = z.object({ kind: z.literal("document") }).strict();

const SemanticUnitsSelectorSchema = z
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

export const ManagedDocumentScopeSchema = RetrievalScopeRefSchema.extend({
  kind: z.literal("managed_document"),
  documentIndex: DocumentIndexRefSchema,
  selector: z.discriminatedUnion("kind", [
    DocumentSelectorSchema,
    SemanticUnitsSelectorSchema,
  ]),
}).strict();

export const SqlSourceScopeSchema = RetrievalScopeRefSchema.extend({
  kind: z.literal("sql_source"),
  connector: ConnectorIdSchema,
  table: NonEmptyText,
  columns: z.array(NonEmptyText).min(1),
})
  .strict()
  .superRefine((scope, context) => {
    validateSortedUnique(scope.columns, "SQL columns", context);
  });

export const HttpSourceScopeSchema = RetrievalScopeRefSchema.extend({
  kind: z.literal("http_source"),
  connector: ConnectorIdSchema,
  method: z.string().regex(/^[A-Z]+$/, "expected uppercase HTTP method"),
  path: z.string().startsWith("/"),
}).strict();

export const RetrievalScopeSchema = z.discriminatedUnion("kind", [
  ManagedDocumentScopeSchema,
  SqlSourceScopeSchema,
  HttpSourceScopeSchema,
]);

const DocumentCoordinateSchema = z
  .object({
    kind: z.literal("document"),
    sourceId: SourceIdSchema,
    documentId: DocumentIdSchema,
    semanticUnitId: SemanticUnitIdSchema,
  })
  .strict();

const SqlCoordinateSchema = z
  .object({
    kind: z.literal("sql_table"),
    sourceId: SourceIdSchema,
    schema: NonEmptyText,
    table: NonEmptyText,
    columns: z.array(NonEmptyText).min(1),
  })
  .strict()
  .superRefine((coordinate, context) => {
    validateSortedUnique(coordinate.columns, "SQL coordinate columns", context);
  });

const HttpCoordinateSchema = z
  .object({
    kind: z.literal("http_operation"),
    sourceId: SourceIdSchema,
    method: z.string().regex(/^[A-Z]+$/, "expected uppercase HTTP method"),
    path: z.string().startsWith("/"),
  })
  .strict();

export const SourceCoordinateSchema = z.discriminatedUnion("kind", [
  DocumentCoordinateSchema,
  SqlCoordinateSchema,
  HttpCoordinateSchema,
]);

const FactScalarSchema = z.union([z.string(), z.number().finite(), z.boolean()]);

export const PublishedFactSchema = z
  .object({
    name: MachineName,
    value: z.union([FactScalarSchema, z.array(FactScalarSchema).min(1)]),
  })
  .strict();

export const ProvenanceSchema = z
  .object({
    observationId: ObservationIdSchema,
    producer: z
      .object({
        id: MachineName,
        version: NonEmptyText,
      })
      .strict(),
    policyVersions: z.record(MachineName, NonEmptyText),
  })
  .strict();

export const PublishedKnowledgeUnitSchema = z
  .object({
    id: KnowledgeUnitIdSchema,
    kind: z.enum(["document", "section", "table", "operation"]),
    sourceCoordinate: SourceCoordinateSchema,
    evidence: z.array(PublishedFactSchema).min(1),
    retrievalScopes: z.array(RetrievalScopeSchema).min(1),
    provenance: ProvenanceSchema,
    contentDigest: ContentDigestSchema,
  })
  .strict()
  .superRefine((unit, context) => {
    validateUniqueScopeRefs(unit.retrievalScopes, context);
  });

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
    changedFields: z.array(MachineName).min(1),
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

export const PublicationReadySchema = z
  .object({
    schemaVersion: ContractSchemaVersion,
    publicationId: PublicationIdSchema,
  })
  .strict();

export interface ContractValidationIssue {
  readonly code: string;
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

export class ContractValidationError extends Error {
  readonly issues: readonly ContractValidationIssue[];

  constructor(contract: string, issues: readonly ContractValidationIssue[]) {
    super(`${contract} failed validation with ${issues.length} issue(s)`);
    this.name = "ContractValidationError";
    this.issues = issues;
  }
}

export type DocumentIndexRef = z.infer<typeof DocumentIndexRefSchema>;
export type RetrievalScopeRef = z.infer<typeof RetrievalScopeRefSchema>;
export type ManagedDocumentScope = z.infer<
  typeof ManagedDocumentScopeSchema
>;
export type SqlSourceScope = z.infer<typeof SqlSourceScopeSchema>;
export type HttpSourceScope = z.infer<typeof HttpSourceScopeSchema>;
export type RetrievalScope = z.infer<typeof RetrievalScopeSchema>;
export type SourceCoordinate = z.infer<typeof SourceCoordinateSchema>;
export type PublishedFact = z.infer<typeof PublishedFactSchema>;
export type Provenance = z.infer<typeof ProvenanceSchema>;
export type PublishedKnowledgeUnit = z.infer<
  typeof PublishedKnowledgeUnitSchema
>;
export type PublishedChange = z.infer<typeof PublishedChangeSchema>;
export type IngestionPublication = z.infer<
  typeof IngestionPublicationSchema
>;
export type PublicationReady = z.infer<typeof PublicationReadySchema>;

export function parseIngestionPublication(
  input: unknown,
): IngestionPublication {
  return parseContract(
    "IngestionPublication",
    IngestionPublicationSchema,
    input,
  );
}

export function parsePublicationReady(input: unknown): PublicationReady {
  return parseContract("PublicationReady", PublicationReadySchema, input);
}

function parseContract<T>(
  contract: string,
  schema: z.ZodType<T>,
  input: unknown,
): T {
  const result = schema.safeParse(input);
  if (result.success) {
    return result.data;
  }
  throw new ContractValidationError(
    contract,
    result.error.issues.map((validationIssue) => ({
      code: validationIssue.code,
      path: validationIssue.path,
      message: validationIssue.message,
    })),
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

    unit.retrievalScopes.forEach((scope, scopeIndex) => {
      if (
        scope.kind === "managed_document" &&
        scope.documentIndex.sourceId !== publication.sourceId
      ) {
        context.addIssue({
          code: "custom",
          path: [
            "knowledgeUnits",
            unitIndex,
            "retrievalScopes",
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
          path: ["knowledgeUnits", unitIndex, "retrievalScopes", scopeIndex],
          message: "the same scope revision must have one immutable definition",
        });
      }
      scopeDefinitions.set(reference, definition);
    });
  });

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

function validateUniqueScopeRefs(
  scopes: readonly z.infer<typeof RetrievalScopeSchema>[],
  context: z.RefinementCtx,
): void {
  const references = new Set<string>();
  scopes.forEach((scope, index) => {
    const reference = `${scope.scopeId}:${scope.scopeVersion}`;
    if (references.has(reference)) {
      context.addIssue({
        code: "custom",
        path: ["retrievalScopes", index],
        message: "scope revision must not be repeated",
      });
    }
    references.add(reference);
  });
}

function validateSortedUnique(
  values: readonly string[],
  label: string,
  context: z.RefinementCtx,
): void {
  const canonical = [...new Set(values)].sort();
  if (
    canonical.length !== values.length ||
    canonical.some((value, index) => value !== values[index])
  ) {
    context.addIssue({
      code: "custom",
      message: `${label} must be unique and lexically sorted`,
    });
  }
}
