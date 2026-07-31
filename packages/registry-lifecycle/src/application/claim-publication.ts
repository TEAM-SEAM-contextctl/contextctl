import type {
  IngestionPublication,
  PublicationId,
  PublishedKnowledgeUnit,
} from "@contextctl/contracts";

import type { CardVersion } from "../domain/card-version.js";
import {
  groundCardVersion,
  type GroundingFinding,
} from "../domain/evidence-grounding.js";
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
      readonly cardVersions: readonly ClaimedCardVersion[];
    };

/**
 * Consumes one Publication exactly once. A publicationId already recorded in
 * the checkpoint store is a no-op, so redelivery of the same PublicationReady
 * notification never produces a second side effect.
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

  const createdAt = ports.clock.now();
  const cardVersions: ClaimedCardVersion[] = [];
  for (const unit of publication.knowledgeUnits) {
    cardVersions.push(
      await toCardVersion(ports, publication, unit, createdAt),
    );
  }

  await ports.checkpoints.markProcessed(publicationId);

  return { status: "claimed", publicationId, cardVersions };
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
    evidence: unit.evidence,
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
