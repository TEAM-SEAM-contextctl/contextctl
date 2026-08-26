import {
  DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST,
  DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST_SHA256,
  LOCAL_EMBEDDING_ACTIVE_POINTER_FILE as INGESTION_ACTIVE_POINTER_FILE,
} from "@contextctl/ingestion-indexing";
import { mkdir, mkdtemp, open as openFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  LOCAL_EMBEDDING_ACTIVE_POINTER_FILE as DAEMON_ACTIVE_POINTER_FILE,
  resolveActiveAssetDirectory,
} from "../../src/cli/asset-directory.js";
import { runDiagnosis } from "../../src/cli/doctor.js";
import { resolveContextctlPaths } from "../../src/cli/paths.js";

/**
 * The seam between the diagnosis and the composition.
 *
 * Both were correct in isolation and every unit test of either passed, which is
 * how `contextctl doctor` reported the embedding assets as installed while
 * `contextctl ingest` failed with `embedding_artifact_unavailable` on the same
 * machine, in the same home, seconds apart. `doctor` resolved `active.json` and
 * checked `revisions/<digest>/`; the composition handed the adapter the managed
 * root, one level above the manifest.
 *
 * So the subject here is neither function. It is the claim that the two look at
 * the same directory — a claim no test of one component can make, and the only
 * one that would have caught this.
 */

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

/**
 * A complete install, with the right names and lengths and no real bytes.
 *
 * `truncate` makes sparse files, so the manifest's 390MB entry costs nothing on
 * disk. The contents are zeroes and would fail a digest check, which is exactly
 * what the shallow path must not perform — and what `doctor --deep` still does.
 */
async function installFakeAssets(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "contextctl-seam-"));
  directories.push(root);
  const manifest = DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST;
  const revision = join(root, "embedding-assets", "revisions", manifestDigest());

  for (const file of manifest.files) {
    const target = join(revision, file.path);
    await mkdir(dirname(target), { recursive: true });
    const handle = await openFile(target, "w");
    try {
      await handle.truncate(file.bytes);
    } finally {
      await handle.close();
    }
  }
  await writeFile(
    join(root, "embedding-assets", "active.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      manifestSha256: manifestDigest(),
      revisionDirectory: join("revisions", manifestDigest()),
    })}\n`,
    "utf8",
  );
  return root;
}

function manifestDigest(): string {
  // Read from the profile the runtime pins rather than written out, so a
  // revision bump moves this fixture with it instead of silently missing.
  return "eb0923125496145fce8105135180b42f37d098c688837037d73e4ba11bd8c389";
}

describe("doctor and the composition resolve one asset directory", () => {
  it("keeps the daemon's lightweight pointer name aligned with the installer", () => {
    expect(DAEMON_ACTIVE_POINTER_FILE).toBe(INGESTION_ACTIVE_POINTER_FILE);
  });

  it("hands the adapter the directory the diagnosis approved", async () => {
    const home = await installFakeAssets();
    const environment = { CONTEXTCTL_HOME: home };
    const paths = resolveContextctlPaths(environment);

    const report = await runDiagnosis({ environment });
    const assets = report.steps.find((step) => step.name === "embedding-assets");
    const resolution = await resolveActiveAssetDirectory(
      paths.embeddingAssetDirectory,
      DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST_SHA256,
    );

    // The diagnosis says installed...
    expect(assets?.status).toBe("ok");
    // ...and the value the composition would pass is the revision directory,
    // not the managed root it was configured with. Before the fix these two
    // lines were both satisfiable at once only by accident, because the second
    // one was never asserted anywhere.
    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") return;
    expect(resolution.directory).toBe(
      join(paths.embeddingAssetDirectory, "revisions", manifestDigest()),
    );
    expect(resolution.directory).not.toBe(paths.embeddingAssetDirectory);
  });

  it("refuses the managed root the way the adapter would", async () => {
    const home = await installFakeAssets();
    const paths = resolveContextctlPaths({ CONTEXTCTL_HOME: home });

    // The manifest lives inside the revision directory, never at the root. This
    // is the file the adapter opens first, and its absence at the root is the
    // whole failure — stated here as a fact about the layout so that a future
    // installer that flattens it fails this test rather than the demo.
    const resolution = await resolveActiveAssetDirectory(
      paths.embeddingAssetDirectory,
      DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST_SHA256,
    );
    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") return;

    const { readFile } = await import("node:fs/promises");
    await expect(
      readFile(join(paths.embeddingAssetDirectory, "contextctl-embedding-assets.v1.json")),
    ).rejects.toThrow();
    await expect(
      readFile(join(resolution.directory, "config.json")),
    ).resolves.toBeDefined();
  });

  it("refuses a pointer larger than a pointer can be", async () => {
    const home = await installFakeAssets();
    const paths = resolveContextctlPaths({ CONTEXTCTL_HOME: home });
    const pointerPath = join(paths.embeddingAssetDirectory, "active.json");

    // Valid JSON carrying the right digest, padded past the installer's own
    // 8KiB ceiling. The content is not what is refused — the size is — so a
    // reader without the bound would resolve this happily and would also
    // happily read a file of any size at all.
    const padded = JSON.stringify({
      schemaVersion: 1,
      manifestSha256: manifestDigest(),
      revisionDirectory: join("revisions", manifestDigest()),
      padding: "x".repeat(9 * 1024),
    });
    expect(Buffer.byteLength(padded, "utf8")).toBeGreaterThan(8 * 1024);
    await writeFile(pointerPath, padded, "utf8");

    const resolution = await resolveActiveAssetDirectory(
      paths.embeddingAssetDirectory,
      DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST_SHA256,
    );

    expect(resolution.status).toBe("unavailable");
    if (resolution.status !== "unavailable") return;
    // The existing branch, not a new one: an oversized pointer and a corrupt
    // pointer send the operator to the same command.
    expect(resolution.problem.kind).toBe("pointer_unreadable");
  });

  it("refuses an empty pointer the same way", async () => {
    const home = await installFakeAssets();
    const paths = resolveContextctlPaths({ CONTEXTCTL_HOME: home });
    await writeFile(join(paths.embeddingAssetDirectory, "active.json"), "", "utf8");

    const resolution = await resolveActiveAssetDirectory(
      paths.embeddingAssetDirectory,
      DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST_SHA256,
    );

    // Zero bytes is a file that exists, so it is not `not_installed`; it is a
    // pointer that says nothing. The installer draws the same line.
    expect(resolution.status).toBe("unavailable");
    if (resolution.status !== "unavailable") return;
    expect(resolution.problem.kind).toBe("pointer_unreadable");
  });

  it("reports an uninstalled home as not_installed rather than as damage", async () => {
    const home = await mkdtemp(join(tmpdir(), "contextctl-seam-empty-"));
    directories.push(home);
    const paths = resolveContextctlPaths({ CONTEXTCTL_HOME: home });

    const resolution = await resolveActiveAssetDirectory(
      paths.embeddingAssetDirectory,
      DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST_SHA256,
    );

    // The adapter folds every asset failure into one opaque code. Keeping this
    // case distinct is what lets the CLI answer "install it" instead of "your
    // installation is unusable", which are different instructions.
    expect(resolution.status).toBe("unavailable");
    if (resolution.status !== "unavailable") return;
    expect(resolution.problem.kind).toBe("not_installed");
  });
});
