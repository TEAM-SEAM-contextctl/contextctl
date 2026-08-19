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
  const cursors = new Map<string, { sourceId: string; publicationId: string }>();
  const processedCalls: PublicationId[] = [];
  let nextId = 0;

  return {
    processedCalls,
    publications: {
      findById: async (publicationId) => byId.get(publicationId),
    },
    checkpoints: {
      hasProcessed: async (publicationId) => processed.has(publicationId),
      findCursor: async (sourceId) => cursors.get(sourceId),
      markProcessed: async (cursor) => {
        processed.add(cursor.publicationId);
        processedCalls.push(cursor.publicationId);
        cursors.set(cursor.sourceId, cursor);
      },
      listCursors: async () => [...cursors.values()],
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

describe("claimPublication chain order", () => {
  /** The same Source's chain: second follows first. */
  function chain() {
    const first = createIngestionPublicationFixture("pub_first");
    const second: IngestionPublication = {
      ...createIngestionPublicationFixture("pub_second"),
      previousPublicationId: "pub_first",
    };
    return { first, second };
  }

  it("consumes the first Publication of a Source", async () => {
    const { first } = chain();
    const ports = createFakePorts([first]);

    const result = await claimPublication(ports, "pub_first");

    expect(result.status).toBe("claimed");
  });

  it("consumes a successor once its predecessor was consumed", async () => {
    const { first, second } = chain();
    const ports = createFakePorts([first, second]);

    await claimPublication(ports, "pub_first");
    const result = await claimPublication(ports, "pub_second");

    expect(result.status).toBe("claimed");
    expect(ports.processedCalls).toEqual(["pub_first", "pub_second"]);
  });

  it("defers a successor that arrives before its predecessor", async () => {
    // The notification order is the transport's, not the chain's. Consuming
    // this now would build a Card on top of a change nobody read.
    const { first, second } = chain();
    const ports = createFakePorts([first, second]);

    const result = await claimPublication(ports, "pub_second");

    expect(result).toEqual({
      status: "deferred",
      publicationId: "pub_second",
      awaiting: "pub_first",
    });
    // Nothing claimed, so the checkpoint did not move and the notification is
    // still work for the reconciler.
    expect(ports.processedCalls).toEqual([]);
  });

  it("consumes the deferred Publication once the gap closes", async () => {
    const { first, second } = chain();
    const ports = createFakePorts([first, second]);

    await claimPublication(ports, "pub_second");
    await claimPublication(ports, "pub_first");
    const retried = await claimPublication(ports, "pub_second");

    expect(retried.status).toBe("claimed");
    expect(ports.processedCalls).toEqual(["pub_first", "pub_second"]);
  });

  it("ignores producedAt when ordering the chain", async () => {
    // A retry can be produced after the Publication that follows it, so a
    // timestamp would order a chain that was never published.
    const { first } = chain();
    const laterButUnchained: IngestionPublication = {
      ...createIngestionPublicationFixture("pub_unchained"),
      producedAt: "2099-01-01T00:00:00.000Z",
      previousPublicationId: "pub_missing",
    };
    const ports = createFakePorts([first, laterButUnchained]);

    await claimPublication(ports, "pub_first");
    const result = await claimPublication(ports, "pub_unchained");

    expect(result.status).toBe("deferred");
  });

  it("refuses a second chain start and commits nothing", async () => {
    // Two Publications with no predecessor claim the same place. Choosing one
    // would silently abandon what the other published.
    const { first } = chain();
    const rival = createIngestionPublicationFixture("pub_rival");
    const ports = createFakePorts([first, rival]);

    await claimPublication(ports, "pub_first");
    const result = await claimPublication(ports, "pub_rival");

    expect(result.status).toBe("forked");
    expect(ports.processedCalls).toEqual(["pub_first"]);
  });

  it("treats redelivery of a consumed Publication as already claimed", async () => {
    const { first } = chain();
    const ports = createFakePorts([first]);

    await claimPublication(ports, "pub_first");
    const again = await claimPublication(ports, "pub_first");

    expect(again.status).toBe("already_claimed");
    expect(ports.processedCalls).toEqual(["pub_first"]);
  });

  it("keeps each Source's chain independent", async () => {
    // No ordering exists between two Sources, so one Source's cursor must not
    // decide whether another Source's first Publication may be consumed.
    const { first } = chain();
    const otherSource: IngestionPublication = {
      ...createSqlPublicationFixture(),
    };
    const ports = createFakePorts([first, otherSource]);

    await claimPublication(ports, "pub_first");
    const result = await claimPublication(ports, otherSource.publicationId);

    expect(result.status).toBe("claimed");
  });
});
