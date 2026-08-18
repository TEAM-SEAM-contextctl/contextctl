import type { IngestionPublicationV2 as IngestionPublication } from "@contextctl/contracts";

import { analyzeCardImpact, type CardImpact } from "../domain/card-impact.js";
import type { CardVersion } from "../domain/card-version.js";
import type { LifecycleEvent } from "../domain/lifecycle-event.js";
import type { Clock } from "../ports/clock.js";
import type { IdGenerator } from "../ports/id-generator.js";

export interface AssessPublicationImpactPorts {
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export interface PublicationImpactAssessment {
  readonly impacts: readonly CardImpact[];
  readonly events: readonly LifecycleEvent[];
}

/**
 * Assesses how one Publication's changes affect the Cards already serving.
 *
 * Current versions are passed in rather than loaded through a port: this slice
 * owns the decision rules, and wiring a Card store is a later concern. Cards
 * judged `none` produce no event, so the audit trail records decisions rather
 * than every Card the publication was compared against.
 */
export function assessPublicationImpact(
  ports: AssessPublicationImpactPorts,
  publication: IngestionPublication,
  currentVersions: readonly CardVersion[],
): PublicationImpactAssessment {
  const unitsById = new Map(
    publication.knowledgeUnits.map((unit) => [unit.id, unit]),
  );
  const occurredAt = ports.clock.now();
  const impacts: CardImpact[] = [];
  const events: LifecycleEvent[] = [];

  for (const version of currentVersions) {
    for (const change of publication.changes) {
      const impact = analyzeCardImpact(
        version,
        change,
        unitsById.get(change.knowledgeUnitId),
      );
      if (impact.decision === "none") {
        continue;
      }

      impacts.push(impact);
      events.push({
        id: ports.ids.nextId(),
        kind: "card_impact_assessed",
        cardId: impact.cardId,
        occurredAt,
        publicationId: publication.publicationId,
        decision: impact.decision,
        reasons: impact.reasons,
      });
    }
  }

  return { impacts, events };
}
