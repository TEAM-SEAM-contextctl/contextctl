import {
  type DocumentSemanticUnit,
  type NormalizedDocument,
} from "./document-model.js";
import { revisionIdentity } from "./revision-identity.js";

export type SemanticUnitRevisionInput = Omit<
  DocumentSemanticUnit,
  "diagnostics" | "observationId" | "revisionId"
>;

export interface SemanticUnitRevisionContext {
  revisionId(unit: SemanticUnitRevisionInput): string;
}

export function createSemanticUnitRevisionContext(
  document: NormalizedDocument,
  textMeasureProfileVersion: string,
): SemanticUnitRevisionContext {
  const blockById = new Map(document.blocks.map((block) => [block.id, block]));
  return {
    revisionId: (unit) =>
      semanticUnitRevisionId(blockById, unit, textMeasureProfileVersion),
  };
}

function semanticUnitRevisionId(
  blockById: ReadonlyMap<string, NormalizedDocument["blocks"][number]>,
  unit: SemanticUnitRevisionInput,
  textMeasureProfileVersion: string,
): string {
  const blockRevisions = unit.blockIds.map((blockId) => {
    const block = blockById.get(blockId);
    if (block === undefined) {
      throw new Error(`Semantic Unit references missing Block: ${blockId}`);
    }
    return { id: block.id, revisionId: block.revisionId };
  });
  const revisionInput = {
    id: unit.id,
    sourceId: unit.sourceId,
    documentId: unit.documentId,
    kind: unit.kind,
    ...(unit.title === undefined ? {} : { title: unit.title }),
    ...(unit.parentId === undefined ? {} : { parentId: unit.parentId }),
    childIds: unit.childIds,
    blockIds: unit.blockIds,
    blockRevisions,
    boundary: unit.boundary,
    contentDigest: unit.contentDigest,
    segmentationPolicyVersion: unit.segmentationPolicyVersion,
    textMeasureProfileVersion,
  };
  return revisionIdentity("urv", revisionInput);
}
