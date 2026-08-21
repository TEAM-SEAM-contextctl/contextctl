import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openRegistryDatabase } from "../../src/infrastructure/sqlite/registry-database.js";
import { SqliteCardStore } from "../../src/infrastructure/sqlite/sqlite-card-store.js";
import { SqliteConsumerCheckpointStore } from "../../src/infrastructure/sqlite/sqlite-consumer-checkpoint-store.js";
import { SqliteIntakeStore } from "../../src/infrastructure/sqlite/sqlite-intake-store.js";

/**
 * A killed process, and what the database says afterwards.
 *
 * SEAM-106 §6.5 asks for this specifically, and it is not the same test as
 * injecting an error: a thrown error unwinds through `ROLLBACK`, while `SIGKILL`
 * gives the process no chance to run anything. What holds the line there is
 * SQLite's own journal, so the only way to know it holds is to actually kill
 * something.
 *
 * The child kills itself at a point this file chooses — after the writes, before
 * the commit — so there is no race to lose. It runs the real adapter against a
 * real file; an in-memory database would die with the process and prove nothing.
 */

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const SOURCE_ID = "src_01890f5c-7b1a-7684-8f82-b5950cf2b0dd";
const PUBLICATION_ID = "pub_01890f5c-7b1a-7684-8f82-b5950cf2b0dd";
const CARD_ID = "unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd";

/**
 * The script the child runs.
 *
 * It reaches the built package rather than the sources, because a child process
 * has no TypeScript loader. `npm test` runs after `npm run build` in CI, and the
 * assertion below fails loudly rather than skipping if that order was not kept.
 */
function childScript(databaseFile: string, distEntry: string): string {
  return `
import { openRegistryDatabase, SqliteIntakeStore } from ${JSON.stringify(distEntry)};

const database = openRegistryDatabase(${JSON.stringify(databaseFile)});
const store = new SqliteIntakeStore(database, () => "2026-08-21T00:00:00.000Z");

function versionFor(cardId, versionId) {
  return {
    id: versionId,
    cardId,
    lineage: {
      publicationId: ${JSON.stringify(PUBLICATION_ID)},
      observationId: "obs_01890f5c-7b1a-7684-8f82-b5950cf2b0dd",
      knowledgeUnitId: cardId,
    },
    scopes: [],
    validationState: "validated",
    createdAt: "2026-08-21T00:00:00.000Z",
  };
}

function cardFor(cardId, versionId, aliases) {
  return {
    card: {
      id: cardId,
      meaning: {
        description: "결제 실패 재시도 정책",
        representativeQuestions: ["결제가 실패하면 언제 재시도되나요?"],
        aliases,
        keywords: [],
      },
      policy: { sensitive: false, allowedUsage: ["retrieval"] },
      versions: {
        cardId,
        versions: [versionFor(cardId, versionId)],
      },
    },
    events: [],
  };
}

// The kill is placed where the second Card's aliases are serialised: inside the
// transaction, after the first Card's rows are already written, and before the
// cursor and the COMMIT. That is the window the old two-call order could not
// survive, and putting it in the clock instead would fire before any write.
const killingAliases = {
  toJSON() {
    process.kill(process.pid, "SIGKILL");
    return [];
  },
};

await store.commit({
  cards: [
    cardFor(${JSON.stringify(CARD_ID)}, "ver_one", []),
    cardFor("unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd2", "ver_two", killingAliases),
  ],
  cursor: { sourceId: ${JSON.stringify(SOURCE_ID)}, publicationId: ${JSON.stringify(PUBLICATION_ID)} },
});

console.log("SURVIVED");
`;
}

describe("intake after a killed process", () => {
  it("leaves no Card and no cursor behind", () => {
    const directory = mkdtempSync(join(tmpdir(), "registry-crash-"));
    directories.push(directory);
    const databaseFile = join(directory, "registry.db");
    const script = join(directory, "kill-mid-commit.mjs");
    const distEntry = new URL("../../dist/index.js", import.meta.url).href;

    writeFileSync(script, childScript(databaseFile, distEntry), "utf8");

    let survived = "";
    let killed = false;
    try {
      survived = execFileSync(process.execPath, [script], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      killed = (error as { signal?: string }).signal === "SIGKILL";
      if (!killed) {
        throw new Error(
          `child failed for another reason: ${String((error as { stderr?: string }).stderr)}`,
        );
      }
    }

    expect(survived).not.toContain("SURVIVED");
    expect(killed, "the child was expected to die by SIGKILL").toBe(true);

    // Reopened from disk: this is the state a restarted daemon would find.
    const database = openRegistryDatabase(databaseFile);
    try {
      const cards = new SqliteCardStore(database);
      const checkpoints = new SqliteConsumerCheckpointStore(
        database,
        () => "2026-08-21T00:00:00.000Z",
      );

      return Promise.all([
        cards.findCard(CARD_ID),
        checkpoints.hasProcessed(PUBLICATION_ID),
        checkpoints.findCursor(SOURCE_ID),
      ]).then(([card, processed, cursor]) => {
        // The Card row was written before the kill. Without the transaction it
        // would still be here with the Publication unconsumed — the partial
        // draft SEAM-106 §6.5 names.
        expect(card).toBeUndefined();
        expect(processed).toBe(false);
        expect(cursor).toBeUndefined();
      });
    } finally {
      database.close();
    }
  });

  it("intakes cleanly on the retry that follows", async () => {
    // The other half of the guarantee: nothing was left to collide with, so the
    // same Publication can be consumed again.
    const directory = mkdtempSync(join(tmpdir(), "registry-retry-"));
    directories.push(directory);
    const databaseFile = join(directory, "registry.db");

    const database = openRegistryDatabase(databaseFile);
    try {
      const intake = new SqliteIntakeStore(
        database,
        () => "2026-08-21T00:00:00.000Z",
      );
      const cards = new SqliteCardStore(database);
      const checkpoints = new SqliteConsumerCheckpointStore(
        database,
        () => "2026-08-21T00:00:00.000Z",
      );

      await intake.commit({
        cards: [
          {
            card: {
              id: CARD_ID,
              meaning: {
                description: "결제 실패 재시도 정책",
                representativeQuestions: ["결제가 실패하면?"],
                aliases: [],
                keywords: [],
              },
              policy: { sensitive: false, allowedUsage: ["retrieval"] },
              versions: {
                cardId: CARD_ID,
                currentVersionId: undefined,
                versions: [
                  {
                    id: "ver_one",
                    cardId: CARD_ID,
                    lineage: {
                      publicationId: PUBLICATION_ID,
                      observationId: "obs_01890f5c-7b1a-7684-8f82-b5950cf2b0dd",
                      knowledgeUnitId: CARD_ID,
                    },
                    scopes: [],
                    validationState: "validated",
                    createdAt: "2026-08-21T00:00:00.000Z",
                  },
                ],
              },
            },
            events: [],
          },
        ],
        cursor: { sourceId: SOURCE_ID, publicationId: PUBLICATION_ID },
      });

      expect(await cards.findCard(CARD_ID)).toBeDefined();
      expect(await checkpoints.hasProcessed(PUBLICATION_ID)).toBe(true);
    } finally {
      database.close();
    }
  });
});
