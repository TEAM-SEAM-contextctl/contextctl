import { createHash } from "node:crypto";

import {
  type DocumentSemanticUnit,
  type NormalizedDocument,
} from "./document-model.js";

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
  const digest = createHash("sha256")
    .update(canonicalJson(revisionInput), "utf8")
    .digest();
  return `urv_${toBase32(digest)}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function toBase32(input: Uint8Array): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let output = "";
  let bits = 0;
  let value = 0;
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += alphabet[(value << (5 - bits)) & 31];
  }
  return output;
}
