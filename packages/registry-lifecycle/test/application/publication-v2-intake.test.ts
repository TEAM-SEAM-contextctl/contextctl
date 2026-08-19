import {
  computePublishedKnowledgeUnitV2Digest,
  ContractValidationError,
  parseIngestionPublicationV2,
  type IngestionPublicationV2 as IngestionPublication,
  type PublishedKnowledgeUnitV2 as PublishedKnowledgeUnit,
} from "@contextctl/contracts";
import { describe, expect, it } from "vitest";

import {
  claimPublication,
  type ClaimPublicationPorts,
} from "../../src/application/claim-publication.js";
import { DeterministicCardMeaningGenerator } from "../../src/infrastructure/deterministic-card-meaning-generator.js";
import {
  createHttpPublicationFixture,
  createIngestionPublicationFixture,
  createSqlPublicationFixture,
} from "../fixtures/ingestion-publication.fixture.js";

/**
 * What Registry gets from consuming Publication v2 rather than v1.
 *
 * These are boundary assertions, not domain ones: each says something about what
 * the contract now refuses or now carries, at the one place Registry reads it.
 * They are kept together because they share a subject — the version of the
 * contract — and separating them by layer would scatter the answer to "what did
 * moving to v2 actually buy".
 *
 * The refusal cases parse rather than construct: a value the type system already
 * rejects cannot be written in a test, so the only way to show the contract
 * refuses it is to hand it in as unknown data, which is also how it would really
 * arrive.
 */

/** The fixture unit, minus its digest, ready to be modified and re-sealed. */
function unitContent(
  publication: IngestionPublication,
): Omit<PublishedKnowledgeUnit, "contentDigest"> {
  const [unit] = publication.knowledgeUnits;
  if (unit === undefined) {
    throw new Error("fixture must publish one knowledge unit");
  }
  const { contentDigest: _sealed, ...content } = unit;
  return content;
}

function seal(
  content: Omit<PublishedKnowledgeUnit, "contentDigest">,
): PublishedKnowledgeUnit {
  return {
    ...content,
    contentDigest: computePublishedKnowledgeUnitV2Digest(content),
  };
}

/** A publication carrying exactly the given unit, as unvalidated input. */
function publicationWith(unit: unknown): unknown {
  const template = createIngestionPublicationFixture();
  const digest =
    typeof unit === "object" && unit !== null && "contentDigest" in unit
      ? (unit as { contentDigest: unknown }).contentDigest
      : undefined;
  return {
    ...template,
    knowledgeUnits: [unit],
    changes: [
      {
        kind: "added",
        knowledgeUnitId: "unit_payment_failures",
        currentContentDigest: digest,
      },
    ],
  };
}

/**
 * Seals a unit the type system rejects, so a refusal test can be specific.
 *
 * Every refusal below would also be produced by a digest that does not match, and
 * a test that accepted any rejection would pass for that reason instead of the
 * one it names. So the digest is always computed over the offending content, and
 * the assertion checks which field the contract objected to.
 */
function sealInvalid(content: unknown): unknown {
  const shaped = content as Omit<PublishedKnowledgeUnit, "contentDigest">;
  return {
    ...shaped,
    contentDigest: computePublishedKnowledgeUnitV2Digest(shaped),
  };
}

/** Every objection the contract raised, as `path: message`. */
function refusals(input: unknown): string[] {
  try {
    parseIngestionPublicationV2(input);
  } catch (error) {
    if (error instanceof ContractValidationError) {
      return error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    }
    throw error;
  }
  throw new Error("expected the contract to refuse this publication");
}

/** Asserts the contract refused `input` for the stated reason, not another one. */
function expectRefusedBecause(input: unknown, reason: string): void {
  expect(refusals(input).join("\n")).toContain(reason);
}

function createPorts(publication: IngestionPublication): ClaimPublicationPorts {
  let nextId = 0;
  const processed = new Set<string>();
  return {
    publications: {
      findById: async (id) =>
        id === publication.publicationId ? publication : undefined,
    },
    checkpoints: {
      hasProcessed: async (id) => processed.has(id),
      findCursor: async () => undefined,
      markProcessed: async (cursor) => {
        processed.add(cursor.publicationId);
      },
      listCursors: async () => [],
    },
    meanings: new DeterministicCardMeaningGenerator(),
    clock: { now: () => "2026-08-19T00:00:00.000Z" },
    ids: {
      nextId: () => {
        nextId += 1;
        return `cv_${nextId}`;
      },
    },
  };
}

describe("what Publication v2 refuses before Registry sees it", () => {
  it("refuses a fact whose name is outside the closed vocabulary", () => {
    // `summary` is what the v1 fixtures used. It is not one of the 21 names, and
    // the whole grounding argument rests on that: a generated identifier can be
    // checked against a fact only if fact names are a vocabulary rather than
    // free text.
    const content = unitContent(createIngestionPublicationFixture());
    const invented = sealInvalid({
      ...content,
      facts: [{ name: "summary", value: "Failed payments are retried." }],
    });

    expectRefusedBecause(publicationWith(invented), "knowledgeUnits.0.facts.0.name");
  });

  it("refuses a fact name that belongs to another kind of unit", () => {
    // The vocabulary is partitioned by `kind`, so a document unit cannot claim a
    // SQL fact. Without this a Card over a section could be grounded against a
    // table fact that has nothing to do with it.
    const content = unitContent(createIngestionPublicationFixture());
    const crossed = sealInvalid({
      ...content,
      facts: [{ name: "sql.table", value: "payments" }],
    });

    // Refused for the pairing, not merely for an unknown name: `sql.table` is a
    // real name in the vocabulary, and the message says which kind rejected it.
    expectRefusedBecause(
      publicationWith(crossed),
      "fact sql.table is not allowed for section",
    );
  });

  it("refuses a unit whose content digest does not match its content", () => {
    // Registry treats the digest as identity for change detection. A unit that
    // could carry any digest would let two different contents claim to be the
    // same knowledge, and `updated` changes would compare meaningless values.
    const content = unitContent(createIngestionPublicationFixture());
    const mismatched = {
      ...content,
      contentDigest: `sha256:${"e".repeat(64)}`,
    };

    expectRefusedBecause(
      publicationWith(mismatched),
      "knowledgeUnits.0.contentDigest",
    );
  });

  it("refuses unsorted or duplicated array fields", () => {
    // Registry does not sort these itself, and SEAM-66 hashes the catalog in
    // stored order. That only produces a stable digest because the producer
    // guarantees the order, so the guarantee is asserted rather than assumed.
    const content = unitContent(createIngestionPublicationFixture());
    const unsorted = sealInvalid({
      ...content,
      publishedScopes: [
        {
          ...content.publishedScopes[0],
          selector: {
            kind: "semantic_units",
            semanticUnitIds: ["unit_zzz", "unit_aaa"],
          },
        },
      ],
    });
    const duplicated = sealInvalid({
      ...content,
      publishedScopes: [
        {
          ...content.publishedScopes[0],
          selector: {
            kind: "semantic_units",
            semanticUnitIds: ["unit_payment_failures", "unit_payment_failures"],
          },
        },
      ],
    });

    for (const refused of [unsorted, duplicated]) {
      expectRefusedBecause(
        publicationWith(refused),
        "semantic unit IDs must be unique and lexically sorted",
      );
    }
  });
});

describe("what Registry can consume now that it could not before", () => {
  it("consumes a segment unit without disguising it as a section", async () => {
    // v1 had no name for `segment`, so the daemon bridge mapped it onto
    // `section` to get a legal record through. Nothing does that any more, and
    // this is the observable form of "preserved": Registry accepts the kind the
    // producer published. Registry stores no `kind` of its own — a Card Version
    // carries lineage, not the unit's kind — so there is no field to compare.
    const content = unitContent(createIngestionPublicationFixture());
    const segment = seal({ ...content, kind: "segment" });
    const publication = parseIngestionPublicationV2(
      publicationWith(segment),
    ) as IngestionPublication;

    expect(publication.knowledgeUnits[0]?.kind).toBe("segment");

    const result = await claimPublication(
      createPorts(publication),
      publication.publicationId,
    );

    if (result.status !== "claimed") {
      throw new Error(`expected a claim, got ${result.status}`);
    }
    expect(result.cardVersions).toHaveLength(1);
    expect(result.cardVersions[0]?.version.validationState).toBe("validated");
  });

  it("carries the SQL schema into the translated Scope", async () => {
    const publication = createSqlPublicationFixture();
    const result = await claimPublication(
      createPorts(publication),
      publication.publicationId,
    );

    if (result.status !== "claimed") {
      throw new Error(`expected a claim, got ${result.status}`);
    }
    const [scope] = result.cardVersions[0]?.version.scopes ?? [];
    if (scope?.kind !== "sql_source") {
      throw new Error("expected one sql Scope");
    }
    expect(scope.schema).toBe("public");
  });

  it("carries the HTTP operation id and parameters into the translated Scope", async () => {
    const publication = createHttpPublicationFixture();
    const result = await claimPublication(
      createPorts(publication),
      publication.publicationId,
    );

    if (result.status !== "claimed") {
      throw new Error(`expected a claim, got ${result.status}`);
    }
    const [scope] = result.cardVersions[0]?.version.scopes ?? [];
    if (scope?.kind !== "http_source") {
      throw new Error("expected one http Scope");
    }
    expect(scope.operationId).toBe("getPayment");
    expect(scope.parameters).toEqual([
      { location: "path", name: "id", required: true },
    ]);
  });
});
