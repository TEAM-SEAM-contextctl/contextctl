import {
  canonicalContractByteLength,
  canonicalContractJson,
} from "@contextctl/contracts";
import { createHash } from "node:crypto";

import {
  getCurrentCardVersion,
  type CardId,
  type CardVersionId,
} from "./card-version.js";
import type {
  CardMeaning,
  CardPolicy,
  ContextCard,
} from "./context-card.js";
import type { GroundingFinding } from "./fact-grounding.js";
import type { RetrievalScope } from "./retrieval-scope.js";

/**
 * One approved Card as consumers see it.
 *
 * This is the catalog read model Registry publishes: meaning, search range, and
 * policy, with nothing of how Registry got there. Version history, validation
 * states, and lineage stay behind the boundary, so a consumer cannot come to
 * depend on Registry's storage or lifecycle internals.
 *
 * Named apart from Selection's `ApprovedCard` on purpose — both appear in the
 * daemon adapter that translates between them, and one vocabulary must not
 * silently stand in for the other.
 */
export interface CardCatalogEntry {
  readonly cardId: CardId;
  /** The version that is current, and therefore the one being served. */
  readonly versionId: CardVersionId;
  readonly meaning: CardMeaning;
  readonly policy: CardPolicy;
  readonly scopes: readonly RetrievalScope[];
}

/**
 * Projects a Card into the catalog, or nothing if it is not serving.
 *
 * A Card with no current version has either never been approved or been
 * withdrawn; either way it must not appear in the catalog.
 */
export function toCardCatalogEntry(
  card: ContextCard,
): CardCatalogEntry | undefined {
  const current = getCurrentCardVersion(card.versions);
  if (current === undefined) {
    return undefined;
  }

  return {
    cardId: card.id,
    versionId: current.id,
    meaning: card.meaning,
    policy: card.policy,
    scopes: current.scopes,
  };
}

/**
 * The approved catalog as one versioned reading.
 *
 * Consumers need to say which reading they hold. Selection keeps a candidate
 * index built from Card text, and without a version on the catalog it cannot
 * tell a stale index from a current one except by rebuilding.
 */
export interface ApprovedCardCatalogSnapshot {
  readonly catalogSnapshotVersion: string;
  readonly cards: readonly CardCatalogEntry[];
}

/**
 * Digest of everything the snapshot exposes, in a canonical ordering.
 *
 * Equal catalogs must produce equal versions no matter what order the store
 * returned rows in, so entries are sorted by Card id and the payload runs
 * through the same canonical JSON the versioned contracts use. Reusing that
 * function rather than writing another one keeps a single definition of
 * "canonical" in the monorepo: two nearly-identical serialisers would disagree
 * eventually, and the disagreement would surface as a snapshot version that
 * changes for no visible reason.
 *
 * The digest covers meaning, policy, and scopes — not just ids — because a Card
 * whose description changed is a different reading even at the same version id.
 */
export function computeCatalogSnapshotVersion(
  cards: readonly CardCatalogEntry[],
): string {
  const ordered = [...cards].sort((left, right) =>
    left.cardId < right.cardId ? -1 : left.cardId > right.cardId ? 1 : 0,
  );
  return `sha256:${createHash("sha256")
    .update(canonicalContractJson(ordered))
    .digest("hex")}`;
}

/** Pairs the entries with the version that identifies this exact reading. */
export function toApprovedCardCatalogSnapshot(
  cards: readonly CardCatalogEntry[],
): ApprovedCardCatalogSnapshot {
  return {
    catalogSnapshotVersion: computeCatalogSnapshotVersion(cards),
    cards,
  };
}

/**
 * Snapshot-wide ceilings from `approved-card-read-v1`.
 *
 * Per-Card sizes are checked during grounding, where a failure stops the
 * version from ever becoming current. These two can only be judged against the
 * whole catalog, so they are checked when a promotion would produce it.
 */
const SNAPSHOT_LIMITS = {
  cards: 10_000,
  canonicalBytes: 64 * 1_024 * 1_024,
  token: 256,
} as const;

/**
 * Whether the catalog this promotion would produce may be served.
 *
 * A snapshot over the ceiling is refused whole rather than trimmed. Dropping
 * some Cards to fit would leave a catalog that answers queries as though it
 * covered everything, and the Card that fell out is invisible precisely because
 * it is missing. Refusing the promotion keeps the previous snapshot serving and
 * tells the operator to split the catalog instead.
 */
export function checkCatalogSnapshotLimits(
  cards: readonly CardCatalogEntry[],
): readonly GroundingFinding[] {
  const findings: GroundingFinding[] = [];

  if (cards.length > SNAPSHOT_LIMITS.cards) {
    findings.push({
      severity: "fatal",
      rule: "catalog.cardCount",
      message: `catalog would hold ${cards.length} cards, over the ${SNAPSHOT_LIMITS.cards} allowed by approved-card-read-v1`,
    });
  }

  const bytes = canonicalContractByteLength(cards);
  if (bytes > SNAPSHOT_LIMITS.canonicalBytes) {
    findings.push({
      severity: "fatal",
      rule: "catalog.canonicalBytes",
      message: `catalog canonical JSON would be ${bytes} bytes, over the ${SNAPSHOT_LIMITS.canonicalBytes} allowed by approved-card-read-v1`,
    });
  }

  for (const card of cards) {
    for (const token of [card.cardId, card.versionId]) {
      if (token.length > SNAPSHOT_LIMITS.token) {
        findings.push({
          severity: "fatal",
          rule: "catalog.token",
          message: `${token.slice(0, 32)}… is ${token.length} code units, over the ${SNAPSHOT_LIMITS.token} allowed by approved-card-read-v1`,
        });
      }
    }
  }

  return findings;
}
