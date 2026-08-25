import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RemarkMarkdownParser } from "@contextctl/ingestion-indexing";
import { afterEach, describe, expect, it } from "vitest";

import {
  BUNDLED_DEMO_DOCUMENTS,
  DemoInitializationError,
  initializeBundledDemo,
} from "../../src/cli/demo.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "contextctl-demo-test-"));
  directories.push(directory);
  return directory;
}

describe("bundled demo initialization", () => {
  it("exports all packaged documents into an operator-owned directory", async () => {
    const workingDirectory = await temporaryDirectory();

    const initialized = await initializeBundledDemo({
      destination: "demo",
      workingDirectory,
    });

    expect(initialized.directory).toBe(join(workingDirectory, "demo"));
    expect(initialized.documents).toEqual(BUNDLED_DEMO_DOCUMENTS);
    await expect(readFile(join(initialized.directory, "leave.md"), "utf8")).resolves.toContain(
      "반차는 오전 반차와 오후 반차로 나뉘며 연차 0.5일을 차감합니다.",
    );
    await expect(readFile(join(initialized.directory, "shipping.md"), "utf8")).resolves.toContain(
      "운송장은 출고 후 2시간 이내에 발급됩니다.",
    );
  });

  it("keeps every bundled document fully accepted by the production parser", async () => {
    const workingDirectory = await temporaryDirectory();
    const initialized = await initializeBundledDemo({
      destination: "demo",
      workingDirectory,
    });
    const parser = new RemarkMarkdownParser();

    for (const document of initialized.documents) {
      const parsed = parser.parse(
        await readFile(join(initialized.directory, document), "utf8"),
      );
      expect(parsed.completeness, document).toBe("complete");
      expect(parsed.diagnostics, document).toEqual([]);
      expect(parsed.blocks.length, document).toBeGreaterThan(0);
    }
  });

  it("never overwrites a directory the operator already owns", async () => {
    const workingDirectory = await temporaryDirectory();
    const destination = join(workingDirectory, "demo");
    await mkdir(destination);
    await writeFile(join(destination, "keep.txt"), "operator data", "utf8");

    await expect(
      initializeBundledDemo({ destination, workingDirectory }),
    ).rejects.toBeInstanceOf(DemoInitializationError);
    await expect(readFile(join(destination, "keep.txt"), "utf8")).resolves.toBe("operator data");
  });
});
