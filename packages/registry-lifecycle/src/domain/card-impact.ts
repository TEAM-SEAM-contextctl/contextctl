import type {
  PublishedChange,
  PublishedKnowledgeUnit,
} from "@contextctl/contracts";

import type { CardVersion } from "./card-version.js";
import type { RetrievalScope } from "./retrieval-scope.js";

/**
 * What must happen to a Card because the source changed.
 *
 * - `none`: the change belongs to another knowledge unit.
 * - `review`: the Card still resolves, but a new version needs checking.
 * - `block`: a coordinate the Card referenced is gone, so it cannot be trusted.
 * - `disable`: the knowledge the Card described no longer exists.
 */
export type CardImpactDecision = "none" | "review" | "block" | "disable";

/** Why a decision was reached, so operators can audit the rule that fired. */
export interface CardImpactReason {
  readonly rule: string;
  readonly message: string;
}

export interface CardImpact {
  readonly cardId: string;
  readonly decision: CardImpactDecision;
  readonly reasons: readonly CardImpactReason[];
}

/**
 * Decides a Card's fate from a Published Change and structural comparison.
 *
 * The change kind alone is not enough: an `updated` document paragraph and an
 * `updated` table that lost a column both arrive as `updated`. So the Card's
 * existing scopes are compared against the freshly observed coordinate, and
 * that comparison — not the change kind — separates review from block.
 *
 * `currentUnit` is absent exactly when the change removed the unit, because a
 * removed knowledge unit never appears in the publication's current units.
 */
export function analyzeCardImpact(
  currentVersion: CardVersion,
  change: PublishedChange,
  currentUnit: PublishedKnowledgeUnit | undefined,
): CardImpact {
  const cardId = currentVersion.cardId;

  if (change.knowledgeUnitId !== currentVersion.lineage.knowledgeUnitId) {
    return { cardId, decision: "none", reasons: [] };
  }

  if (change.kind === "removed") {
    return {
      cardId,
      decision: "disable",
      reasons: [
        {
          rule: "change.removed",
          message: `knowledge unit ${change.knowledgeUnitId} no longer exists in the source`,
        },
      ],
    };
  }

  if (currentUnit === undefined) {
    // The contract guarantees added and updated units are present; a missing
    // one means the publication cannot justify keeping the Card serving.
    return {
      cardId,
      decision: "block",
      reasons: [
        {
          rule: "change.unitMissing",
          message: `knowledge unit ${change.knowledgeUnitId} was ${change.kind} but is absent from the publication`,
        },
      ],
    };
  }

  const lost = currentVersion.scopes.flatMap((scope) =>
    findLostCoordinates(scope, currentUnit),
  );
  if (lost.length > 0) {
    return { cardId, decision: "block", reasons: lost };
  }

  const reasons = [
    ...findIndexDrift(currentVersion.scopes, currentUnit),
    ...describeContentChange(change),
  ];

  return reasons.length > 0
    ? { cardId, decision: "review", reasons }
    : { cardId, decision: "none", reasons: [] };
}

/** Coordinates the Card points at that the new observation no longer has. */
function findLostCoordinates(
  scope: RetrievalScope,
  unit: PublishedKnowledgeUnit,
): CardImpactReason[] {
  const coordinate = unit.sourceCoordinate;

  if (scope.kind === "sql_source") {
    if (coordinate.kind !== "sql_table") {
      return [
        {
          rule: "scope.kindDrift",
          message: `card scope sql_source no longer matches ${coordinate.kind} coordinate`,
        },
      ];
    }
    if (scope.table !== coordinate.table) {
      return [
        {
          rule: "scope.sql.tableRemoved",
          message: `table ${scope.table} is no longer observed`,
        },
      ];
    }
    return scope.columns
      .filter((column) => !coordinate.columns.includes(column))
      .map((column) => ({
        rule: "scope.sql.columnRemoved",
        message: `column ${column} referenced by the card no longer exists in ${scope.table}`,
      }));
  }

  if (scope.kind === "http_source") {
    if (coordinate.kind !== "http_operation") {
      return [
        {
          rule: "scope.kindDrift",
          message: `card scope http_source no longer matches ${coordinate.kind} coordinate`,
        },
      ];
    }
    return scope.method === coordinate.method && scope.path === coordinate.path
      ? []
      : [
          {
            rule: "scope.http.operationRemoved",
            message: `operation ${scope.method} ${scope.path} is no longer observed`,
          },
        ];
  }

  if (coordinate.kind !== "document") {
    return [
      {
        rule: "scope.kindDrift",
        message: `card scope managed_document no longer matches ${coordinate.kind} coordinate`,
      },
    ];
  }
  if (scope.documentIndex.documentId !== coordinate.documentId) {
    return [
      {
        rule: "scope.document.documentRemoved",
        message: `document ${scope.documentIndex.documentId} is no longer observed`,
      },
    ];
  }
  return scope.selection.kind === "semantic_units" &&
    !scope.selection.semanticUnitIds.includes(coordinate.semanticUnitId)
    ? [
        {
          rule: "scope.document.semanticUnitRemoved",
          message: `semantic unit ${coordinate.semanticUnitId} is no longer covered by the card selection`,
        },
      ]
    : [];
}

/**
 * A new index version means the chunks behind the Card were rebuilt — a
 * re-embedding, or an embedding model change that regenerated the whole index.
 * The Card still resolves, but its grounding was computed against the old one.
 */
function findIndexDrift(
  scopes: readonly RetrievalScope[],
  unit: PublishedKnowledgeUnit,
): CardImpactReason[] {
  return scopes.flatMap((scope) => {
    if (scope.kind !== "managed_document") {
      return [];
    }
    const published = unit.publishedScopes.find(
      (candidate) =>
        candidate.kind === "managed_document" &&
        candidate.documentIndex.documentIndexId ===
          scope.documentIndex.documentIndexId,
    );
    if (published === undefined || published.kind !== "managed_document") {
      return [];
    }
    return published.documentIndex.indexVersion ===
      scope.documentIndex.indexVersion
      ? []
      : [
          {
            rule: "scope.document.indexVersionChanged",
            message: `document index ${scope.documentIndex.documentIndexId} moved from ${scope.documentIndex.indexVersion} to ${published.documentIndex.indexVersion}`,
          },
        ];
  });
}

function describeContentChange(
  change: Extract<PublishedChange, { kind: "added" | "updated" }>,
): CardImpactReason[] {
  return change.kind === "updated"
    ? [
        {
          rule: "change.updated",
          message: `knowledge unit ${change.knowledgeUnitId} changed ${change.changedFields.join(", ")}`,
        },
      ]
    : [];
}
