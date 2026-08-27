// @ts-ignore
import { mkdtemp, rm, writeFile } from "node:fs/promises";
// @ts-ignore
import { tmpdir } from "node:os";
// @ts-ignore
import { join } from "node:path";

import {
  DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST,
  DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST_SHA256,
} from "@contextctl/ingestion-indexing";
import { afterEach, describe, expect, it } from "vitest";

import {
  describeAssetInstallationPlan,
  HuggingFaceLocalEmbeddingAssetSource,
  planAssetInstallation,
  runAssetInstallation,
} from "../../src/cli/asset-installation.js";
import {
  DEFAULT_GRANITE_ASSET_SIZE_COMPACT,
  DEFAULT_GRANITE_ASSET_TOTAL_BYTES,
} from "../../src/embedding-guidance.js";

/**
 * The install command's decisions, none of which involve a network.
 *
 * Two things are under test and neither is "does the download work". The first
 * is the order of the questions: an operator must not be asked to approve a
 * 396 MiB download that is already on disk, and must not have a single byte
 * fetched after they decline. Both are asserted the only way they can be — by
 * counting calls to an injected `fetch` — because a module that consults the
 * network before consent would still pass a test that only inspected its return
 * value.
 *
 * The second is the transport rules that moved out of the repository script: the
 * manifest is a closed list, the buffer is exact-sized, and a failing request is
 * attempted three times and not four. The retry delays are injected so that the
 * schedule stays asserted without the suite paying six seconds for it.
 *
 * Nothing here reaches huggingface.co and nothing here allocates the 372 MiB
 * entry. The installer verifies each file's sha256 as it writes it, so a
 * zero-filled body for the manifest's first and smallest file is rejected before
 * the large one is ever requested — and `manifestSizedFetch` refuses to build a
 * large body at all, so a future change that alters that order fails loudly
 * rather than quietly allocating.
 */

const MANIFEST = DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST;
const TOTAL_BYTES = MANIFEST.files.reduce((sum, file) => sum + file.bytes, 0);

const directories: string[] = [];

afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

async function makeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "contextctl-assets-"));
  directories.push(directory);
  return directory;
}

/** A `fetch` that serves manifest-sized bodies and records every URL it saw. */
function manifestSizedFetch(calls: string[]): typeof globalThis.fetch {
  return async (
    input: Parameters<typeof globalThis.fetch>[0],
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    const file = MANIFEST.files.find((entry) => url.endsWith(`/${entry.path}`));
    if (file === undefined) throw new Error(`unexpected url: ${url}`);
    if (file.bytes > 1024 * 1024) {
      throw new Error(
        `the test refused to allocate ${file.bytes} bytes: the installer should have rejected an earlier file first`,
      );
    }
    return new Response(new Uint8Array(file.bytes), { status: 200 });
  };
}

/** A pointer file shaped exactly like the one the installer writes. */
async function writeActivePointer(
  directory: string,
  content: string,
): Promise<void> {
  await writeFile(join(directory, "active.json"), content, "utf8");
}

function validPointer(): string {
  return JSON.stringify({
    schemaVersion: 1,
    manifestSha256: DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST_SHA256,
    revisionDirectory: `revisions/${DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST_SHA256}`,
  });
}

describe("planAssetInstallation", () => {
  it("keeps lightweight CLI guidance aligned with the owning manifest", () => {
    expect(DEFAULT_GRANITE_ASSET_TOTAL_BYTES).toBe(TOTAL_BYTES);
  });

  it("restates the manifest and nothing else", () => {
    const plan = planAssetInstallation({ targetDirectory: "/tmp/target" });

    expect(plan.repository).toBe(MANIFEST.repository);
    expect(plan.revision).toBe(MANIFEST.revision);
    expect(plan.license).toBe(MANIFEST.license);
    expect(plan.fileCount).toBe(5);
    expect(plan.fileCount).toBe(MANIFEST.files.length);
    expect(plan.totalBytes).toBe(TOTAL_BYTES);
    expect(plan.targetDirectory).toBe("/tmp/target");
  });

  it("names huggingface.co without a staged directory and the directory with one", () => {
    expect(planAssetInstallation({ targetDirectory: "/tmp/t" }).origin).toBe(
      "huggingface.co",
    );
    expect(
      planAssetInstallation({
        targetDirectory: "/tmp/t",
        sourceDirectory: "/srv/staged-assets",
      }).origin,
    ).toBe("/srv/staged-assets");
  });
});

describe("describeAssetInstallationPlan", () => {
  it("states the size, the origin, the licence and the pinned revision", () => {
    const text = describeAssetInstallationPlan(
      planAssetInstallation({ targetDirectory: "/tmp/target" }),
    );

    expect(text).toContain(DEFAULT_GRANITE_ASSET_SIZE_COMPACT);
    expect(text).toContain("Apache-2.0");
    expect(text).toContain(MANIFEST.repository);
    expect(text).toContain(MANIFEST.revision);
    expect(text).toContain("huggingface.co");
    expect(text).toContain("/tmp/target");
  });
});

describe("runAssetInstallation", () => {
  it("fetches nothing when consent is refused", async () => {
    const directory = await makeDirectory();
    const calls: string[] = [];

    const outcome = await runAssetInstallation({
      targetDirectory: directory,
      progress: () => {},
      confirm: async () => false,
      fetch: manifestSizedFetch(calls),
      delay: async () => {},
    });

    expect(outcome.status).toBe("declined");
    expect(outcome.directory).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("proceeds when no confirmation is supplied", async () => {
    const directory = await makeDirectory();
    const calls: string[] = [];
    const messages: string[] = [];

    // The bodies are the right size but not the right bytes, so the installer
    // rejects the first file. Reaching that rejection is the proof that consent
    // was treated as already given.
    await expect(
      runAssetInstallation({
        targetDirectory: directory,
        progress: (message) => messages.push(message),
        fetch: manifestSizedFetch(calls),
        delay: async () => {},
      }),
    ).rejects.toThrow();

    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]).toContain(MANIFEST.repository);
    expect(calls[0]).toContain(MANIFEST.revision);
    expect(messages.length).toBeGreaterThanOrEqual(1);
  });

  it("answers already_installed from the pointer alone", async () => {
    const directory = await makeDirectory();
    await writeActivePointer(directory, validPointer());
    const calls: string[] = [];
    let confirmed = 0;

    const outcome = await runAssetInstallation({
      targetDirectory: directory,
      progress: () => {},
      confirm: async () => {
        confirmed += 1;
        return true;
      },
      fetch: manifestSizedFetch(calls),
      delay: async () => {},
      now: () => 0,
    });

    expect(outcome.status).toBe("already_installed");
    expect(outcome.directory).toBe(
      join(
        directory,
        "revisions",
        DEFAULT_GRANITE_EMBEDDING_ASSET_MANIFEST_SHA256,
      ),
    );
    expect(outcome.installedBytes).toBe(TOTAL_BYTES);
    expect(confirmed).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("installs when the pointer names a different manifest", async () => {
    const directory = await makeDirectory();
    await writeActivePointer(
      directory,
      JSON.stringify({
        schemaVersion: 1,
        manifestSha256: "0".repeat(64),
        revisionDirectory: `revisions/${"0".repeat(64)}`,
      }),
    );
    const calls: string[] = [];

    await expect(
      runAssetInstallation({
        targetDirectory: directory,
        progress: () => {},
        fetch: manifestSizedFetch(calls),
        delay: async () => {},
      }),
    ).rejects.toThrow();

    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  it("installs rather than throwing when the pointer is absent, empty or corrupt", async () => {
    for (const pointer of [undefined, "", "{ not json", "null", "[]"]) {
      const directory = await makeDirectory();
      if (pointer !== undefined) {
        await writeActivePointer(directory, pointer);
      }
      const calls: string[] = [];

      await expect(
        runAssetInstallation({
          targetDirectory: directory,
          progress: () => {},
          fetch: manifestSizedFetch(calls),
          delay: async () => {},
        }),
      ).rejects.toThrow();

      expect(calls.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("reports progress for every file the installer asks for", async () => {
    const directory = await makeDirectory();
    const messages: string[] = [];

    await expect(
      runAssetInstallation({
        targetDirectory: directory,
        progress: (message) => messages.push(message),
        fetch: manifestSizedFetch([]),
        delay: async () => {},
      }),
    ).rejects.toThrow();

    expect(messages.some((line) => line.includes("config.json"))).toBe(true);
  });
});

describe("HuggingFaceLocalEmbeddingAssetSource", () => {
  const file = MANIFEST.files[0];
  if (file === undefined) throw new Error("the manifest lists no files");

  function makeSource(options: {
    readonly fetch: typeof globalThis.fetch;
    readonly delays?: number[];
    readonly messages?: string[];
  }): HuggingFaceLocalEmbeddingAssetSource {
    const delays = options.delays;
    const messages = options.messages;
    return new HuggingFaceLocalEmbeddingAssetSource({
      manifest: MANIFEST,
      progress: (message) => {
        messages?.push(message);
      },
      fetch: options.fetch,
      delay: async (milliseconds) => {
        delays?.push(milliseconds);
      },
    });
  }

  it("refuses a path the manifest does not list", async () => {
    const calls: string[] = [];
    const source = makeSource({ fetch: manifestSizedFetch(calls) });

    await expect(source.read("onnx/model_q4.onnx")).rejects.toThrow(
      /not in the manifest/,
    );
    expect(calls).toHaveLength(0);
  });

  it("refuses a body longer than the manifest says", async () => {
    const source = makeSource({
      fetch: async () =>
        new Response(new Uint8Array(file.bytes + 1), {
          status: 200,
          headers: { "content-encoding": "gzip" },
        }),
    });

    await expect(source.read(file.path)).rejects.toThrow(/longer than/);
  });

  it("refuses a body shorter than the manifest says", async () => {
    const source = makeSource({
      fetch: async () =>
        new Response(new Uint8Array(file.bytes - 1), {
          status: 200,
          headers: { "content-encoding": "gzip" },
        }),
    });

    await expect(source.read(file.path)).rejects.toThrow(/bytes, the manifest/);
  });

  it("refuses a content-length that disagrees with the manifest", async () => {
    const source = makeSource({
      fetch: async () =>
        new Response(new Uint8Array(file.bytes), {
          status: 200,
          headers: { "content-length": String(file.bytes + 512) },
        }),
    });

    await expect(source.read(file.path)).rejects.toThrow(/content-length/);
  });

  it("attempts a failing request exactly three times", async () => {
    let calls = 0;
    const delays: number[] = [];
    const source = makeSource({
      fetch: async () => {
        calls += 1;
        return new Response(null, { status: 500, statusText: "Server Error" });
      },
      delays,
    });

    await expect(source.read(file.path)).rejects.toThrow(/HTTP 500/);
    expect(calls).toBe(3);
    // Linear, not exponential, and no delay after the final attempt.
    expect(delays).toEqual([2_000, 4_000]);
  });

  it("stops at an already aborted signal without requesting anything", async () => {
    let calls = 0;
    const delays: number[] = [];
    const source = makeSource({
      fetch: async () => {
        calls += 1;
        return new Response(new Uint8Array(file.bytes), { status: 200 });
      },
      delays,
    });

    await expect(
      source.read(file.path, AbortSignal.abort(new Error("cancelled"))),
    ).rejects.toThrow(/cancelled/);
    expect(calls).toBe(0);
    expect(delays).toHaveLength(0);
  });

  it("does not retry a request the caller aborted mid-flight", async () => {
    const controller = new AbortController();
    let calls = 0;
    const source = makeSource({
      fetch: async () => {
        calls += 1;
        controller.abort(new Error("operator cancelled"));
        throw new Error("aborted");
      },
    });

    await expect(source.read(file.path, controller.signal)).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
