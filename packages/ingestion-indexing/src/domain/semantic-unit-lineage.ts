import {
  assertValidDocumentSemanticUnits,
  type DocumentSemanticUnit,
  type NormalizedDocument,
  validateDocumentSemanticUnits,
  validateNormalizedDocument,
} from "./document-model.js";
import {
  DEFAULT_DOCUMENT_INDEXING_POLICY,
  parseDocumentIndexingPolicy,
  type DocumentIndexingPolicySet,
  type LineagePolicy,
} from "./document-indexing-policy.js";
import { type ModelValidationIssue } from "./model-validation.js";
import { createSemanticUnitRevisionContext } from "./semantic-unit-revision.js";

export interface ReconcileSemanticUnitLineageInput {
  readonly previousDocument: NormalizedDocument;
  readonly previousUnits: readonly DocumentSemanticUnit[];
  readonly currentDocument: NormalizedDocument;
  readonly currentUnits: readonly DocumentSemanticUnit[];
  readonly policy?: DocumentIndexingPolicySet;
}

export type SemanticUnitLineageDecision =
  | {
      readonly kind: "inherited";
      readonly unitId: string;
      readonly provisionalUnitId: string;
      readonly match: "document_root" | "heading_block" | "block_jaccard";
      readonly score: number;
    }
  | {
      readonly kind: "created";
      readonly unitId: string;
      readonly reason:
        | "ambiguous"
        | "merge"
        | "new"
        | "policy_changed"
        | "split";
    }
  | {
      readonly kind: "removed";
      readonly unitId: string;
      readonly reason:
        | "ambiguous"
        | "deleted"
        | "merge"
        | "policy_changed"
        | "split";
    };

export interface SemanticUnitLineageResult {
  readonly units: readonly DocumentSemanticUnit[];
  readonly decisions: readonly SemanticUnitLineageDecision[];
}

export type SemanticUnitLineageErrorCode =
  | "conflicting_provisional_id"
  | "incomplete_current_document"
  | "incomplete_previous_document"
  | "inconsistent_segmentation_policy"
  | "invalid_current_document"
  | "invalid_current_units"
  | "invalid_previous_document"
  | "invalid_previous_units"
  | "mismatched_document_identity";

export class SemanticUnitLineageError extends Error {
  constructor(
    readonly code: SemanticUnitLineageErrorCode,
    readonly issues: readonly ModelValidationIssue[] = [],
  ) {
    super(`Semantic Unit lineage failed: ${code}`);
    this.name = "SemanticUnitLineageError";
  }
}

interface UnitMatch {
  readonly currentId: string;
  readonly previousId: string;
  readonly match: "document_root" | "heading_block" | "block_jaccard";
  readonly score: number;
}

export function reconcileSemanticUnitLineage(
  input: ReconcileSemanticUnitLineageInput,
): SemanticUnitLineageResult {
  validateInput(input);
  const policy = parseDocumentIndexingPolicy(
    input.policy ?? DEFAULT_DOCUMENT_INDEXING_POLICY,
  );
  const policyChanged = hasLineageBoundaryChanged(input, policy);
  const matches = policyChanged ? [] : matchUnits(input, policy.lineage);
  const previousIdByCurrentId = new Map(
    matches.map((match) => [match.currentId, match.previousId]),
  );
  const remappedUnits = remapUnits(
    input.currentDocument,
    input.currentUnits,
    previousIdByCurrentId,
    policy.textMeasureProfile.version,
  );
  assertValidDocumentSemanticUnits(input.currentDocument, remappedUnits);

  return {
    units: remappedUnits,
    decisions: buildDecisions(input, matches, policyChanged),
  };
}

function validateInput(input: ReconcileSemanticUnitLineageInput): void {
  const previousDocumentIssues = validateNormalizedDocument(input.previousDocument);
  if (previousDocumentIssues.length > 0) {
    throw new SemanticUnitLineageError(
      "invalid_previous_document",
      previousDocumentIssues,
    );
  }
  const currentDocumentIssues = validateNormalizedDocument(input.currentDocument);
  if (currentDocumentIssues.length > 0) {
    throw new SemanticUnitLineageError(
      "invalid_current_document",
      currentDocumentIssues,
    );
  }
  if (input.previousDocument.completeness.status !== "complete") {
    throw new SemanticUnitLineageError("incomplete_previous_document");
  }
  if (input.currentDocument.completeness.status !== "complete") {
    throw new SemanticUnitLineageError("incomplete_current_document");
  }
  const previousUnitIssues = validateDocumentSemanticUnits(
    input.previousDocument,
    input.previousUnits,
  );
  if (previousUnitIssues.length > 0) {
    throw new SemanticUnitLineageError(
      "invalid_previous_units",
      previousUnitIssues,
    );
  }
  const currentUnitIssues = validateDocumentSemanticUnits(
    input.currentDocument,
    input.currentUnits,
  );
  if (currentUnitIssues.length > 0) {
    throw new SemanticUnitLineageError("invalid_current_units", currentUnitIssues);
  }
  if (
    input.previousDocument.sourceId !== input.currentDocument.sourceId ||
    input.previousDocument.documentId !== input.currentDocument.documentId
  ) {
    throw new SemanticUnitLineageError("mismatched_document_identity");
  }
  const previousIds = new Set(input.previousUnits.map((unit) => unit.id));
  if (input.currentUnits.some((unit) => previousIds.has(unit.id))) {
    throw new SemanticUnitLineageError("conflicting_provisional_id");
  }
  if (
    new Set(input.previousUnits.map((unit) => unit.segmentationPolicyVersion))
      .size !== 1 ||
    new Set(input.currentUnits.map((unit) => unit.segmentationPolicyVersion))
      .size !== 1
  ) {
    throw new SemanticUnitLineageError("inconsistent_segmentation_policy");
  }
}

function hasLineageBoundaryChanged(
  input: ReconcileSemanticUnitLineageInput,
  policy: DocumentIndexingPolicySet,
): boolean {
  const previousVersion = input.previousUnits[0]?.segmentationPolicyVersion;
  const currentVersion = input.currentUnits[0]?.segmentationPolicyVersion;
  return (
    previousVersion !== currentVersion ||
    currentVersion !== policy.segmentation.version ||
    input.previousDocument.lineagePolicyVersion !==
      input.currentDocument.lineagePolicyVersion ||
    input.currentDocument.lineagePolicyVersion !== policy.lineage.version
  );
}

function matchUnits(
  input: ReconcileSemanticUnitLineageInput,
  policy: LineagePolicy,
): readonly UnitMatch[] {
  const matches: UnitMatch[] = [];
  const usedPreviousIds = new Set<string>();
  const matchedCurrentIds = new Set<string>();
  const previousRoot = input.previousUnits.find((unit) => unit.kind === "document");
  const currentRoot = input.currentUnits.find((unit) => unit.kind === "document");
  if (previousRoot !== undefined && currentRoot !== undefined) {
    matches.push({
      currentId: currentRoot.id,
      previousId: previousRoot.id,
      match: "document_root",
      score: 1,
    });
    usedPreviousIds.add(previousRoot.id);
    matchedCurrentIds.add(currentRoot.id);
  }

  const previousHeadingUnitByBlockId = new Map(
    input.previousUnits.flatMap((unit) => {
      const headingId = explicitHeadingBlockId(unit, input.previousDocument);
      return headingId === undefined ? [] : [[headingId, unit] as const];
    }),
  );
  for (const current of input.currentUnits) {
    if (matchedCurrentIds.has(current.id)) {
      continue;
    }
    const headingId = explicitHeadingBlockId(current, input.currentDocument);
    const previous =
      headingId === undefined ? undefined : previousHeadingUnitByBlockId.get(headingId);
    if (previous === undefined || usedPreviousIds.has(previous.id)) {
      continue;
    }
    matches.push({
      currentId: current.id,
      previousId: previous.id,
      match: "heading_block",
      score: 1,
    });
    usedPreviousIds.add(previous.id);
    matchedCurrentIds.add(current.id);
  }

  const currentCandidates = input.currentUnits.filter(
    (unit) => !matchedCurrentIds.has(unit.id),
  );
  const previousCandidates = input.previousUnits.filter(
    (unit) => !usedPreviousIds.has(unit.id),
  );
  const overlap = createOverlapIndex(currentCandidates, previousCandidates);

  for (const current of currentCandidates) {
    const scoredPrevious = scoreCandidates(
      current,
      overlap.previousByCurrent.get(current.id) ?? [],
    );
    const best = scoredPrevious[0];
    if (
      best === undefined ||
      !isClearBest(best.score, scoredPrevious[1]?.score, policy)
    ) {
      continue;
    }
    const scoredCurrent = scoreCandidates(
      best.unit,
      overlap.currentByPrevious.get(best.unit.id) ?? [],
    );
    const reverseBest = scoredCurrent[0];
    if (
      reverseBest?.unit.id !== current.id ||
      !isClearBest(reverseBest.score, scoredCurrent[1]?.score, policy)
    ) {
      continue;
    }
    matches.push({
      currentId: current.id,
      previousId: best.unit.id,
      match: "block_jaccard",
      score: best.score,
    });
  }

  return matches;
}

function explicitHeadingBlockId(
  unit: DocumentSemanticUnit,
  document: NormalizedDocument,
): string | undefined {
  if (unit.kind !== "section" || unit.boundary.kind !== "explicit_heading") {
    return undefined;
  }
  const firstBlockId = unit.blockIds[0];
  const firstBlock = document.blocks.find((block) => block.id === firstBlockId);
  return firstBlock?.kind === "heading" ? firstBlock.id : undefined;
}

function createOverlapIndex(
  currentUnits: readonly DocumentSemanticUnit[],
  previousUnits: readonly DocumentSemanticUnit[],
): {
  readonly previousByCurrent: ReadonlyMap<string, readonly DocumentSemanticUnit[]>;
  readonly currentByPrevious: ReadonlyMap<string, readonly DocumentSemanticUnit[]>;
} {
  const previousByCurrent = new Map<string, readonly DocumentSemanticUnit[]>();
  const currentByPrevious = new Map<string, DocumentSemanticUnit[]>();
  const previousByBlockId = new Map<string, DocumentSemanticUnit>();
  for (const previous of previousUnits) {
    for (const blockId of previous.blockIds) {
      previousByBlockId.set(blockId, previous);
    }
  }
  for (const current of currentUnits) {
    const previous = [
      ...new Set(
        current.blockIds
          .map((blockId) => previousByBlockId.get(blockId))
          .filter(
            (candidate): candidate is DocumentSemanticUnit =>
              candidate !== undefined && candidate.kind === current.kind,
          ),
      ),
    ];
    previousByCurrent.set(current.id, previous);
    for (const candidate of previous) {
      const currentForPrevious = currentByPrevious.get(candidate.id) ?? [];
      currentForPrevious.push(current);
      currentByPrevious.set(candidate.id, currentForPrevious);
    }
  }
  return { previousByCurrent, currentByPrevious };
}

function scoreCandidates(
  target: DocumentSemanticUnit,
  candidates: readonly DocumentSemanticUnit[],
): readonly { readonly unit: DocumentSemanticUnit; readonly score: number }[] {
  return candidates
    .filter((candidate) => candidate.kind === target.kind)
    .map((unit) => ({ unit, score: blockIdJaccard(target, unit) }))
    .sort(
      (left, right) =>
        right.score - left.score || left.unit.id.localeCompare(right.unit.id),
    );
}

function isClearBest(
  best: number,
  runnerUp: number | undefined,
  policy: LineagePolicy,
): boolean {
  return (
    best >= policy.unitMinBlockIdJaccard &&
    best - (runnerUp ?? 0) >= policy.unitMinRunnerUpMargin
  );
}

function blockIdJaccard(
  left: DocumentSemanticUnit,
  right: DocumentSemanticUnit,
): number {
  const intersection = blockIntersection(left, right);
  const union = new Set([...left.blockIds, ...right.blockIds]).size;
  return union === 0 ? 0 : intersection / union;
}

function blockIntersection(
  left: DocumentSemanticUnit,
  right: DocumentSemanticUnit,
): number {
  const rightIds = new Set(right.blockIds);
  return left.blockIds.filter((id) => rightIds.has(id)).length;
}

function remapUnits(
  document: NormalizedDocument,
  units: readonly DocumentSemanticUnit[],
  previousIdByCurrentId: ReadonlyMap<string, string>,
  textMeasureProfileVersion: string,
): readonly DocumentSemanticUnit[] {
  const finalId = (id: string): string => previousIdByCurrentId.get(id) ?? id;
  const revisionContext = createSemanticUnitRevisionContext(
    document,
    textMeasureProfileVersion,
  );
  return units.map((unit) => {
    const remapped = {
      id: finalId(unit.id),
      sourceId: unit.sourceId,
      documentId: unit.documentId,
      kind: unit.kind,
      ...(unit.title === undefined ? {} : { title: unit.title }),
      ...(unit.parentId === undefined ? {} : { parentId: finalId(unit.parentId) }),
      childIds: unit.childIds.map(finalId),
      blockIds: unit.blockIds,
      boundary: unit.boundary,
      contentDigest: unit.contentDigest,
      segmentationPolicyVersion: unit.segmentationPolicyVersion,
    };
    return {
      ...remapped,
      revisionId: revisionContext.revisionId(remapped),
      observationId: document.observationId,
      diagnostics: unit.diagnostics,
    };
  });
}

function buildDecisions(
  input: ReconcileSemanticUnitLineageInput,
  matches: readonly UnitMatch[],
  policyChanged: boolean,
): readonly SemanticUnitLineageDecision[] {
  const matchByCurrent = new Map(matches.map((match) => [match.currentId, match]));
  const matchedPrevious = new Set(matches.map((match) => match.previousId));
  const overlap = createOverlapIndex(input.currentUnits, input.previousUnits);
  const currentDecisions = input.currentUnits.map((unit): SemanticUnitLineageDecision => {
    const match = matchByCurrent.get(unit.id);
    if (match !== undefined) {
      return {
        kind: "inherited",
        unitId: match.previousId,
        provisionalUnitId: match.currentId,
        match: match.match,
        score: match.score,
      };
    }
    return {
      kind: "created",
      unitId: unit.id,
      reason: policyChanged ? "policy_changed" : currentCreationReason(unit, overlap),
    };
  });
  const removedDecisions = input.previousUnits
    .filter((unit) => !matchedPrevious.has(unit.id))
    .map((unit): SemanticUnitLineageDecision => ({
      kind: "removed",
      unitId: unit.id,
      reason: policyChanged ? "policy_changed" : previousRemovalReason(unit, overlap),
    }));
  return [...currentDecisions, ...removedDecisions];
}

function currentCreationReason(
  unit: DocumentSemanticUnit,
  overlap: ReturnType<typeof createOverlapIndex>,
): "ambiguous" | "merge" | "new" | "split" {
  const previous = overlap.previousByCurrent.get(unit.id) ?? [];
  if (previous.length > 1) {
    return "merge";
  }
  if (
    previous.length === 1 &&
    (overlap.currentByPrevious.get(previous[0]?.id ?? "")?.length ?? 0) > 1
  ) {
    return "split";
  }
  return previous.length === 0 ? "new" : "ambiguous";
}

function previousRemovalReason(
  unit: DocumentSemanticUnit,
  overlap: ReturnType<typeof createOverlapIndex>,
): "ambiguous" | "deleted" | "merge" | "split" {
  const current = overlap.currentByPrevious.get(unit.id) ?? [];
  if (current.length > 1) {
    return "split";
  }
  if (
    current.length === 1 &&
    (overlap.previousByCurrent.get(current[0]?.id ?? "")?.length ?? 0) > 1
  ) {
    return "merge";
  }
  return current.length === 0 ? "deleted" : "ambiguous";
}
