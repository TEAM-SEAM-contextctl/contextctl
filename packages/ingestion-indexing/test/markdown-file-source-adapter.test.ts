import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  InMemorySourceObservationStore,
  isMarkdownSourceSnapshot,
  MarkdownCapture,
  MarkdownFileSourceAdapter,
  RemarkMarkdownParser,
  SourceAdapterRegistry,
  SourceManagement,
  SourceManagementError,
  type BlockIdSource,
  type CredentialResolver,
  type SourceConfigurationResolver,
  type SourceIdGenerator,
} from "../src/index.js";

const STRUCTURE_FIXTURE = fileURLToPath(
  new URL("./fixtures/markdown/structure.md", import.meta.url),
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("Markdown file source adapter", () => {
  it("canonicalizes relative and absolute paths to the same target", () => {
    const adapter = new MarkdownFileSourceAdapter();
    const basePath = dirname(STRUCTURE_FIXTURE);
    const relativePath = relative(basePath, STRUCTURE_FIXTURE);

    const relativeConfiguration = adapter.validateConfiguration({
      path: relativePath,
      basePath,
    });
    const absoluteConfiguration = adapter.validateConfiguration({
      path: STRUCTURE_FIXTURE,
    });

    expect(relativeConfiguration.targetKey).toBe(absoluteConfiguration.targetKey);
    expect(relativeConfiguration.value).toEqual(absoluteConfiguration.value);
  });

  it("registers, probes, observes and captures a real Markdown file", async () => {
    const adapter = new MarkdownFileSourceAdapter({
      now: () => new Date("2026-07-31T00:00:00.000Z"),
    });
    const configuration = {
      path: relative(process.cwd(), STRUCTURE_FIXTURE),
      basePath: process.cwd(),
    };
    const management = createManagement(adapter, configuration);
    const registered = await management.register({
      sourceType: "markdown",
      displayName: "Markdown structure fixture",
      configReference: "source.markdown",
      polling: { enabled: true, intervalMs: 60_000 },
    });
    const ready = (await management.inspect(registered)).source;
    const observed = await management.requestObservation(ready);

    expect(ready.inspectionStatus).toEqual({
      state: "ready",
      capabilities: [{ name: "document_capture", status: "available" }],
    });
    expect(observed.changeSignal.status).toBe("changed");
    expect(observed.attempt.status).toBe("changed");
    if (observed.attempt.status !== "changed") {
      return;
    }
    expect(isMarkdownSourceSnapshot(observed.attempt.payload)).toBe(true);
    if (!isMarkdownSourceSnapshot(observed.attempt.payload)) {
      return;
    }

    const document = new MarkdownCapture({
      parser: new RemarkMarkdownParser(),
      ids: new SequentialBlockIdSource(),
    }).capture({
      source: ready,
      observationId: "obs_markdown",
      documentId: "doc_markdown",
      snapshot: observed.attempt.payload,
    });

    expect(document.sourceId).toBe(ready.id);
    expect(document.contentDigest).toBe(observed.attempt.payload.contentDigest);
    expect(document.blocks).not.toHaveLength(0);

    expect(observed.changeSignal.token).toBeDefined();
    const unchanged = await management.requestObservation(
      observed.source,
      observed.changeSignal.token === undefined
        ? {}
        : { previousChangeToken: observed.changeSignal.token },
    );
    expect(unchanged).toMatchObject({
      changeSignal: { status: "unchanged" },
      attempt: { status: "unchanged" },
    });
  });

  it.each([
    [{ path: "missing.md" }, "target_not_found"],
    [{ path: "unsupported.txt" }, "invalid_format"],
  ] as const)("reports a bounded failure for %j", async (configuration, code) => {
    const management = createManagement(
      new MarkdownFileSourceAdapter(),
      configuration,
    );
    if (code === "invalid_format") {
      const error = await sourceFailure(
        management.register({
          sourceType: "markdown",
          displayName: "Invalid fixture",
          configReference: "source.markdown",
          polling: { enabled: false },
        }),
      );
      expect(error.code).toBe(code);
      expect(String(error)).not.toContain(process.cwd());
      return;
    }

    const source = await management.register({
      sourceType: "markdown",
      displayName: "Invalid fixture",
      configReference: "source.markdown",
      polling: { enabled: false },
    });
    const error = await sourceFailure(management.inspect(source));
    expect(error.code).toBe(code);
    expect(String(error)).not.toContain(process.cwd());
    expect(JSON.stringify(error)).not.toContain(process.cwd());
  });

  it("rejects directories, invalid UTF-8 and oversized files without source leakage", async () => {
    const directory = await createTemporaryDirectory();
    const markdownDirectory = join(directory, "directory.md");
    const invalidUtf8Path = join(directory, "invalid.md");
    const oversizedPath = join(directory, "oversized.md");
    await mkdir(markdownDirectory);
    await writeFile(invalidUtf8Path, Uint8Array.from([0xc3, 0x28]));
    await writeFile(oversizedPath, "# Oversized\n");

    const cases = [
      { path: markdownDirectory, maxBytes: undefined, stage: "inspect" },
      { path: invalidUtf8Path, maxBytes: undefined, stage: "observe" },
      { path: oversizedPath, maxBytes: 4, stage: "inspect" },
    ] as const;
    for (const input of cases) {
      const configuration = input.maxBytes === undefined
        ? { path: input.path }
        : { path: input.path, maxBytes: input.maxBytes };
      const management = createManagement(
        new MarkdownFileSourceAdapter(),
        configuration,
      );
      const source = await management.register({
        sourceType: "markdown",
        displayName: "Unsafe fixture",
        configReference: "source.markdown",
        polling: { enabled: false },
      });
      if (input.stage === "inspect") {
        const error = await sourceFailure(management.inspect(source));
        expect(error.code).toBe("invalid_format");
        expect(JSON.stringify(error)).not.toContain(directory);
        continue;
      }
      const ready = (await management.inspect(source)).source;
      const error = await sourceFailure(management.requestObservation(ready));
      expect(error.code).toBe("invalid_format");
      expect(JSON.stringify(error)).not.toContain(directory);
    }
  });

  it.skipIf(process.platform === "win32")(
    "maps an unreadable file to permission_denied without exposing its path",
    async () => {
      const directory = await createTemporaryDirectory();
      const path = join(directory, "unreadable.md");
      await writeFile(path, "# Unreadable\n");
      await chmod(path, 0o000);
      const management = createManagement(new MarkdownFileSourceAdapter(), {
        path,
      });
      const source = await management.register({
        sourceType: "markdown",
        displayName: "Unreadable fixture",
        configReference: "source.markdown",
        polling: { enabled: false },
      });

      const error = await sourceFailure(management.inspect(source));

      expect(error.code).toBe("permission_denied");
      expect(String(error)).not.toContain(directory);
      expect(JSON.stringify(error)).not.toContain(directory);
    },
  );

  it("normalizes BOM, line endings and Unicode before hashing", async () => {
    const directory = await createTemporaryDirectory();
    const path = join(directory, "canonical.md");
    await writeFile(path, "\uFEFF# Cafe\u0301\r\n\r\nBody\r\n", "utf8");
    const adapter = new MarkdownFileSourceAdapter({
      now: () => new Date("2026-07-31T00:00:00.000Z"),
    });
    const management = createManagement(adapter, { path });
    const source = await management.register({
      sourceType: "markdown",
      displayName: "Canonical fixture",
      configReference: "source.markdown",
      polling: { enabled: false },
    });
    const ready = (await management.inspect(source)).source;
    const result = await management.requestObservation(ready);

    expect(result.attempt.status).toBe("changed");
    if (result.attempt.status !== "changed") {
      return;
    }
    expect(isMarkdownSourceSnapshot(result.attempt.payload)).toBe(true);
    if (!isMarkdownSourceSnapshot(result.attempt.payload)) {
      return;
    }
    expect(result.attempt.payload.content).toBe("# Café\n\nBody\n");
    expect(result.changeSignal.token).toBe(result.attempt.payload.contentDigest);
    expect(await readFile(path, "utf8")).toContain("\r\n");
  });

  it("returns the token from the same snapshot as the observed payload", async () => {
    const directory = await createTemporaryDirectory();
    const path = join(directory, "mutable.md");
    await writeFile(path, "# Before\n", "utf8");
    const adapter = new MutatingAfterReadMarkdownAdapter(path, {
      now: () => new Date("2026-07-31T00:00:00.000Z"),
    });
    const management = createManagement(adapter, { path });
    const source = await management.register({
      sourceType: "markdown",
      displayName: "Mutable fixture",
      configReference: "source.markdown",
      polling: { enabled: false },
    });
    const ready = (await management.inspect(source)).source;

    const result = await management.requestObservation(ready);

    expect(result.attempt.status).toBe("changed");
    if (
      result.attempt.status !== "changed" ||
      !isMarkdownSourceSnapshot(result.attempt.payload)
    ) {
      return;
    }
    expect(result.attempt.payload.content).toBe("# After\n");
    expect(adapter.fullReadCount).toBe(2);
    expect(result.changeSignal).toEqual({
      status: "changed",
      token: result.attempt.payload.contentDigest,
    });
  });

  it("fails with a bounded code when every candidate snapshot changes in place", async () => {
    const directory = await createTemporaryDirectory();
    const path = join(directory, "unstable.md");
    await writeFile(path, "# Initial\n", "utf8");
    const adapter = new AlwaysMutatingMarkdownAdapter(path, {
      stableReadAttempts: 2,
    });
    const management = createManagement(adapter, { path });
    const source = await management.register({
      sourceType: "markdown",
      displayName: "Unstable fixture",
      configReference: "source.markdown",
      polling: { enabled: false },
    });
    const ready = (await management.inspect(source)).source;

    const error = await sourceFailure(management.requestObservation(ready));

    expect(error.code).toBe("source_unstable");
    expect(adapter.fullReadCount).toBe(2);
    expect(JSON.stringify(error)).not.toContain(directory);
  });
});

function createManagement(
  adapter: MarkdownFileSourceAdapter,
  configuration: unknown,
): SourceManagement {
  return new SourceManagement({
    adapters: new SourceAdapterRegistry([adapter]),
    configurations: new MemoryConfigurationResolver(configuration),
    credentials: new EmptyCredentialResolver(),
    ids: new SequentialSourceIdGenerator(),
    observations: new InMemorySourceObservationStore(),
    defaultTimeoutMs: 2_000,
  });
}

class MemoryConfigurationResolver implements SourceConfigurationResolver {
  constructor(readonly configuration: unknown) {}

  async resolve(): Promise<unknown> {
    return this.configuration;
  }
}

class EmptyCredentialResolver implements CredentialResolver {
  async resolve(): Promise<never> {
    throw new Error("credential resolution was not expected");
  }
}

class SequentialSourceIdGenerator implements SourceIdGenerator {
  #next = 1;

  nextSourceId(): string {
    return `src_markdown${this.#next++}`;
  }
}

class MutatingAfterReadMarkdownAdapter extends MarkdownFileSourceAdapter {
  fullReadCount = 0;

  constructor(
    private readonly path: string,
    options: ConstructorParameters<typeof MarkdownFileSourceAdapter>[0],
  ) {
    super(options);
  }

  protected override async readSnapshotBytes(
    handle: FileHandle,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const bytes = await super.readSnapshotBytes(handle, signal);
    this.fullReadCount += 1;
    if (this.fullReadCount === 1) {
      await writeFile(this.path, "# After\n", "utf8");
    }
    return bytes;
  }
}

class AlwaysMutatingMarkdownAdapter extends MarkdownFileSourceAdapter {
  fullReadCount = 0;

  constructor(
    private readonly path: string,
    options: ConstructorParameters<typeof MarkdownFileSourceAdapter>[0],
  ) {
    super(options);
  }

  protected override async readSnapshotBytes(
    handle: FileHandle,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const bytes = await super.readSnapshotBytes(handle, signal);
    this.fullReadCount += 1;
    await writeFile(
      this.path,
      `# Mutation ${String(this.fullReadCount)} ${"x".repeat(this.fullReadCount)}\n`,
      "utf8",
    );
    return bytes;
  }
}

class SequentialBlockIdSource implements BlockIdSource {
  #next = 1;

  nextBlockId(): string {
    return `blk_markdown${this.#next++}`;
  }
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "contextctl-markdown-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function sourceFailure(
  operation: Promise<unknown>,
): Promise<SourceManagementError> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof SourceManagementError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected SourceManagementError");
}
