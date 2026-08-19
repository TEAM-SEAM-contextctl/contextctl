import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runIngest } from "../../src/cli/commands.js";
import { EXIT_CODES } from "../../src/cli/exit-codes.js";
import type { CliRuntime } from "../../src/cli/runtime.js";
import type { RegistryIntakeResult } from "../../src/registry-intake.js";

/**
 * What `contextctl ingest` reports when Registry refuses a Source.
 *
 * The gap this closes: a refusal used to print one word and exit 0, so a
 * scheduled job or a CI step read a Source that had stopped consuming as a
 * successful ingest. The diagnostic was already there — Registry returns a code
 * and the `sourceId` — and nothing looked at it.
 *
 * The runtime here is hand-built rather than assembled. `buildCliRuntime` opens
 * two databases and resolves the embedding artifact, none of which takes part in
 * turning a claim result into an exit code, and requiring the 415MB asset would
 * make this file unrunnable in the environment that most needs it.
 */

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function sourcesFileWith(reference: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "contextctl-ingest-"));
  directories.push(home);
  const file = join(home, "sources.json");
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      sources: {
        [reference]: {
          path: join(home, "payment.md"),
          sourceType: "markdown",
          displayName: "payment",
        },
      },
    }),
    "utf8",
  );
  return file;
}

/** A runtime whose publish succeeds and whose claim answers with `result`. */
async function cliThatClaims(result: RegistryIntakeResult): Promise<CliRuntime> {
  const sourcesFile = await sourcesFileWith("source.payment");
  return {
    paths: { sourcesFile },
    vectorBackend: { kind: "memory" },
    runtime: {
      connectorId: "vector.local",
      securityDomain: "local",
      ingestion: {
        workflow: {
          publish: async () => ({
            status: "published",
            publication: { publicationId: "pub_second" },
          }),
        },
      },
      registryIntake: { claim: async () => result },
    },
    // Cast once, and only over the parts a claim-to-exit-code mapping never
    // reads. Widening this fake later is the signal that the mapping started
    // depending on something real, and that it belongs in an assembled test.
  } as unknown as CliRuntime;
}

const forked: RegistryIntakeResult = {
  status: "forked",
  publicationId: "pub_second",
  cardVersions: [],
  sourceId: "src_payments",
  diagnostic: {
    code: "publication_chain_forked",
    detail: "publication pub_second starts a second chain for source src_payments",
  },
};

const deferred: RegistryIntakeResult = {
  status: "deferred",
  publicationId: "pub_second",
  cardVersions: [],
  sourceId: "src_payments",
  awaiting: "pub_first",
  diagnostic: {
    code: "publication_chain_gap",
    detail: "publication pub_second follows pub_first, which has not been consumed",
  },
};

describe("ingest reporting a refused Source", () => {
  it("exits with the fork code rather than reporting success", async () => {
    const outcome = await runIngest(await cliThatClaims(forked), undefined);

    expect(outcome.exitCode).toBe(EXIT_CODES.chainForked);
  });

  it("exits with the gap code, which a retry can clear", async () => {
    const outcome = await runIngest(await cliThatClaims(deferred), undefined);

    // Distinct from the fork code on purpose: a caller may retry this one and
    // must not retry the other.
    expect(outcome.exitCode).toBe(EXIT_CODES.chainDeferred);
    expect(outcome.exitCode).not.toBe(EXIT_CODES.chainForked);
  });

  it("names the code and the Source in the output", async () => {
    const outcome = await runIngest(await cliThatClaims(forked), undefined);

    // The status word alone said something stopped without saying which Source
    // or what kind of stop it was.
    expect(outcome.stdout).toContain("publication_chain_forked");
    expect(outcome.stdout).toContain("src_payments");
  });

  it("puts the refusal on stderr, where a pipe cannot eat it", async () => {
    const outcome = await runIngest(await cliThatClaims(deferred), undefined);

    // stdout is what an operator pipes into a file or a pager; a run that
    // consumed nothing has to say so on the stream that survives that.
    expect(outcome.stderr.join("\n")).toContain("publication_chain_gap");
    expect(outcome.stderr.join("\n")).toContain("src_payments");
  });

  it("reports success when nothing was refused", async () => {
    const claimed: RegistryIntakeResult = {
      status: "claimed",
      publicationId: "pub_second",
      cardVersions: [],
    };

    const outcome = await runIngest(await cliThatClaims(claimed), undefined);

    // The control case. Without it every assertion above would also hold for a
    // command that had started exiting non-zero on every run.
    expect(outcome.exitCode).toBe(EXIT_CODES.ok);
  });
});
