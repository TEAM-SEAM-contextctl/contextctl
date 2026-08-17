import {
  computePublicationV2Changes as computePublicationChanges,
  computePublishedKnowledgeUnitV2Digest as computePublishedKnowledgeUnitDigest,
  parseIngestionPublicationV2 as parseIngestionPublication,
  type IngestionPublicationV2 as IngestionPublication,
  type PublishedDocumentScopeV2 as PublishedDocumentScope,
  type PublishedFactV2 as PublishedFact,
  type PublishedKnowledgeUnitV2 as PublishedKnowledgeUnit,
} from "@contextctl/contracts";

import type {
  DocumentSemanticUnit,
  NormalizedDocument,
} from "../domain/document-model.js";
import type { IndexManifest } from "../domain/index-manifest.js";
import { canonicalJson, stableIdentity } from "../domain/revision-identity.js";

export interface BuildMarkdownPublicationInput {
  readonly document: NormalizedDocument;
  readonly semanticUnits: readonly DocumentSemanticUnit[];
  readonly manifest: IndexManifest;
  readonly scopes: readonly PublishedDocumentScope[];
  readonly previous?: IngestionPublication;
  readonly previousSemanticUnits?: readonly DocumentSemanticUnit[];
  /**
   * Units the producer proved may keep their predecessor Scope. When omitted,
   * an unchanged Unit revision alone decides inheritance.
   */
  readonly inheritableUnitIds?: readonly string[];
}

/** Builds and contract-validates the sole Registry-facing lifecycle payload. */
export function buildMarkdownPublication(
  input: BuildMarkdownPublicationInput,
): IngestionPublication {
  const previousSemanticById = new Map(
    (input.previousSemanticUnits ?? []).map((unit) => [unit.id, unit]),
  );
  const previousPublishedById = new Map(
    (input.previous?.knowledgeUnits ?? []).map((unit) => [unit.id, unit]),
  );
  const inheritable =
    input.inheritableUnitIds === undefined
      ? undefined
      : new Set(input.inheritableUnitIds);
  const knowledgeUnits = input.semanticUnits
    .map((unit) => {
      const previousSemantic = previousSemanticById.get(unit.id);
      const previousPublished = previousPublishedById.get(unit.id);
      if (
        previousSemantic !== undefined &&
        previousPublished !== undefined &&
        previousSemantic.revisionId === unit.revisionId &&
        (inheritable === undefined || inheritable.has(unit.id))
      ) {
        return previousPublished;
      }
      return toPublishedKnowledgeUnit(
        input.document,
        unit,
        input.manifest,
        input.scopes,
      );
    })
    .sort((left, right) => compareText(left.id, right.id));
  const publicationId = stableIdentity("pub", {
    sourceId: input.document.sourceId,
    observationId: input.document.observationId,
    previousPublicationId: input.previous?.publicationId,
    knowledgeUnits: knowledgeUnits.map((unit) => [unit.id, unit.contentDigest]),
  });
  return parseIngestionPublication({
    schemaVersion: 2,
    publicationId,
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

function toPublishedKnowledgeUnit(
  document: NormalizedDocument,
  unit: DocumentSemanticUnit,
  manifest: IndexManifest,
  scopes: readonly PublishedDocumentScope[],
): PublishedKnowledgeUnit {
  const publishedScope = requiredUnitScope(unit, scopes);
  const blocks = unit.blockIds
    .map((blockId) => document.blocks.find((block) => block.id === blockId))
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
    facts.push({ name: "section.path", value: [...firstPath] });
  }
  if (unit.kind !== "document" && unit.title !== undefined) {
    facts.push({ name: "section.label", value: unit.title });
  }
  facts.sort((left, right) => compareText(left.name, right.name));
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

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
