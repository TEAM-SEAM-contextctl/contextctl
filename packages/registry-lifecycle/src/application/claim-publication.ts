import type {
  IngestionPublication,
  PublicationId,
  PublishedKnowledgeUnit,
} from "@contextctl/contracts";

import type { CardVersion } from "../domain/card-version.js";
import { PublicationNotFoundError } from "./errors.js";
import type { Clock } from "../ports/clock.js";
import type { ConsumerCheckpointStore } from "../ports/consumer-checkpoint-store.js";
import type { IdGenerator } from "../ports/id-generator.js";
import type { PublicationRepository } from "../ports/publication-repository.js";

export interface ClaimPublicationPorts {
  readonly publications: PublicationRepository;
  readonly checkpoints: ConsumerCheckpointStore;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export type ClaimPublicationResult =
  | { readonly status: "already_claimed"; readonly publicationId: PublicationId }
  | {
      readonly status: "claimed";
      readonly publicationId: PublicationId;
      readonly draftVersions: readonly CardVersion[];
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
  const draftVersions = publication.knowledgeUnits.map((unit) =>
    toDraftCardVersion(publication, unit, ports.ids.nextId(), createdAt),
  );

  await ports.checkpoints.markProcessed(publicationId);

  return { status: "claimed", publicationId, draftVersions };
}

function toDraftCardVersion(
  publication: IngestionPublication,
  unit: PublishedKnowledgeUnit,
  versionId: string,
  createdAt: string,
): CardVersion {
  const [scope] = unit.publishedScopes;
  if (scope === undefined) {
    throw new Error(
      `knowledge unit ${unit.id} was published without a retrieval scope`,
    );
  }
  return {
    id: versionId,
    cardId: unit.id,
    lineage: {
      publicationId: publication.publicationId,
      observationId: publication.observationId,
      knowledgeUnitId: unit.id,
      scopeRef: { scopeId: scope.scopeId, scopeVersion: scope.scopeVersion },
    },
    validationState: "draft",
    createdAt,
  };
}
