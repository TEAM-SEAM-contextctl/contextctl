import {
  assertValidDocumentSemanticUnits,
  type DocumentBlock,
  type DocumentSemanticUnit,
  type NormalizedDocument,
  type SegmentationDiagnostic,
  type SemanticBoundary,
  validateNormalizedDocument,
} from "./document-model.js";
import {
  DEFAULT_DOCUMENT_INDEXING_POLICY,
  measureText,
  parseDocumentIndexingPolicy,
  type DocumentIndexingPolicySet,
  type SegmentationPolicy,
  type TextMeasureProfile,
} from "./document-indexing-policy.js";
import { type ModelValidationIssue } from "./model-validation.js";
import { sha256Digest } from "./document-capture.js";
import { findLexicalBoundaries } from "./lexical-cohesion.js";
import {
  createSemanticUnitRevisionContext,
  type SemanticUnitRevisionContext,
} from "./semantic-unit-revision.js";

const UNIT_ID_PATTERN = /^unit_[a-z0-9]+(?:[a-z0-9_-]*[a-z0-9])?$/;

export interface SemanticUnitIdSource {
  nextUnitId(): string;
}

export interface SegmentNormalizedDocumentInput {
  readonly document: NormalizedDocument;
  readonly ids: SemanticUnitIdSource;
  readonly policy?: DocumentIndexingPolicySet;
}

export type DocumentSegmentationErrorCode =
  | "duplicate_unit_id"
  | "incomplete_document"
  | "invalid_document"
  | "invalid_unit_id";

export class DocumentSegmentationError extends Error {
  constructor(
    readonly code: DocumentSegmentationErrorCode,
    readonly issues: readonly ModelValidationIssue[] = [],
  ) {
    super(`Document segmentation failed: ${code}`);
    this.name = "DocumentSegmentationError";
  }
}

/**
 * Converts a validated document snapshot into one deterministic Unit tree.
 * Unit identity allocation is injected so the next lineage stage can replace
 * newly allocated IDs with safely inherited IDs without changing boundaries.
 */
export function segmentNormalizedDocument(
  input: SegmentNormalizedDocumentInput,
): readonly DocumentSemanticUnit[] {
  const documentIssues = validateNormalizedDocument(input.document);
  if (documentIssues.length > 0) {
    throw new DocumentSegmentationError("invalid_document", documentIssues);
  }
  if (input.document.completeness.status !== "complete") {
    throw new DocumentSegmentationError("incomplete_document");
  }

  const policy = parseDocumentIndexingPolicy(
    input.policy ?? DEFAULT_DOCUMENT_INDEXING_POLICY,
  );
  const root = createRootPlan(input.document);
  const sectionByHeadingId = createSectionPlans(input.document, root);
  assignNonHeadingBlocks(input.document, root, sectionByHeadingId);
  splitOversizedOwners(
    root,
    policy.segmentation,
    policy.textMeasureProfile,
  );

  const plans = orderPlans(root);
  const idByPlan = allocateUnitIds(plans, input.ids);
  const revisionContext = createSemanticUnitRevisionContext(
    input.document,
    policy.textMeasureProfile.version,
  );
  const units = plans.map((plan) =>
    materializeUnit(plan, input.document, policy, idByPlan, revisionContext),
  );
  assertValidDocumentSemanticUnits(input.document, units);
  return units;
}

interface UnitPlan {
  readonly sequence: number;
  readonly kind: DocumentSemanticUnit["kind"];
  readonly title?: string;
  readonly boundary: SemanticBoundary;
  readonly diagnostics: SegmentationDiagnostic[];
  readonly children: UnitPlan[];
  parent?: UnitPlan;
  blocks: DocumentBlock[];
}

function createRootPlan(document: NormalizedDocument): UnitPlan {
  return {
    sequence: -1,
    kind: "document",
    ...(document.title === undefined ? {} : { title: document.title }),
    boundary: { kind: "document_root" },
    diagnostics: [],
    children: [],
    blocks: [],
  };
}

function createSectionPlans(
  document: NormalizedDocument,
  root: UnitPlan,
): ReadonlyMap<string, UnitPlan> {
  const sectionByHeadingId = new Map<string, UnitPlan>();
  for (const block of document.blocks) {
    if (block.kind !== "heading") {
      continue;
    }
    const parentHeadingId = block.sectionPath.at(-2);
    const parent =
      parentHeadingId === undefined
        ? root
        : sectionByHeadingId.get(parentHeadingId);
    if (parent === undefined) {
      throw new DocumentSegmentationError("invalid_document");
    }
    const section: UnitPlan = {
      sequence: block.order,
      kind: "section",
      title: block.text,
      boundary: { kind: "explicit_heading" },
      diagnostics: [],
      children: [],
      parent,
      blocks: [block],
    };
    parent.children.push(section);
    sectionByHeadingId.set(block.id, section);
  }
  return sectionByHeadingId;
}

function assignNonHeadingBlocks(
  document: NormalizedDocument,
  root: UnitPlan,
  sectionByHeadingId: ReadonlyMap<string, UnitPlan>,
): void {
  for (const block of document.blocks) {
    if (block.kind === "heading") {
      continue;
    }
    const sectionId = block.sectionPath.at(-1);
    const owner =
      sectionId === undefined ? root : sectionByHeadingId.get(sectionId);
    if (owner === undefined) {
      throw new DocumentSegmentationError("invalid_document");
    }
    owner.blocks.push(block);
  }
}

function splitOversizedOwners(
  root: UnitPlan,
  policy: SegmentationPolicy,
  profile: TextMeasureProfile,
): void {
  const structuralOwners = collectPlans(root).filter(
    (plan) => plan.kind !== "segment",
  );
  for (const owner of structuralOwners) {
    const firstBodyIndex = owner.kind === "section" ? 1 : 0;
    const body = owner.blocks.slice(firstBodyIndex);
    if (body.length === 0) {
      recordOversizedAtomicBlock(owner, owner.blocks, policy, profile);
      continue;
    }

    const ownerTokens = measureBlocks(owner.blocks, profile);
    const headinglessDocument =
      owner.kind === "document" &&
      owner.children.every((child) => child.kind !== "section");
    if (!headinglessDocument && ownerTokens <= policy.maxUnitTokens) {
      continue;
    }
    if (
      owner.kind === "document" &&
      !headinglessDocument &&
      measureBlocks(body, profile) <= policy.maxUnitTokens
    ) {
      continue;
    }

    owner.blocks = owner.blocks.slice(0, firstBodyIndex);
    const segments = segmentBlockRegion(body, policy, profile);
    for (const segment of segments) {
      segment.parent = owner;
      owner.children.push(segment);
    }
    recordOversizedAtomicBlock(owner, owner.blocks, policy, profile);
  }
}

function segmentBlockRegion(
  blocks: readonly DocumentBlock[],
  policy: SegmentationPolicy,
  profile: TextMeasureProfile,
): readonly UnitPlan[] {
  const lexicalGaps = findLexicalBoundaries(blocks, policy, profile);
  if (lexicalGaps.length === 0) {
    return sizeFallbackPlans(blocks, policy, profile);
  }

  const plans: UnitPlan[] = [];
  let start = 0;
  for (let index = 0; index <= lexicalGaps.length; index += 1) {
    const precedingGap = lexicalGaps[index - 1];
    const followingGap = lexicalGaps[index];
    const end = followingGap?.gap ?? blocks.length;
    const group = blocks.slice(start, end);
    if (measureBlocks(group, profile) > policy.maxUnitTokens) {
      plans.push(...sizeFallbackPlans(group, policy, profile));
    } else {
      const strength = precedingGap?.strength ?? followingGap?.strength ?? 0;
      plans.push(
        createSegmentPlan(group, {
          kind: "lexical",
          strength,
        }),
      );
    }
    start = end;
  }
  return plans;
}

function sizeFallbackPlans(
  blocks: readonly DocumentBlock[],
  policy: SegmentationPolicy,
  profile: TextMeasureProfile,
): readonly UnitPlan[] {
  const groups: DocumentBlock[][] = [];
  let current: DocumentBlock[] = [];
  let currentTokens = 0;

  const flush = (): void => {
    if (current.length > 0) {
      groups.push(current);
      current = [];
      currentTokens = 0;
    }
  };

  for (const block of blocks) {
    const blockTokens = measureText(block.analysisText, profile);
    if (blockTokens > policy.maxUnitTokens) {
      flush();
      groups.push([block]);
      continue;
    }
    if (
      current.length > 0 &&
      (currentTokens + blockTokens > policy.maxUnitTokens ||
        currentTokens >= policy.targetUnitTokens)
    ) {
      flush();
    }
    current.push(block);
    currentTokens += blockTokens;
  }
  flush();

  const last = groups.at(-1);
  const previous = groups.at(-2);
  if (
    last !== undefined &&
    previous !== undefined &&
    measureBlocks(last, profile) < policy.minUnitTokens &&
    measureBlocks([...previous, ...last], profile) <= policy.maxUnitTokens
  ) {
    groups.splice(groups.length - 2, 2, [...previous, ...last]);
  }

  return groups.map((group) => {
    const diagnostics: SegmentationDiagnostic[] = [
      {
        code: "size_fallback_applied",
        blockIds: group.map((block) => block.id),
      },
    ];
    const oversized = group.filter(
      (block) => measureText(block.analysisText, profile) > policy.maxUnitTokens,
    );
    if (oversized.length > 0) {
      diagnostics.push({
        code: "oversized_atomic_block",
        blockIds: oversized.map((block) => block.id),
      });
    }
    return createSegmentPlan(group, { kind: "size_fallback" }, diagnostics);
  });
}

function createSegmentPlan(
  blocks: readonly DocumentBlock[],
  boundary: SemanticBoundary,
  diagnostics: readonly SegmentationDiagnostic[] = [],
): UnitPlan {
  const first = blocks[0];
  if (first === undefined) {
    throw new DocumentSegmentationError("invalid_document");
  }
  return {
    sequence: first.order,
    kind: "segment",
    boundary,
    diagnostics: [...diagnostics],
    children: [],
    blocks: [...blocks],
  };
}

function recordOversizedAtomicBlock(
  owner: UnitPlan,
  blocks: readonly DocumentBlock[],
  policy: SegmentationPolicy,
  profile: TextMeasureProfile,
): void {
  const oversized = blocks.filter(
    (block) => measureText(block.analysisText, profile) > policy.maxUnitTokens,
  );
  if (oversized.length > 0) {
    owner.diagnostics.push({
      code: "oversized_atomic_block",
      blockIds: oversized.map((block) => block.id),
    });
  }
}

function orderPlans(root: UnitPlan): readonly UnitPlan[] {
  return [
    root,
    ...collectPlans(root)
      .filter((plan) => plan !== root)
      .sort((left, right) => left.sequence - right.sequence),
  ];
}

function collectPlans(root: UnitPlan): readonly UnitPlan[] {
  const plans: UnitPlan[] = [];
  const visit = (plan: UnitPlan): void => {
    plans.push(plan);
    for (const child of plan.children) {
      visit(child);
    }
  };
  visit(root);
  return plans;
}

function allocateUnitIds(
  plans: readonly UnitPlan[],
  ids: SemanticUnitIdSource,
): ReadonlyMap<UnitPlan, string> {
  const idByPlan = new Map<UnitPlan, string>();
  const allocated = new Set<string>();
  for (const plan of plans) {
    let allocatedId: string | undefined;
    for (let attempt = 0; attempt < 1_024; attempt += 1) {
      const candidate = ids.nextUnitId();
      if (!UNIT_ID_PATTERN.test(candidate)) {
        throw new DocumentSegmentationError("invalid_unit_id");
      }
      if (!allocated.has(candidate)) {
        allocatedId = candidate;
        break;
      }
    }
    if (allocatedId === undefined) {
      throw new DocumentSegmentationError("duplicate_unit_id");
    }
    allocated.add(allocatedId);
    idByPlan.set(plan, allocatedId);
  }
  return idByPlan;
}

function materializeUnit(
  plan: UnitPlan,
  document: NormalizedDocument,
  policy: DocumentIndexingPolicySet,
  idByPlan: ReadonlyMap<UnitPlan, string>,
  revisionContext: SemanticUnitRevisionContext,
): DocumentSemanticUnit {
  const id = requiredMapValue(idByPlan, plan);
  const parentId =
    plan.parent === undefined ? undefined : requiredMapValue(idByPlan, plan.parent);
  const childIds = [...plan.children]
    .sort((left, right) => left.sequence - right.sequence)
    .map((child) => requiredMapValue(idByPlan, child));
  const blockIds = plan.blocks.map((block) => block.id);
  const contentDigest =
    plan.kind === "document"
      ? document.contentDigest
      : sha256Digest(plan.blocks.map((block) => block.text).join("\n\n"));
  const unit = {
    id,
    sourceId: document.sourceId,
    documentId: document.documentId,
    kind: plan.kind,
    ...(plan.title === undefined ? {} : { title: plan.title }),
    ...(parentId === undefined ? {} : { parentId }),
    childIds,
    blockIds,
    boundary: plan.boundary,
    contentDigest,
    segmentationPolicyVersion: policy.segmentation.version,
  };
  return {
    ...unit,
    revisionId: revisionContext.revisionId(unit),
    observationId: document.observationId,
    diagnostics: plan.diagnostics,
  };
}

function measureBlocks(
  blocks: readonly DocumentBlock[],
  profile: TextMeasureProfile,
): number {
  return blocks.reduce(
    (total, block) => total + measureText(block.analysisText, profile),
    0,
  );
}


function requiredMapValue<K, V>(values: ReadonlyMap<K, V>, key: K): V {
  const value = values.get(key);
  if (value === undefined) {
    throw new DocumentSegmentationError("invalid_document");
  }
  return value;
}
