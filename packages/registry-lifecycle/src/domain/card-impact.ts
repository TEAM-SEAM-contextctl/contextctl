import type {
  PublishedChangedField,
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
 * What the whole Publication says, for a decision one change cannot make alone.
 *
 * `analyzeCardImpact` judges one Card against one change, and that is the right
 * shape for every rule but one: whether an older index version is still safe to
 * serve depends on what *other* changes did to the same index. So the caller
 * computes that once and passes it down, rather than each rule re-reading the
 * Publication.
 */
export interface PublicationImpactContext {
  /**
   * Document indexes this Publication removed knowledge from.
   *
   * Empty for a Publication that only added or updated, which is why the
   * parameter is optional: a caller with no removals has nothing to state.
   */
  readonly documentIndexesWithRemovals?: ReadonlySet<string> | undefined;
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
  context: PublicationImpactContext = {},
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

  const drift = findIndexDrift(currentVersion.scopes, currentUnit, context);
  const reasons = [...drift, ...describeContentChange(change, drift.length > 0)];

  if (reasons.length === 0) {
    return { cardId, decision: "none", reasons: [] };
  }
  // Index drift is normally a review — the Card still resolves, it is just older
  // than its source. It stops being one when the version it is left on is known
  // to hold knowledge the source discarded, and then the Card has to come down
  // for the same reason a removed one does. See ADR 0005.
  return {
    cardId,
    decision: reasons.some((reason) => reason.rule === INDEX_SUPERSEDED_BY_REMOVAL)
      ? "block"
      : "review",
    reasons,
  };
}

/**
 * A Card left on an index version a removal superseded.
 *
 * Named as a constant because two places have to agree on it: the rule that
 * produces the reason and the decision that reads it back.
 */
const INDEX_SUPERSEDED_BY_REMOVAL =
  "scope.document.indexVersionSupersededByRemoval";

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
  context: PublicationImpactContext,
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
    if (
      published.documentIndex.indexVersion === scope.documentIndex.indexVersion
    ) {
      return [];
    }
    const supersededByRemoval =
      context.documentIndexesWithRemovals?.has(
        scope.documentIndex.documentIndexId,
      ) ?? false;
    return [
      supersededByRemoval
        ? {
            rule: INDEX_SUPERSEDED_BY_REMOVAL,
            message: `document index ${scope.documentIndex.documentIndexId} moved from ${scope.documentIndex.indexVersion} to ${published.documentIndex.indexVersion}, and ${scope.documentIndex.indexVersion} still contains knowledge the source removed`,
          }
        : {
            rule: "scope.document.indexVersionChanged",
            message: `document index ${scope.documentIndex.documentIndexId} moved from ${scope.documentIndex.indexVersion} to ${published.documentIndex.indexVersion}`,
          },
    ];
  });
}

/**
 * What each changed field means for a Card, as a rule table.
 *
 * Publication v2 closed `changedFields` into five names, so the vocabulary can
 * be enumerated instead of matched loosely. `undefined` means the field cannot
 * make a Card stale on its own — the entry still has to exist, because a new
 * name appearing in the contract must break the build rather than fall through
 * a default and quietly decide nothing.
 */
const CHANGED_FIELD_RULES: Readonly<
  Record<PublishedChangedField, { rule: string; describe: string } | undefined>
> = {
  facts: {
    rule: "change.facts",
    describe:
      "the observed facts the card text was written from are no longer the same",
  },
  kind: {
    rule: "change.kind",
    describe:
      "the knowledge unit changed kind, so the card may describe a different sort of thing",
  },
  "published.scopes": {
    rule: "change.publishedScopes",
    describe:
      "the published search range changed, so the pinned scope reference needs a new revision",
  },
  "source.coordinate": {
    rule: "change.sourceCoordinate",
    describe: "the machine coordinate moved under the card",
  },
  // Provenance records how the observation was produced, not what the knowledge
  // says. Anything that actually changes what a query can retrieve shows up as
  // index drift or a scope change, both of which are judged above; treating a
  // policy-version bump as staleness would flag every Card on every rebuild.
  provenance: undefined,
};

/**
 * The declared changes, as reasons — minus the one the drift check already gave.
 *
 * `documentIndex` sits inside a published Scope, so rebuilding a document sets
 * `published.scopes` and moves `indexVersion` at the same time. Reporting both
 * would tell an operator there are two causes to look into when there is one,
 * and the drift reason is the more useful of the two: it names the index and the
 * versions it moved between, where the declared field name only says that
 * something about the Scope differs. So when drift was found, the declared
 * `published.scopes` is dropped rather than the other way round.
 *
 * Only that pair overlaps. A Scope change with no index movement — a selector
 * narrowed, a column set rewritten — produces no drift reason, and then
 * `published.scopes` is the only thing that would report it, so it is kept.
 */
function describeContentChange(
  change: Extract<PublishedChange, { kind: "added" | "updated" }>,
  driftAlreadyReported: boolean,
): CardImpactReason[] {
  if (change.kind !== "updated") {
    return [];
  }

  return change.changedFields.flatMap((field) => {
    if (field === "published.scopes" && driftAlreadyReported) {
      return [];
    }
    const entry = CHANGED_FIELD_RULES[field];
    return entry === undefined
      ? []
      : [
          {
            rule: entry.rule,
            message: `knowledge unit ${change.knowledgeUnitId}: ${entry.describe}`,
          },
        ];
  });
}
