import { describe, expect, it } from "vitest";

import type { PublicationReady } from "@contextctl/contracts";

import {
  RegistryPublicationNotificationFault,
  RegistryPublicationReadyNotifier,
  type RegistryPublicationIntake,
} from "../src/adapters/registry-publication-ready-notifier.js";
import { AdmissionLane } from "../src/runtime/admission.js";

const READY: PublicationReady = {
  schemaVersion: 1,
  publicationId: "pub_01890f5c-7b1a-7104-8000-000000000104",
};

function lane(): AdmissionLane {
  return new AdmissionLane("registry_consume", {
    concurrency: 1,
    queueDepth: 1,
  });
}

describe("RegistryPublicationReadyNotifier", () => {
  it.each(["claimed", "already_claimed"] as const)(
    "completes delivery after Registry reports %s",
    async (status) => {
      const seen: string[] = [];
      const intake: RegistryPublicationIntake = {
        claim: async (publicationId) => {
          seen.push(publicationId);
          return { status, publicationId, cardVersions: [] };
        },
      };
      const notifier = new RegistryPublicationReadyNotifier({
        intake,
        lane: lane(),
      });

      await notifier.notify(READY);
      expect(seen).toEqual([READY.publicationId]);
    },
  );

  it.each(["deferred", "forked"] as const)(
    "keeps %s delivery retryable under Registry's stable code",
    async (status) => {
      const intake: RegistryPublicationIntake = {
        claim: async (publicationId) =>
          status === "deferred"
            ? {
                status,
                publicationId,
                cardVersions: [],
                sourceId: "src_01890f5c-7b1a-7101-8000-000000000101",
                awaiting: "pub_01890f5c-7b1a-7104-8000-000000000103",
                diagnostic: {
                  code: "publication_chain_gap",
                  detail: "must not cross the outbox",
                },
              }
            : {
                status,
                publicationId,
                cardVersions: [],
                sourceId: "src_01890f5c-7b1a-7101-8000-000000000101",
                diagnostic: {
                  code: "publication_chain_forked",
                  detail: "must not cross the outbox",
                },
              },
      };
      const notifier = new RegistryPublicationReadyNotifier({
        intake,
        lane: lane(),
      });

      const expected =
        status === "deferred"
          ? "publication_chain_gap"
          : "publication_chain_forked";
      await expect(notifier.notify(READY)).rejects.toEqual(
        expect.objectContaining({
          name: "RegistryPublicationNotificationFault",
          code: expected,
        } satisfies Partial<RegistryPublicationNotificationFault>),
      );
    },
  );

  it("does not start Registry intake after its lane closes", async () => {
    let called = false;
    const registryLane = lane();
    registryLane.stopAccepting();
    const notifier = new RegistryPublicationReadyNotifier({
      intake: {
        claim: async (publicationId) => {
          called = true;
          return { status: "claimed", publicationId, cardVersions: [] };
        },
      },
      lane: registryLane,
    });

    await expect(notifier.notify(READY)).rejects.toMatchObject({
      name: "LaneClosedError",
    });
    expect(called).toBe(false);
  });
});
