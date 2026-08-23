import type { PublicationReady } from "@contextctl/contracts";
import type { PublicationReadyNotifier } from "@contextctl/ingestion-indexing";

import type { RegistryIntake, RegistryIntakeResult } from "../registry-intake.js";
import type { AdmissionLane } from "../runtime/admission.js";

export interface RegistryPublicationIntake {
  claim(publicationId: string): Promise<RegistryIntakeResult>;
}

/** A safe refusal that the Ingestion outbox may persist and retry. */
export class RegistryPublicationNotificationFault extends Error {
  constructor(readonly code: string) {
    super("Registry did not accept the ready Publication");
    this.name = "RegistryPublicationNotificationFault";
  }
}

/**
 * Projects Ingestion's ready notification into Registry's intake use case.
 *
 * This is orchestration, not a domain contract: the notification carries only
 * the immutable Publication ID, Registry reads the Publication through its own
 * repository, and the daemon admits the claim through Registry's bounded lane.
 * A deferred or forked chain is not delivery success. Throwing a stable code
 * lets Ingestion retain and reschedule the durable outbox entry without copying
 * Registry's diagnostic detail into another domain.
 */
export class RegistryPublicationReadyNotifier
  implements PublicationReadyNotifier
{
  readonly #intake: RegistryPublicationIntake;
  readonly #lane: AdmissionLane;

  constructor(options: {
    readonly intake: Pick<RegistryIntake, "claim">;
    readonly lane: AdmissionLane;
  }) {
    this.#intake = options.intake;
    this.#lane = options.lane;
  }

  async notify(notification: PublicationReady): Promise<void> {
    const result = await this.#lane.run(
      async () => await this.#intake.claim(notification.publicationId),
    );
    if (result.status === "deferred" || result.status === "forked") {
      throw new RegistryPublicationNotificationFault(result.diagnostic.code);
    }
  }
}
