import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  addSource,
  defaultReferenceFor,
  readSourcesFile,
  removeSource,
  SourcesFileError,
  SOURCES_FILE_VERSION,
  toSourceConfigurations,
  writeSourcesFile,
  type SourcesDocument,
} from "../../src/cli/sources-file.js";

/**
 * The registration file, exercised against a real filesystem.
 *
 * Nothing here is mocked. The file is the whole point of the module — it exists
 * because a CLI's memory dies with the process — so a test that stubs the
 * filesystem would assert the one thing that is not in question and skip the
 * ones that are: whether a hand-edited file is rejected on the right grounds,
 * and whether two writes of the same content produce the same bytes.
 */

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
  const directory = await mkdtemp(join(tmpdir(), "contextctl-sources-"));
  directories.push(directory);
  return directory;
}

/** The error code a read produced, or a sentinel naming what happened instead. */
async function readCode(filePath: string): Promise<string> {
  try {
    await readSourcesFile(filePath);
  } catch (error) {
    return error instanceof SourcesFileError
      ? error.code
      : `not_sources_file_error: ${String(error)}`;
  }
  return "no_error";
}

/** As `readCode`, for the synchronous document operations. */
function thrownCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof SourcesFileError
      ? error.code
      : `not_sources_file_error: ${String(error)}`;
  }
  return "no_error";
}

const EMPTY: SourcesDocument = { version: 1, sources: {} };

describe("readSourcesFile", () => {
  it("treats a missing file as an empty document", async () => {
    const directory = await makeDirectory();

    await expect(
      readSourcesFile(join(directory, "does-not-exist.json")),
    ).resolves.toEqual(EMPTY);
  });

  it("rejects an empty file rather than treating it as empty state", async () => {
    const directory = await makeDirectory();
    const filePath = join(directory, "sources.json");
    await writeFile(filePath, "", "utf8");

    await expect(readCode(filePath)).resolves.toBe("malformed");
  });

  it("rejects a file that is not JSON", async () => {
    const directory = await makeDirectory();
    const filePath = join(directory, "sources.json");
    await writeFile(filePath, "not json", "utf8");

    await expect(readCode(filePath)).resolves.toBe("malformed");
  });

  it("rejects a top level array", async () => {
    const directory = await makeDirectory();
    const filePath = join(directory, "sources.json");
    await writeFile(filePath, "[]", "utf8");

    await expect(readCode(filePath)).resolves.toBe("malformed");
  });

  it("rejects a version it cannot read", async () => {
    const directory = await makeDirectory();
    const filePath = join(directory, "sources.json");
    await writeFile(filePath, '{"version":2,"sources":{}}', "utf8");

    await expect(readCode(filePath)).resolves.toBe("unsupported_version");
  });

  it("rejects a document with no sources object", async () => {
    const directory = await makeDirectory();
    const filePath = join(directory, "sources.json");
    await writeFile(filePath, '{"version":1}', "utf8");

    await expect(readCode(filePath)).resolves.toBe("malformed");
  });

  it("rejects a reference containing a space", async () => {
    const directory = await makeDirectory();
    const filePath = join(directory, "sources.json");
    await writeFile(
      filePath,
      '{"version":1,"sources":{"a b":{"path":"/tmp/a.md","displayName":"a.md"}}}',
      "utf8",
    );

    await expect(readCode(filePath)).resolves.toBe("invalid_entry");
  });

  it("rejects a stored path that is not absolute", async () => {
    const directory = await makeDirectory();
    const filePath = join(directory, "sources.json");
    await writeFile(
      filePath,
      '{"version":1,"sources":{"source.a":{"path":"docs/a.md","displayName":"a.md"}}}',
      "utf8",
    );

    await expect(readCode(filePath)).resolves.toBe("invalid_entry");
  });

  it("rejects a display name that is not a string", async () => {
    const directory = await makeDirectory();
    const filePath = join(directory, "sources.json");
    await writeFile(
      filePath,
      '{"version":1,"sources":{"source.a":{"path":"/tmp/a.md","displayName":7}}}',
      "utf8",
    );

    await expect(readCode(filePath)).resolves.toBe("invalid_entry");
  });
});

describe("addSource", () => {
  it("refuses a reference that is already registered", () => {
    const document = addSource(EMPTY, {
      reference: "source.a",
      path: "/tmp/a.md",
      workingDirectory: "/tmp",
    });

    expect(
      thrownCode(() =>
        addSource(document, {
          reference: "source.a",
          path: "/tmp/other.md",
          workingDirectory: "/tmp",
        }),
      ),
    ).toBe("duplicate_reference");
  });

  it("resolves a relative path against the given working directory", () => {
    const document = addSource(EMPTY, {
      reference: "source.a",
      path: "docs/a.md",
      workingDirectory: "/tmp/project",
    });

    expect(document.sources["source.a"]).toEqual({
      path: "/tmp/project/docs/a.md",
      displayName: "a.md",
    });
  });

  it("refuses an empty path", () => {
    expect(
      thrownCode(() =>
        addSource(EMPTY, {
          reference: "source.a",
          path: "",
          workingDirectory: "/tmp",
        }),
      ),
    ).toBe("invalid_entry");
  });

  it("refuses a reference outside the allowed character set", () => {
    expect(
      thrownCode(() =>
        addSource(EMPTY, {
          reference: "Source A",
          path: "/tmp/a.md",
          workingDirectory: "/tmp",
        }),
      ),
    ).toBe("invalid_entry");
  });

  it("leaves the input document untouched", () => {
    const before = addSource(EMPTY, {
      reference: "source.a",
      path: "/tmp/a.md",
      workingDirectory: "/tmp",
    });

    const after = addSource(before, {
      reference: "source.b",
      path: "/tmp/b.md",
      workingDirectory: "/tmp",
    });

    expect(Object.keys(before.sources)).toEqual(["source.a"]);
    expect(Object.keys(after.sources).sort()).toEqual([
      "source.a",
      "source.b",
    ]);
  });

  it("defaults the display name to the file name, extension included", () => {
    const document = addSource(EMPTY, {
      reference: "source.a",
      path: "/tmp/project/payment.md",
      workingDirectory: "/tmp",
    });

    expect(document.sources["source.a"]?.displayName).toBe("payment.md");
  });
});

describe("removeSource", () => {
  it("refuses a reference that was never registered", () => {
    expect(thrownCode(() => removeSource(EMPTY, "source.missing"))).toBe(
      "unknown_reference",
    );
  });

  it("leaves the input document untouched", () => {
    const before = addSource(EMPTY, {
      reference: "source.a",
      path: "/tmp/a.md",
      workingDirectory: "/tmp",
    });

    const after = removeSource(before, "source.a");

    expect(Object.keys(before.sources)).toEqual(["source.a"]);
    expect(Object.keys(after.sources)).toEqual([]);
  });
});

describe("defaultReferenceFor", () => {
  it("derives a reference from the file stem", () => {
    expect(defaultReferenceFor("/tmp/x/payment.md")).toBe("source.payment");
  });

  it("lowercases and replaces characters the reference may not contain", () => {
    expect(defaultReferenceFor("/tmp/x/My Doc.md")).toBe("source.my-doc");
  });

  it("refuses a path whose file name is nothing but an extension", () => {
    expect(thrownCode(() => defaultReferenceFor("/tmp/x/.md"))).toBe(
      "invalid_entry",
    );
  });
});

describe("toSourceConfigurations", () => {
  it("projects only the path, which is all the runtime takes", () => {
    const document = addSource(EMPTY, {
      reference: "source.a",
      path: "/tmp/a.md",
      displayName: "재무 안내",
      workingDirectory: "/tmp",
    });

    const configurations = toSourceConfigurations(document);

    expect(configurations).toEqual({ "source.a": { path: "/tmp/a.md" } });
    expect(Object.keys(configurations["source.a"] ?? {})).toEqual(["path"]);
  });
});

describe("writeSourcesFile", () => {
  it("round trips a document through the file", async () => {
    const directory = await makeDirectory();
    const filePath = join(directory, "sources.json");
    const document = addSource(
      addSource(EMPTY, {
        reference: "source.a",
        path: "/tmp/a.md",
        workingDirectory: "/tmp",
      }),
      { reference: "source.b", path: "/tmp/b.md", workingDirectory: "/tmp" },
    );

    await writeSourcesFile(filePath, document);

    await expect(readSourcesFile(filePath)).resolves.toEqual(document);
  });

  it("serializes the same content to the same bytes whatever order it was built in", async () => {
    const directory = await makeDirectory();
    const forward = addSource(
      addSource(EMPTY, {
        reference: "source.a",
        path: "/tmp/a.md",
        workingDirectory: "/tmp",
      }),
      { reference: "source.b", path: "/tmp/b.md", workingDirectory: "/tmp" },
    );
    const reversed = addSource(
      addSource(EMPTY, {
        reference: "source.b",
        path: "/tmp/b.md",
        workingDirectory: "/tmp",
      }),
      { reference: "source.a", path: "/tmp/a.md", workingDirectory: "/tmp" },
    );

    const forwardPath = join(directory, "forward.json");
    const reversedPath = join(directory, "reversed.json");
    await writeSourcesFile(forwardPath, forward);
    await writeSourcesFile(reversedPath, reversed);

    const forwardBytes = await readFile(forwardPath, "utf8");
    expect(await readFile(reversedPath, "utf8")).toBe(forwardBytes);
    expect(forwardBytes.endsWith("\n")).toBe(true);
  });

  it("creates the directories leading to the file", async () => {
    const directory = await makeDirectory();
    const filePath = join(directory, "nested", "deeper", "sources.json");

    await writeSourcesFile(filePath, EMPTY);

    await expect(readSourcesFile(filePath)).resolves.toEqual(EMPTY);
  });

  it("writes the version the reader expects", async () => {
    const directory = await makeDirectory();
    const filePath = join(directory, "sources.json");

    await writeSourcesFile(filePath, EMPTY);

    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({
      version: SOURCES_FILE_VERSION,
      sources: {},
    });
  });
});
