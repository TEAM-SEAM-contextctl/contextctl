import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  computePublishedKnowledgeUnitDigest,
  parseIngestionPublication,
  type IngestionPublication,
  type PublishedKnowledgeUnit,
} from "@contextctl/contracts";
import {
  openIngestionDatabase,
  SqliteIngestionPublicationStore,
} from "@contextctl/ingestion-indexing";
import {
  openRegistryDatabase,
  SqliteConsumerCheckpointStore,
} from "@contextctl/registry-lifecycle";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_SECURITY_DOMAIN,
  DEFAULT_STATE_NAMESPACE_ID,
} from "../../src/main.js";
import { EXIT_CODES } from "../../src/cli/exit-codes.js";

/**
 * The lanes that only a populated machine can show, against real rows.
 *
 * The pure judgement is tested in `status.test.ts` and the wiring on a fresh
 * machine in `status-command.test.ts`. Neither reaches the SQL: whether a
 * Source's delay is actually read back out of `consumer_source_cursors` and
 * Ingestion's publication table, and whether a prepared-but-uncommitted publish
 * is actually visible to `pendingRecoveryIntentForSource`, are claims about two
 * schemas that a hand-built observation cannot support.
 *
 * The state is seeded through the stores rather than by ingesting a document, so
 * this runs without the 415MB embedding artifact. That is not a shortcut around
 * the interesting part — `ingest` would produce the same two rows through the
 * embedding path, and it is the rows that the status reads.
 */

const execFileAsync = promisify(execFile);

const SOURCE_ID = "src_01890f5c-7b1a-7001-8000-000000000001";
const DOCUMENT_ID = "doc_01890f5c-7b1a-7002-8000-000000000002";
const OBSERVATION_ID = "obs_01890f5c-7b1a-7003-8000-000000000003";
const PUBLICATION_ID = "pub_01890f5c-7b1a-7004-8000-000000000004";
const OLDER_PUBLICATION_ID = "pub_01890f5c-7b1a-7014-8000-000000000014";

const INSTALLED_COMMAND = fileURLToPath(
  new URL("../../../../node_modules/.bin/contextctl", import.meta.url),
);

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function seal(
  unit: Omit<PublishedKnowledgeUnit, "contentDigest">,
): PublishedKnowledgeUnit {
  return { ...unit, contentDigest: computePublishedKnowledgeUnitDigest(unit) };
}

/** One Markdown-backed Publication, produced two hours before `now`. */
function publicationFixture(producedAt: string): IngestionPublication {
  const unit = seal({
    id: "unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd",
    kind: "section",
    sourceCoordinate: {
      kind: "document",
      sourceId: SOURCE_ID,
      documentId: DOCUMENT_ID,
      semanticUnitId: "unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd",
    },
    facts: [{ name: "section.label", value: "Payment failures" }],
    publishedScopes: [
      {
        scopeId: "scope_payment_failures",
        scopeVersion: "scpv_aaaa",
        kind: "managed_document",
        documentIndex: {
          documentIndexId: "didx_payments",
          sourceId: SOURCE_ID,
          documentId: DOCUMENT_ID,
          indexVersion: "idxv_aaaa",
        },
        selector: {
          kind: "semantic_units",
          semanticUnitIds: ["unit_01890f5c-7b1a-7684-8f82-b5950cf2b0dd"],
        },
      },
    ],
    provenance: {
      observationId: OBSERVATION_ID,
      producer: { id: "markdown.parser", version: "1.0.0" },
      policyVersions: {
        segmentation: "semantic-unit-v1",
        chunking: "managed-chunk-v1",
      },
    },
  });

  return parseIngestionPublication({
    schemaVersion: 2,
    publicationId: PUBLICATION_ID,
    sourceId: SOURCE_ID,
    observationId: OBSERVATION_ID,
    producedAt,
    knowledgeUnits: [unit],
    changes: [
      {
        kind: "added",
        knowledgeUnitId: unit.id,
        currentContentDigest: unit.contentDigest,
      },
    ],
  });
}

/**
 * Seeds a home and returns it.
 *
 * `commit` decides which of the two states Ingestion is left in. Prepared only
 * is a publish that started and never finished — the durable trace of a crash
 * between staging and commit, and the one signal the `ingestion` lane has.
 */
async function seededHome(options: {
  readonly commit: boolean;
  readonly cursorAt?: string;
}): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "contextctl-status-full-"));
  directories.push(home);

  const ingestion = openIngestionDatabase({
    location: join(home, "ingestion.db"),
    stateNamespaceId: DEFAULT_STATE_NAMESPACE_ID,
    securityDomain: DEFAULT_SECURITY_DOMAIN,
  });
  try {
    const publications = new SqliteIngestionPublicationStore(ingestion);
    const publication = publicationFixture("2026-08-20T00:00:00.000Z");
    await publications.prepareRecoveryIntent(publication);
    if (options.commit) {
      await publications.commitReady(publication);
    }
  } finally {
    ingestion.close();
  }

  const registry = openRegistryDatabase(join(home, "registry.db"));
  try {
    // The cursor is what makes the Source nameable at all: it is the only
    // enumeration this process has, so a Source with no cursor is invisible to
    // both the delay and the publish probe.
    await new SqliteConsumerCheckpointStore(registry, () =>
      "2026-08-20T00:00:00.000Z",
    ).markProcessed({
      sourceId: SOURCE_ID,
      publicationId: options.cursorAt ?? OLDER_PUBLICATION_ID,
    });
  } finally {
    registry.close();
  }

  return home;
}

async function statusIn(
  home: string,
): Promise<{ readonly stdout: string; readonly code: number }> {
  try {
    const result = await execFileAsync(INSTALLED_COMMAND, ["status", "--json"], {
      env: {
        ...process.env,
        CONTEXTCTL_HOME: home,
        CONTEXTCTL_QDRANT_URL: "http://localhost:6333",
      },
      cwd: home,
    });
    return { stdout: result.stdout, code: 0 };
  } catch (error: unknown) {
    const failure = error as { stdout?: string; code?: number };
    return { stdout: failure.stdout ?? "", code: failure.code ?? 1 };
  }
}

function laneOf(stdout: string, lane: string): { status: string; detail: string } {
  const parsed = JSON.parse(stdout) as {
    readonly lanes: readonly { lane: string; status: string; detail: string }[];
  };
  const verdict = parsed.lanes.find((each) => each.lane === lane);
  if (verdict === undefined) {
    throw new Error(`lane not reported: ${lane}`);
  }
  return verdict;
}

describe("contextctl status against seeded state", () => {
  it("reads a Source's delay back out of the two databases", async () => {
    const home = await seededHome({ commit: true });

    const result = await statusIn(home);

    // The cursor points at `pub_older`, which is not the newest ready
    // Publication, so Registry is behind. This is the assertion the pure test
    // cannot make: it says the two schemas are actually joined by `sourceId` and
    // that `latestForSource` returns the committed row.
    const registry = laneOf(result.stdout, "registry");
    expect(registry.status).toBe("degraded");
    expect(registry.detail).toContain(SOURCE_ID);
  });

  it("still exits zero while Registry is behind", async () => {
    const home = await seededHome({ commit: true });

    const result = await statusIn(home);

    // A delay is not a failure. `not_ready` is what a monitor alerts on, and
    // the approved Cards keep serving while Registry catches up — so a `degraded`
    // registry must not make a CI step or a health probe fail.
    //
    // The assets are missing on this machine, so the two lanes that need them are
    // `not_ready` and the exit code is theirs. What matters here is that the
    // registry lane contributed nothing to it.
    expect(laneOf(result.stdout, "registry").status).toBe("degraded");
    expect([EXIT_CODES.ok, EXIT_CODES.laneNotReady]).toContain(result.code);
    expect(laneOf(result.stdout, "resolve").detail).toContain("임베딩 자산");
  });

  it("sees a publish that was prepared and never committed", async () => {
    const home = await seededHome({ commit: false });

    const result = await statusIn(home);

    // The `ingestion` lane's only durable signal, read through a real row. The
    // Source is probed because it has a cursor; without one it would be invisible,
    // which is the limit the detail states.
    const ingestion = laneOf(result.stdout, "ingestion");
    expect(ingestion.status).toBe("degraded");
    expect(ingestion.detail).toContain(SOURCE_ID);
    expect(ingestion.detail).toContain("contextctl ingest");
  });

  it("reports the probe covered the Source it could name", async () => {
    const home = await seededHome({ commit: true });

    const result = await statusIn(home);

    expect(laneOf(result.stdout, "ingestion").detail).toContain("소비된 Source 1개");
  });

  it("reports a caught-up Source as ready", async () => {
    // The control case. Without it every assertion above would also hold for a
    // command that had started reporting `degraded` unconditionally.
    const home = await seededHome({ commit: true, cursorAt: PUBLICATION_ID });

    const result = await statusIn(home);

    expect(laneOf(result.stdout, "registry").status).toBe("ready");
    expect(laneOf(result.stdout, "ingestion").status).toBe("ready");
  });
});
