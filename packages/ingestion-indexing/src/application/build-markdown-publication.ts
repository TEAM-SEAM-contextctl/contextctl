import {
  canonicalContractByteLength,
  computePublicationChanges,
  computePublishedKnowledgeUnitDigest,
  ContractValidationError,
  MAX_PUBLICATION_BYTES,
  MAX_PUBLICATION_FACT_BYTES,
  MAX_PUBLICATION_FACTS,
  parseIngestionPublication,
  type IngestionPublication,
  type PublishedDocumentScope,
  type PublishedFact,
  type PublishedKnowledgeUnit,
} from "@contextctl/contracts";

import type {
  DocumentSemanticUnit,
  NormalizedDocument,
} from "../domain/document-model.js";
import {
  derivePublicationKeywords,
  DOCUMENT_KEYWORD_EXTRACTION_POLICY_VERSION,
} from "../domain/derived-publication-keywords.js";
import type { IndexManifest } from "../domain/index-manifest.js";
import { canonicalJson } from "../domain/revision-identity.js";

export interface BuildMarkdownPublicationInput {
  readonly publicationId: string;
  readonly document: NormalizedDocument;
  readonly semanticUnits: readonly DocumentSemanticUnit[];
  readonly manifest: IndexManifest;
  readonly scopes: readonly PublishedDocumentScope[];
  readonly previous?: IngestionPublication;
  readonly previousSemanticUnits?: readonly DocumentSemanticUnit[];
  /**
   * Units the producer proved may keep their predecessor Scope. Omission is
   * fail-closed: no predecessor projection is inherited.
   */
  readonly inheritableUnitIds?: readonly string[];
}

export interface BuildEmptyMarkdownPublicationInput {
  readonly publicationId: string;
  readonly document: NormalizedDocument;
  readonly producedAt: string;
  readonly previous?: IngestionPublication;
}

export type MarkdownPublicationBuildErrorCode =
  | "publication_envelope_limit_exceeded"
  | "publication_fact_limit_exceeded"
  | "publication_projection_invalid";

export class MarkdownPublicationBuildError extends Error {
  constructor(readonly code: MarkdownPublicationBuildErrorCode) {
    super(`Markdown publication build failed: ${code}`);
    this.name = "MarkdownPublicationBuildError";
  }
}

/** Builds and contract-validates the sole Registry-facing lifecycle payload. */
export function buildMarkdownPublication(
  input: BuildMarkdownPublicationInput,
): IngestionPublication {
  return mapPublicationBuildErrors(() =>
    buildMarkdownPublicationUnchecked(input),
  );
}

function buildMarkdownPublicationUnchecked(
  input: BuildMarkdownPublicationInput,
): IngestionPublication {
  const previousSemanticById = new Map(
    (input.previousSemanticUnits ?? []).map((unit) => [unit.id, unit]),
  );
  const previousPublishedById = new Map(
    (input.previous?.knowledgeUnits ?? []).map((unit) => [unit.id, unit]),
  );
  const inheritable = new Set(input.inheritableUnitIds ?? []);
  const blockById = new Map(
    input.document.blocks.map((block) => [block.id, block]),
  );
  const knowledgeUnits = input.semanticUnits
    .map((unit) => {
      const previousSemantic = previousSemanticById.get(unit.id);
      const previousPublished = previousPublishedById.get(unit.id);
      const currentPublished = toPublishedKnowledgeUnit(
        input.document,
        unit,
        input.manifest,
        input.scopes,
        blockById,
      );
      if (
        previousSemantic !== undefined &&
        previousPublished !== undefined &&
        previousSemantic.revisionId === unit.revisionId &&
        inheritable.has(unit.id) &&
        sameInheritanceProjection(previousPublished, currentPublished)
      ) {
        return previousPublished;
      }
      return currentPublished;
    })
    .sort((left, right) => compareText(left.id, right.id));
  return parsePublicationCandidate({
    schemaVersion: 2,
    publicationId: input.publicationId,
    sourceId: input.document.sourceId,
    observationId: input.document.observationId,
    ...(input.previous === undefined
      ? {}
      : { previousPublicationId: input.previous.publicationId }),
    producedAt: input.manifest.publishedAt,
    knowledgeUnits,
    changes: computePublicationChanges(input.previous, knowledgeUnits),
  });
}

/** Publishes the authoritative absence of searchable knowledge for a document. */
export function buildEmptyMarkdownPublication(
  input: BuildEmptyMarkdownPublicationInput,
): IngestionPublication {
  return mapPublicationBuildErrors(() =>
    buildEmptyMarkdownPublicationUnchecked(input),
  );
}

function buildEmptyMarkdownPublicationUnchecked(
  input: BuildEmptyMarkdownPublicationInput,
): IngestionPublication {
  const knowledgeUnits: readonly PublishedKnowledgeUnit[] = [];
  return parsePublicationCandidate({
    schemaVersion: 2,
    publicationId: input.publicationId,
    sourceId: input.document.sourceId,
    observationId: input.document.observationId,
    ...(input.previous === undefined
      ? {}
      : { previousPublicationId: input.previous.publicationId }),
    producedAt: input.producedAt,
    knowledgeUnits,
    changes: computePublicationChanges(input.previous, knowledgeUnits),
  });
}

function toPublishedKnowledgeUnit(
  document: NormalizedDocument,
  unit: DocumentSemanticUnit,
  manifest: IndexManifest,
  scopes: readonly PublishedDocumentScope[],
  blockById: ReadonlyMap<
    string,
    NormalizedDocument["blocks"][number]
  >,
): PublishedKnowledgeUnit {
  const publishedScope = requiredUnitScope(unit, scopes);
  const blocks = unit.blockIds
    .map((blockId) => blockById.get(blockId))
    .filter((block): block is NormalizedDocument["blocks"][number] => block !== undefined);
  const firstPath = blocks.find((block) => block.sectionPath.length > 0)?.sectionPath;
  const facts: PublishedFact[] = [
    { name: "document.media_type", value: document.mediaType },
    { name: "structure.block_count", value: unit.blockIds.length },
    { name: "unit.kind", value: unit.kind },
  ];
  const blockKinds = [...new Set(blocks.map((block) => block.kind))].sort();
  if (blockKinds.length > 0) {
    facts.push({ name: "structure.block_kinds", value: blockKinds });
  }
  if (document.title !== undefined) {
    facts.push({ name: "document.title", value: document.title });
  }
  if (firstPath !== undefined) {
    facts.push({
      name: "section.path",
      value: firstPath.map((headingId) =>
        requiredSectionLabel(blockById, headingId),
      ),
    });
  }
  if (unit.kind !== "document" && unit.title !== undefined) {
    facts.push({ name: "section.label", value: unit.title });
  }
  const derivedKeywords = derivePublicationKeywords(blocks);
  if (derivedKeywords.length > 0) {
    facts.push({ name: "keywords.derived", value: [...derivedKeywords] });
  }
  facts.sort((left, right) => compareText(left.name, right.name));
  assertFactLimits(facts);
  const published: Omit<PublishedKnowledgeUnit, "contentDigest"> = {
    id: unit.id,
    kind: unit.kind,
    sourceCoordinate: {
      kind: "document",
      sourceId: unit.sourceId,
      documentId: unit.documentId,
      semanticUnitId: unit.id,
    },
    facts,
    publishedScopes: [publishedScope],
    provenance: {
      observationId: unit.observationId,
      producer: {
        id: document.parser.id,
        version: document.parser.version,
      },
      policyVersions: {
        embedding: `${manifest.embeddingProfile.id}@${manifest.embeddingProfile.version}`,
        lineage: manifest.lineagePolicyVersion,
        normalization: manifest.normalizationPolicyVersion,
        payload: String(manifest.payloadSchemaVersion),
        "schema.extraction": DOCUMENT_KEYWORD_EXTRACTION_POLICY_VERSION,
        segmentation: manifest.segmentationPolicyVersion,
        chunking: manifest.chunkPolicyVersion,
        "text.measure": manifest.textMeasureProfileVersion,
      },
    },
  };
  return {
    ...published,
    contentDigest: computePublishedKnowledgeUnitDigest(published),
  };
}

function requiredUnitScope(
  unit: DocumentSemanticUnit,
  scopes: readonly PublishedDocumentScope[],
): PublishedDocumentScope {
  const scope = scopes.find((candidate) =>
    unit.kind === "document"
      ? candidate.selector.kind === "document"
      : candidate.selector.kind === "semantic_units" &&
        candidate.selector.semanticUnitIds.length === 1 &&
        candidate.selector.semanticUnitIds[0] === unit.id,
  );
  if (scope === undefined) {
    throw new TypeError("published Semantic Unit Scope is missing");
  }
  return scope;
}

/** Exposed for producer tests that assert exact v2 field classification. */
export function samePublishedKnowledgeUnit(
  left: PublishedKnowledgeUnit,
  right: PublishedKnowledgeUnit,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sameInheritanceProjection(
  previous: PublishedKnowledgeUnit,
  current: PublishedKnowledgeUnit,
): boolean {
  return (
    canonicalJson(inheritanceProjection(previous)) ===
    canonicalJson(inheritanceProjection(current))
  );
}

function inheritanceProjection(unit: PublishedKnowledgeUnit): unknown {
  return {
    id: unit.id,
    kind: unit.kind,
    sourceCoordinate: unit.sourceCoordinate,
    facts: unit.facts,
    producer: unit.provenance.producer,
    policyVersions: unit.provenance.policyVersions,
  };
}

function requiredSectionLabel(
  blockById: ReadonlyMap<string, NormalizedDocument["blocks"][number]>,
  headingId: string,
): string {
  const heading = blockById.get(headingId);
  if (
    heading === undefined ||
    heading.kind !== "heading" ||
    heading.text.trim() === ""
  ) {
    throw new TypeError("published section path is invalid");
  }
  return heading.text;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertFactLimits(facts: readonly PublishedFact[]): void {
  if (
    facts.length > MAX_PUBLICATION_FACTS ||
    canonicalContractByteLength(facts) > MAX_PUBLICATION_FACT_BYTES
  ) {
    throw new MarkdownPublicationBuildError(
      "publication_fact_limit_exceeded",
    );
  }
}

function parsePublicationCandidate(input: unknown): IngestionPublication {
  if (canonicalContractByteLength(input) > MAX_PUBLICATION_BYTES) {
    throw new MarkdownPublicationBuildError(
      "publication_envelope_limit_exceeded",
    );
  }
  return parseIngestionPublication(input);
}

function mapPublicationBuildErrors<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof MarkdownPublicationBuildError) {
      throw error;
    }
    if (error instanceof ContractValidationError || error instanceof TypeError) {
      throw new MarkdownPublicationBuildError(
        "publication_projection_invalid",
      );
    }
    throw error;
  }
}
