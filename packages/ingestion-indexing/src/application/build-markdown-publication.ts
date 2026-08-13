import {
  parseIngestionPublication,
  type IngestionPublication,
  type PublishedChange,
  type PublishedDocumentScope,
  type PublishedKnowledgeUnit,
} from "@contextctl/contracts";

import type {
  DocumentSemanticUnit,
  NormalizedDocument,
} from "../domain/document-model.js";
import type { IndexManifest } from "../domain/index-manifest.js";
import {
  canonicalDigest,
  canonicalJson,
  stableIdentity,
} from "../domain/revision-identity.js";

export interface BuildMarkdownPublicationInput {
  readonly document: NormalizedDocument;
  readonly semanticUnits: readonly DocumentSemanticUnit[];
  readonly manifest: IndexManifest;
  readonly scopes: readonly PublishedDocumentScope[];
  readonly previous?: IngestionPublication;
}

/** Builds and contract-validates the sole Registry-facing lifecycle payload. */
export function buildMarkdownPublication(
  input: BuildMarkdownPublicationInput,
): IngestionPublication {
  const knowledgeUnits = input.semanticUnits.map((unit) =>
    toPublishedKnowledgeUnit(input.document, unit, input.manifest, input.scopes),
  );
  const publicationId = stableIdentity("pub", {
    sourceId: input.document.sourceId,
    observationId: input.document.observationId,
    indexVersion: input.manifest.indexVersion,
    knowledgeUnits: knowledgeUnits.map((unit) => [unit.id, unit.contentDigest]),
  });
  return parseIngestionPublication({
    schemaVersion: 1,
    publicationId,
    sourceId: input.document.sourceId,
    observationId: input.document.observationId,
    ...(input.previous === undefined
      ? {}
      : { previousPublicationId: input.previous.publicationId }),
    producedAt: input.manifest.publishedAt,
    knowledgeUnits,
    changes: publicationChanges(input.previous, knowledgeUnits),
  });
}

function toPublishedKnowledgeUnit(
  document: NormalizedDocument,
  unit: DocumentSemanticUnit,
  manifest: IndexManifest,
  scopes: readonly PublishedDocumentScope[],
): PublishedKnowledgeUnit {
  const publishedScope = requiredUnitScope(unit, scopes);
  const evidence = [
    { name: "block.count", value: unit.blockIds.length },
    { name: "boundary.kind", value: unit.boundary.kind },
    { name: "content.digest", value: unit.contentDigest },
    { name: "semantic.kind", value: unit.kind },
    ...(unit.title === undefined ? [] : [{ name: "title", value: unit.title }]),
  ].sort((left, right) => left.name.localeCompare(right.name));
  const published: Omit<PublishedKnowledgeUnit, "contentDigest"> = {
    id: unit.id,
    kind: unit.kind === "document" ? "document" : "section",
    sourceCoordinate: {
      kind: "document",
      sourceId: unit.sourceId,
      documentId: unit.documentId,
      semanticUnitId: unit.id,
    },
    evidence,
    publishedScopes: [publishedScope],
    provenance: {
      observationId: unit.observationId,
      producer: {
        id: document.parser.id,
        version: document.parser.version,
      },
      policyVersions: {
        chunking: manifest.chunkPolicyVersion,
        embedding: `${manifest.embeddingProfile.id}@${manifest.embeddingProfile.version}`,
        lineage: manifest.lineagePolicyVersion,
        normalization: manifest.normalizationPolicyVersion,
        payload: String(manifest.payloadSchemaVersion),
        segmentation: manifest.segmentationPolicyVersion,
        "text.measure": manifest.textMeasureProfileVersion,
      },
    },
  };
  return {
    ...published,
    contentDigest: canonicalDigest({
      semanticContentDigest: unit.contentDigest,
      published,
    }),
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

function publicationChanges(
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
  const previousById = new Map(
    previous.knowledgeUnits.map((unit) => [unit.id, unit]),
  );
  const currentById = new Map(current.map((unit) => [unit.id, unit]));
  const changes: PublishedChange[] = [];
  for (const unit of current) {
    const old = previousById.get(unit.id);
    if (old === undefined) {
      changes.push({
        kind: "added",
        knowledgeUnitId: unit.id,
        currentContentDigest: unit.contentDigest,
      });
      continue;
    }
    const changedFields = changedKnowledgeUnitFields(old, unit);
    if (changedFields.length > 0) {
      changes.push({
        kind: "updated",
        knowledgeUnitId: unit.id,
        previousContentDigest: old.contentDigest,
        currentContentDigest: unit.contentDigest,
        changedFields,
      });
    }
  }
  for (const unit of previous.knowledgeUnits) {
    if (!currentById.has(unit.id)) {
      changes.push({
        kind: "removed",
        knowledgeUnitId: unit.id,
        previousContentDigest: unit.contentDigest,
      });
    }
  }
  return changes.sort((left, right) =>
    left.knowledgeUnitId.localeCompare(right.knowledgeUnitId),
  );
}

function changedKnowledgeUnitFields(
  previous: PublishedKnowledgeUnit,
  current: PublishedKnowledgeUnit,
): string[] {
  const fields = [
    ["content", previous.contentDigest, current.contentDigest],
    ["evidence", previous.evidence, current.evidence],
    ["provenance", previous.provenance, current.provenance],
    ["published.scopes", previous.publishedScopes, current.publishedScopes],
    ["source.coordinate", previous.sourceCoordinate, current.sourceCoordinate],
  ] as const;
  return fields
    .filter(([, left, right]) => canonicalJson(left) !== canonicalJson(right))
    .map(([name]) => name)
    .sort();
}
