import type {
  IngestionPublicationV2 as IngestionPublication,
  PublicationId,
  PublishedKnowledgeUnitV2 as PublishedKnowledgeUnit,
} from "@contextctl/contracts";

import type { CardVersion } from "../domain/card-version.js";
import {
  locateInChain,
  type ChainCursor,
  type ChainPosition,
} from "../domain/publication-chain.js";
import {
  groundCardVersion,
  type GroundingFinding,
} from "../domain/fact-grounding.js";
import { translatePublishedScope } from "../domain/retrieval-scope.js";
import { PublicationNotFoundError } from "./errors.js";
import type { CardMeaningGenerator } from "../ports/card-meaning-generator.js";
import type { Clock } from "../ports/clock.js";
import type { ConsumerCheckpointStore } from "../ports/consumer-checkpoint-store.js";
import type { IdGenerator } from "../ports/id-generator.js";
import type { PublicationRepository } from "../ports/publication-repository.js";

export interface ClaimPublicationPorts {
  readonly publications: PublicationRepository;
  readonly checkpoints: ConsumerCheckpointStore;
  readonly meanings: CardMeaningGenerator;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** One Card Version produced by a claim, with why grounding rejected it. */
export interface ClaimedCardVersion {
  readonly version: CardVersion;
  readonly findings: readonly GroundingFinding[];
}

export type ClaimPublicationResult =
  | { readonly status: "already_claimed"; readonly publicationId: PublicationId }
  | {
      readonly status: "claimed";
      readonly publicationId: PublicationId;
      /**
       * Where the Source's cursor belongs once these versions are stored.
       *
       * Returned rather than written here. The design commits Card changes and
       * the cursor advance together; this function does not store Cards, so
       * writing the cursor now would move it before the Cards exist. A crash in
       * between would then leave the Publication consumed with no Card and no
       * way back: redelivery answers `already_claimed`, and the Cards are gone
       * for good. Handing the cursor to the caller that does the storing keeps
       * the failure on the recoverable side — a retry re-produces the versions.
       */
      readonly cursor: ChainCursor;
      readonly cardVersions: readonly ClaimedCardVersion[];
    }
  /**
   * Its predecessor has not been consumed yet. Nothing is written and the
   * checkpoint does not move, so the notification stays work for the reconciler
   * rather than becoming a Card built over a change nobody read.
   */
  | {
      readonly status: "deferred";
      readonly publicationId: PublicationId;
      readonly awaiting: PublicationId;
    }
  /**
   * The Source's chain is not linear. No Card transition is committed and the
   * lane is degraded until an operator resolves it — picking one of two
   * successors would silently drop whatever the other one published.
   */
  | {
      readonly status: "forked";
      readonly publicationId: PublicationId;
      readonly reason: string;
    };

/**
 * Consumes one Publication exactly once, and only in chain order.
 *
 * Two guards, in this order. A publicationId already in the claim record is a
 * no-op, so redelivery of the same notification never produces a second side
 * effect. Then the Publication has to follow this Source's cursor: notifications
 * arrive in whatever order the transport managed, and consuming a later one
 * first would build a Card on top of a change that was never read.
 *
 * Consumption is not recorded here. This function produces Card Versions and
 * does not store them, so the caller that stores them is the one that may then
 * mark the Publication consumed, passing back the `cursor` this result carries.
 * Marking first would risk a Publication counted as consumed with no Card to
 * show for it.
 *
 * Neither `producedAt` nor arrival order takes part in that decision — only
 * `previousPublicationId`. A retry can be produced after the Publication that
 * follows it, so a timestamp would order a chain that was never published.
 */
export async function claimPublication(
  ports: ClaimPublicationPorts,
  publicationId: PublicationId,
): Promise<ClaimPublicationResult> {
  if (await ports.checkpoints.hasProcessed(publicationId)) {
    return { status: "already_claimed", publicationId };
  }

  const publication = await ports.publications.findById(publicationId);
  if (publication === undefined) {
    throw new PublicationNotFoundError(publicationId);
  }

  const position = locateInChain(
    await ports.checkpoints.findCursor(publication.sourceId),
    publication,
  );
  const refusal = refuse(publicationId, position);
  if (refusal !== undefined) {
    return refusal;
  }

  const createdAt = ports.clock.now();
  const cardVersions: ClaimedCardVersion[] = [];
  for (const unit of publication.knowledgeUnits) {
    cardVersions.push(
      await toCardVersion(ports, publication, unit, createdAt),
    );
  }

  return {
    status: "claimed",
    publicationId,
    cursor: { sourceId: publication.sourceId, publicationId },
    cardVersions,
  };
}

/** The result for a position that must not be consumed, or nothing. */
function refuse(
  publicationId: PublicationId,
  position: ChainPosition,
): ClaimPublicationResult | undefined {
  switch (position.kind) {
    case "first":
    case "next":
      return undefined;
    case "gap":
      return {
        status: "deferred",
        publicationId,
        awaiting: position.expectedAfter,
      };
    case "fork":
      return { status: "forked", publicationId, reason: position.reason };
    default: {
      const unreachable: never = position;
      throw new Error(`unknown chain position: ${JSON.stringify(unreachable)}`);
    }
  }
}

async function toCardVersion(
  ports: ClaimPublicationPorts,
  publication: IngestionPublication,
  unit: PublishedKnowledgeUnit,
  createdAt: string,
): Promise<ClaimedCardVersion> {
  // Every published scope is translated: dropping one would silently narrow the
  // search range a Card claims to cover.
  const scopes = unit.publishedScopes.map(translatePublishedScope);
  const meaning = await ports.meanings.generate({
    coordinate: unit.sourceCoordinate,
    facts: unit.facts,
  });
  const grounding = groundCardVersion(unit.sourceCoordinate, scopes, meaning);

  return {
    version: {
      id: ports.ids.nextId(),
      cardId: unit.id,
      lineage: {
        publicationId: publication.publicationId,
        observationId: publication.observationId,
        knowledgeUnitId: unit.id,
      },
      scopes,
      validationState:
        grounding.outcome === "validated" ? "validated" : "rejected",
      createdAt,
    },
    findings: grounding.outcome === "validated" ? [] : grounding.findings,
  };
}
