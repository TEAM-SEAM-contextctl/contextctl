import type { IngestionPublication, PublicationId } from "@contextctl/contracts";
import { describe, expect, it } from "vitest";

import {
  claimPublication,
  type ClaimPublicationPorts,
} from "../../src/application/claim-publication.js";
import { PublicationNotFoundError } from "../../src/application/errors.js";
import type { CardMeaning } from "../../src/domain/context-card.js";
import {
  createIngestionPublicationFixture,
  createMultiScopePublicationFixture,
  createSqlPublicationFixture,
} from "../fixtures/ingestion-publication.fixture.js";

const groundedMeaning: CardMeaning = {
  description: "결제 실패 재시도 정책",
  representativeQuestions: ["결제가 실패하면 언제 재시도되나요?"],
  aliases: ["payment retry"],
  keywords: ["payment", "retry"],
};

const blankMeaning: CardMeaning = {
  description: "",
  representativeQuestions: [],
  aliases: [],
  keywords: [],
};

function createFakePorts(
  publications: readonly IngestionPublication[],
  meaning: CardMeaning = groundedMeaning,
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
    meanings: { generate: async () => meaning },
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
  it("claims a new publication and validates a grounded card version", async () => {
    const publication = createIngestionPublicationFixture();
    const ports = createFakePorts([publication]);

    const result = await claimPublication(ports, publication.publicationId);

    expect(result).toEqual({
      status: "claimed",
      publicationId: "pub_initial",
      cardVersions: [
        {
          version: {
            id: "cv_1",
            cardId: "unit_payment_failures",
            lineage: {
              publicationId: "pub_initial",
              observationId: "obs_initial",
              knowledgeUnitId: "unit_payment_failures",
            },
            scopes: [
              {
                kind: "managed_document",
                reference: {
                  scopeId: "scope_payment_failures",
                  scopeVersion: "scpv_aaaa",
                },
                documentIndex: {
                  documentIndexId: "didx_payments",
                  sourceId: "src_payments",
                  documentId: "doc_payments",
                  indexVersion: "idxv_aaaa",
                  connectorId: "vector.local",
                  accessHandle: "documents/payments/indexes/aaaa",
                },
                selection: {
                  kind: "semantic_units",
                  semanticUnitIds: ["unit_payment_failures"],
                },
              },
            ],
            validationState: "validated",
            createdAt: "2026-07-30T00:00:00.000Z",
          },
          findings: [],
        },
      ],
    });
    expect(ports.processedCalls).toEqual(["pub_initial"]);
  });

  it("keeps every published scope instead of silently dropping extras", async () => {
    const publication = createMultiScopePublicationFixture();
    const ports = createFakePorts([publication]);

    const result = await claimPublication(ports, publication.publicationId);
    if (result.status !== "claimed") {
      throw new Error("expected the publication to be claimed");
    }
    const scopes = result.cardVersions[0]?.version.scopes ?? [];

    expect(scopes.map((scope) => scope.reference.scopeVersion)).toEqual([
      "scpv_aaaa",
      "scpv_bbbb",
    ]);
    expect(result.cardVersions[0]?.version.validationState).toBe("validated");
  });

  it("translates SQL publications into a validated sql_source scope", async () => {
    const publication = createSqlPublicationFixture();
    const ports = createFakePorts([publication]);

    const result = await claimPublication(ports, publication.publicationId);
    if (result.status !== "claimed") {
      throw new Error("expected the publication to be claimed");
    }

    expect(result.cardVersions[0]?.version.scopes).toEqual([
      {
        kind: "sql_source",
        reference: {
          scopeId: "scope_payments_table",
          scopeVersion: "scpv_cccc",
        },
        connector: "postgres.main",
        table: "payments",
        columns: ["failed_reason", "status"],
      },
    ]);
    expect(result.cardVersions[0]?.version.validationState).toBe("validated");
  });

  it("rejects the card version when generated meaning fails grounding", async () => {
    const publication = createIngestionPublicationFixture();
    const ports = createFakePorts([publication], blankMeaning);

    const result = await claimPublication(ports, publication.publicationId);
    if (result.status !== "claimed") {
      throw new Error("expected the publication to be claimed");
    }
    const claimed = result.cardVersions[0];

    expect(claimed?.version.validationState).toBe("rejected");
    expect(claimed?.findings.map((finding) => finding.rule)).toEqual([
      "meaning.description",
      "meaning.representativeQuestions",
    ]);
    // A rejected version is still recorded, so the claim stays idempotent.
    expect(ports.processedCalls).toEqual(["pub_initial"]);
  });

  it("is idempotent: redelivering the same publication id is a no-op", async () => {
    const publication = createIngestionPublicationFixture();
    const ports = createFakePorts([publication]);

    const first = await claimPublication(ports, publication.publicationId);
    const second = await claimPublication(ports, publication.publicationId);

    expect(first.status).toBe("claimed");
    expect(second).toEqual({
      status: "already_claimed",
      publicationId: "pub_initial",
    });
    expect(ports.processedCalls).toEqual(["pub_initial"]);
  });

  it("rejects a publication id that cannot be resolved", async () => {
    const ports = createFakePorts([]);

    await expect(claimPublication(ports, "pub_missing")).rejects.toThrow(
      PublicationNotFoundError,
    );
    expect(ports.processedCalls).toEqual([]);
  });
});
