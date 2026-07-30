import type { IngestionPublication, PublicationId } from "@contextctl/contracts";
import { describe, expect, it } from "vitest";

import {
  claimPublication,
  type ClaimPublicationPorts,
} from "../../src/application/claim-publication.js";
import { PublicationNotFoundError } from "../../src/application/errors.js";
import { createIngestionPublicationFixture } from "../fixtures/ingestion-publication.fixture.js";

function createFakePorts(
  publications: readonly IngestionPublication[],
): ClaimPublicationPorts & { readonly processedCalls: PublicationId[] } {
  const byId = new Map(publications.map((p) => [p.publicationId, p]));
  const processed = new Set<PublicationId>();
  const processedCalls: PublicationId[] = [];
  let nextId = 0;

  return {
    processedCalls,
    publications: {
      findById: async (publicationId) => byId.get(publicationId),
    },
    checkpoints: {
      hasProcessed: async (publicationId) => processed.has(publicationId),
      markProcessed: async (publicationId) => {
        processed.add(publicationId);
        processedCalls.push(publicationId);
      },
    },
    clock: { now: () => "2026-07-30T00:00:00.000Z" },
    ids: {
      nextId: () => {
        nextId += 1;
        return `cv_${nextId}`;
      },
    },
  };
}

describe("claimPublication", () => {
  it("claims a new publication and builds a draft card version per knowledge unit", async () => {
    const publication = createIngestionPublicationFixture();
    const ports = createFakePorts([publication]);

    const result = await claimPublication(ports, publication.publicationId);

    expect(result).toEqual({
      status: "claimed",
      publicationId: publication.publicationId,
      draftVersions: [
        {
          id: "cv_1",
          cardId: "unit_payment_failures",
          lineage: {
            publicationId: "pub_initial",
            observationId: "obs_initial",
            knowledgeUnitId: "unit_payment_failures",
            scopeRef: {
              scopeId: "scope_payment_failures",
              scopeVersion: "scpv_aaaa",
            },
          },
          validationState: "draft",
          createdAt: "2026-07-30T00:00:00.000Z",
        },
      ],
    });
    expect(ports.processedCalls).toEqual([publication.publicationId]);
  });

  it("is idempotent: redelivering the same publication id is a no-op", async () => {
    const publication = createIngestionPublicationFixture();
    const ports = createFakePorts([publication]);

    const first = await claimPublication(ports, publication.publicationId);
    const second = await claimPublication(ports, publication.publicationId);

    expect(first.status).toBe("claimed");
    expect(second).toEqual({
      status: "already_claimed",
      publicationId: publication.publicationId,
    });
    expect(ports.processedCalls).toEqual([publication.publicationId]);
  });

  it("rejects a publication id that cannot be resolved", async () => {
    const ports = createFakePorts([]);

    await expect(claimPublication(ports, "pub_missing")).rejects.toThrow(
      PublicationNotFoundError,
    );
    expect(ports.processedCalls).toEqual([]);
  });
});
