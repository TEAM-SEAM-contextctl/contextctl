import {
  LINEAGE_POLICY_VERSION,
  sha256Digest,
  toAnalysisText,
  type DocumentBlock,
  type NormalizedDocument,
} from "../../src/index.js";
import { structuralId } from "./root-id-fixture.js";

export type SegmentationFixtureBlock =
  | {
      readonly kind: "heading";
      readonly level: 1 | 2 | 3 | 4 | 5 | 6;
      readonly text: string;
    }
  | {
      readonly kind: "paragraph" | "code" | "quote";
      readonly text: string;
    };

export interface BoundaryMetrics {
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
  readonly pk: number;
  readonly windowDiff: number;
}

export function createSegmentationDocument(
  specifications: readonly SegmentationFixtureBlock[],
  completeness: "complete" | "partial" = "complete",
): NormalizedDocument {
  const blocks: DocumentBlock[] = [];
  const headings: Array<{ id: string; level: number }> = [];
  let offset = 0;

  for (const [order, specification] of specifications.entries()) {
    const id = structuralId("blk", order);
    if (specification.kind === "heading") {
      while ((headings.at(-1)?.level ?? 0) >= specification.level) {
        headings.pop();
      }
      headings.push({ id, level: specification.level });
    }
    const sectionPath = headings.map((heading) => heading.id);
    const sourceSpan = {
      kind: "text" as const,
      startOffset: offset,
      endOffset: offset + specification.text.length,
      startLine: order * 2 + 1,
      endLine: order * 2 + 1,
    };
    const common = {
      id,
      revisionId: `brv_${"a".repeat(16)}`,
      order,
      sectionPath,
      text: specification.text,
      analysisText: toAnalysisText(specification.text),
      contentDigest: sha256Digest(specification.text),
      sourceSpan,
    };
    if (specification.kind === "heading") {
      blocks.push({
        ...common,
        kind: "heading",
        structure: { kind: "heading", level: specification.level },
      });
    } else if (specification.kind === "code") {
      blocks.push({
        ...common,
        kind: "code",
        structure: { kind: "code" },
      });
    } else if (specification.kind === "quote") {
      blocks.push({
        ...common,
        kind: "quote",
        structure: { kind: "quote", depth: 1 },
      });
    } else {
      blocks.push({
        ...common,
        kind: "paragraph",
        structure: { kind: "paragraph" },
      });
    }
    offset = sourceSpan.endOffset + 2;
  }

  const canonicalText = specifications
    .map((specification) => specification.text)
    .join("\n\n");
  return {
    schemaVersion: 1,
    documentId: "doc_segmentation",
    sourceId: "src_segmentation",
    observationId: "obs_segmentation",
    mediaType: "text/markdown",
    title: "Segmentation fixture",
    parser: { id: "fixture-parser", version: "1.0.0" },
    normalizationPolicyVersion: "document-normalization-v1",
    lineagePolicyVersion: LINEAGE_POLICY_VERSION,
    contentDigest: sha256Digest(canonicalText),
    completeness: {
      status: completeness,
      diagnostics:
        completeness === "complete"
          ? []
          : [{ code: "fixture_partial", severity: "warning" }],
    },
    blocks,
  };
}

export function repeatedTopic(
  terms: readonly string[],
  repetitions = 24,
): string {
  return Array.from({ length: repetitions }, () => terms.join(" ")).join(" ");
}

export function evaluateBoundaries(
  expected: readonly number[],
  predicted: readonly number[],
  blockCount: number,
): BoundaryMetrics {
  assertValidBoundaryFixture(expected, blockCount, "expected");
  assertValidBoundaryFixture(predicted, blockCount, "predicted");
  const expectedSet = new Set(expected);
  const predictedSet = new Set(predicted);
  const truePositive = predicted.filter((value) => expectedSet.has(value)).length;
  const precision =
    predicted.length === 0 ? (expected.length === 0 ? 1 : 0) : truePositive / predicted.length;
  const recall =
    expected.length === 0 ? 1 : truePositive / expected.length;
  const f1 =
    precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const segmentLengths = boundarySegmentLengths(expected, blockCount);
  const averageSegmentLength =
    segmentLengths.reduce((sum, length) => sum + length, 0) /
    Math.max(1, segmentLengths.length);
  const window = Math.max(1, Math.round(averageSegmentLength / 2));
  let pkErrors = 0;
  let windowDiffErrors = 0;
  let comparisons = 0;

  for (let start = 0; start + window < blockCount; start += 1) {
    const end = start + window;
    const expectedSame = countBoundaries(expectedSet, start, end) === 0;
    const predictedSame = countBoundaries(predictedSet, start, end) === 0;
    if (expectedSame !== predictedSame) {
      pkErrors += 1;
    }
    if (
      countBoundaries(expectedSet, start, end) !==
      countBoundaries(predictedSet, start, end)
    ) {
      windowDiffErrors += 1;
    }
    comparisons += 1;
  }

  return {
    precision,
    recall,
    f1,
    pk: comparisons === 0 ? 0 : pkErrors / comparisons,
    windowDiff: comparisons === 0 ? 0 : windowDiffErrors / comparisons,
  };
}

function assertValidBoundaryFixture(
  boundaries: readonly number[],
  blockCount: number,
  label: "expected" | "predicted",
): void {
  if (!Number.isInteger(blockCount) || blockCount < 1) {
    throw new RangeError("blockCount must be a positive integer");
  }
  let previous = 0;
  for (const boundary of boundaries) {
    if (
      !Number.isInteger(boundary) ||
      boundary <= previous ||
      boundary >= blockCount
    ) {
      throw new RangeError(
        `${label} boundaries must be strictly increasing integers within the document`,
      );
    }
    previous = boundary;
  }
}

function boundarySegmentLengths(
  boundaries: readonly number[],
  blockCount: number,
): readonly number[] {
  const points = [0, ...boundaries, blockCount];
  return points.slice(1).map((point, index) => point - requiredAt(points, index));
}

function countBoundaries(
  boundaries: ReadonlySet<number>,
  start: number,
  end: number,
): number {
  let count = 0;
  for (const boundary of boundaries) {
    if (boundary > start && boundary <= end) {
      count += 1;
    }
  }
  return count;
}

function requiredAt<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) {
    throw new RangeError("fixture index is out of range");
  }
  return value;
}
