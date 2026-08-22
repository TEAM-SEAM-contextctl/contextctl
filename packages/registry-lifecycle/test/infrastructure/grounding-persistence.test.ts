import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  appendCardVersion,
  type CardVersion,
} from "../../src/domain/card-version.js";
import {
  createContextCard,
  withCardVersions,
} from "../../src/domain/context-card.js";
import type { GroundingReport } from "../../src/domain/fact-grounding.js";
import { openRegistryDatabase } from "../../src/infrastructure/sqlite/registry-database.js";
import { SqliteCardStore } from "../../src/infrastructure/sqlite/sqlite-card-store.js";
import { createDocumentCardVersion } from "../fixtures/card-version.fixture.js";

/**
 * The grounding record survives the round trip, and its absence survives too.
 *
 * SEAM-106 §6.4 requires `factCoverage` and the change comparison to be stored
 * and queryable. The other half of the requirement is honesty about history:
 * a registry.db written before grounding-v1 holds versions nobody judged, and
 * reading them back must say "no record" rather than invent one.
 */

const meaning = {
  description: "결제 실패 재시도 정책",
  representativeQuestions: ["결제가 실패하면 언제 재시도되나요?"],
  aliases: ["payment retry"],
  keywords: ["payment", "retry"],
};

const policy = { sensitive: false, allowedUsage: ["retrieval"] };

const report: GroundingReport = {
  verdict: "needs_review",
  findings: [
    {
      rule: "meaning.modelAuthored",
      message: "expression written by model gemma4-12b-qat awaits an operator's semantic review",
      severity: "review",
    },
  ],
  factCoverage: { covered: ["section.label"], uncovered: ["document.title"] },
  origin: { generator: "model", model: "gemma4-12b-qat" },
};

function groundedVersion(): CardVersion {
  return {
    ...createDocumentCardVersion(),
    meaning,
    grounding: report,
    changeFromPrevious: {
      previousVersionId: "cv_earlier",
      changedFields: ["description", "keywords"],
      coverageLost: ["document.title"],
      coverageGained: ["section.label"],
    },
  };
}

describe("grounding persistence", () => {
  it("restores meaning, report and change comparison exactly as written", async () => {
    const store = new SqliteCardStore(openRegistryDatabase(":memory:"));
    const version = groundedVersion();
    const card = withCardVersions(
      createContextCard(version.cardId, meaning, policy),
      appendCardVersion(
        { cardId: version.cardId, versions: [], currentVersionId: undefined },
        version,
      ),
    );

    await store.saveCard(card, []);

    expect(await store.findCard(version.cardId)).toEqual(card);
  });

  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("reads a version written before grounding-v1 as having no record", async () => {
    // A database file shaped by the previous release: same tables, no grounding
    // columns. `openRegistryDatabase` must add the columns without touching the
    // row, and the row must come back with the optional fields absent — not
    // null, not fabricated.
    const directory = await mkdtemp(join(tmpdir(), "contextctl-migration-"));
    directories.push(directory);
    const location = join(directory, "registry.db");
    const database = new DatabaseSync(location);
    database.exec(`
      CREATE TABLE cards (
        card_id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        representative_questions TEXT NOT NULL,
        aliases TEXT NOT NULL,
        keywords TEXT NOT NULL,
        sensitive INTEGER NOT NULL,
        allowed_usage TEXT NOT NULL,
        current_version_id TEXT
      );
      CREATE TABLE card_versions (
        version_id TEXT PRIMARY KEY,
        card_id TEXT NOT NULL REFERENCES cards (card_id),
        publication_id TEXT NOT NULL,
        observation_id TEXT NOT NULL,
        knowledge_unit_id TEXT NOT NULL,
        scopes TEXT NOT NULL,
        validation_state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        append_order INTEGER NOT NULL
      );
    `);
    const legacy = createDocumentCardVersion();
    database
      .prepare(
        `INSERT INTO cards (card_id, description, representative_questions, aliases, keywords, sensitive, allowed_usage, current_version_id)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        legacy.cardId,
        meaning.description,
        JSON.stringify(meaning.representativeQuestions),
        JSON.stringify(meaning.aliases),
        JSON.stringify(meaning.keywords),
        JSON.stringify(policy.allowedUsage),
        legacy.id,
      );
    database
      .prepare(
        `INSERT INTO card_versions (version_id, card_id, publication_id, observation_id, knowledge_unit_id, scopes, validation_state, created_at, append_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(
        legacy.id,
        legacy.cardId,
        legacy.lineage.publicationId,
        legacy.lineage.observationId,
        legacy.lineage.knowledgeUnitId,
        JSON.stringify(legacy.scopes),
        legacy.validationState,
        legacy.createdAt,
      );

    database.close();

    // The real opener, against the old file — the migration under test.
    const store = new SqliteCardStore(openRegistryDatabase(location));
    const card = await store.findCard(legacy.cardId);
    const version = card?.versions.versions[0];

    expect(version).toEqual(legacy);
    expect(version?.grounding).toBeUndefined();
    expect(version?.changeFromPrevious).toBeUndefined();
  });
});
