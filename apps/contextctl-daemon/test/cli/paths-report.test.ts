import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildPathsReport,
  formatBytes,
  renderPathsReport,
} from "../../src/cli/paths-report.js";

/**
 * The report an operator reads before deleting anything.
 *
 * Its correctness is not cosmetic: the command exists because four separate
 * things get written during a normal install — state, a 396MiB model, a Qdrant
 * collection and a `bin` under one Node version — and nothing else lists them
 * together. A path missing here is a file left behind on a machine someone
 * believed they had cleaned.
 */

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function emptyHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "contextctl-paths-"));
  directories.push(home);
  return home;
}

function allValues(report: Awaited<ReturnType<typeof buildPathsReport>>): string {
  return report.groups
    .flatMap((group) => group.entries.map((entry) => `${entry.label} ${entry.value}`))
    .join("\n");
}

describe("paths report", () => {
  it("names every state file individually, not just the directory", async () => {
    const home = await emptyHome();

    const report = await buildPathsReport({ environment: { CONTEXTCTL_HOME: home } });
    const values = allValues(report);

    // Individually, because "delete the state directory" is the instruction an
    // operator follows when they wanted to keep their approved Cards and only
    // reset ingestion.
    expect(values).toContain(join(home, "sources.json"));
    expect(values).toContain(join(home, "registry.db"));
    expect(values).toContain(join(home, "ingestion.db"));
    expect(values).toContain(join(home, "runtime-activity"));
  });

  it("survives a home where nothing has been created", async () => {
    const home = await emptyHome();

    const report = await buildPathsReport({ environment: { CONTEXTCTL_HOME: home } });

    // This is often the first command an operator runs. Reporting absence is
    // the answer; throwing would make "where is my state" unanswerable exactly
    // when it is being asked.
    const kinds = report.groups.flatMap((group) =>
      group.entries.map((entry) => entry.kind),
    );
    expect(kinds).toContain("absent");
    expect(renderPathsReport(report).length).toBeGreaterThan(0);
  });

  it("reports the resolved revision directory, never the managed root alone", async () => {
    const home = await emptyHome();
    const digest = "eb0923125496145fce8105135180b42f37d098c688837037d73e4ba11bd8c389";
    const revision = join(home, "embedding-assets", "revisions", digest);
    await mkdir(revision, { recursive: true });
    await writeFile(
      join(home, "embedding-assets", "active.json"),
      JSON.stringify({
        schemaVersion: 1,
        manifestSha256: digest,
        revisionDirectory: join("revisions", digest),
      }),
      "utf8",
    );

    const report = await buildPathsReport({ environment: { CONTEXTCTL_HOME: home } });
    const values = allValues(report);

    // Through the shared resolver. The composition and the diagnosis disagreed
    // once about which directory held the assets; a third assembler here would
    // print a path that is right for neither.
    expect(values).toContain(revision);
  });

  it("reports bytes actually installed instead of a compiled-in estimate", async () => {
    const home = await emptyHome();
    const digest = "test-revision";
    const revision = join(home, "embedding-assets", "revisions", digest);
    await mkdir(join(revision, "nested"), { recursive: true });
    await writeFile(join(revision, "model.onnx"), Buffer.alloc(17), "utf8");
    await writeFile(join(revision, "nested", "tokenizer.json"), Buffer.alloc(29), "utf8");
    await writeFile(
      join(home, "embedding-assets", "active.json"),
      JSON.stringify({
        schemaVersion: 1,
        manifestSha256: digest,
        revisionDirectory: join("revisions", digest),
      }),
      "utf8",
    );

    const report = await buildPathsReport({ environment: { CONTEXTCTL_HOME: home } });
    const revisionEntry = report.groups
      .flatMap((group) => group.entries)
      .find((entry) => entry.label === "현재 revision");

    expect(revisionEntry).toMatchObject({ kind: "present", bytes: 46 });
    expect(revisionEntry?.note).toContain("실제 설치 용량");
  });

  it("does not misreport an unreadable pointer target as absent", async () => {
    const home = await emptyHome();
    const digest = "not-a-directory";
    const revision = join(home, "embedding-assets", "revisions", digest);
    await mkdir(join(home, "embedding-assets", "revisions"), { recursive: true });
    await writeFile(revision, "this is a file", "utf8");
    await writeFile(
      join(home, "embedding-assets", "active.json"),
      JSON.stringify({
        schemaVersion: 1,
        manifestSha256: digest,
        revisionDirectory: join("revisions", digest),
      }),
      "utf8",
    );

    const report = await buildPathsReport({ environment: { CONTEXTCTL_HOME: home } });
    const revisionEntry = report.groups
      .flatMap((group) => group.entries)
      .find((entry) => entry.label === "현재 revision");

    expect(revisionEntry).toMatchObject({ kind: "unknown", value: revision });
    expect(revisionEntry?.note).toContain("읽을 수 없습니다");
  });

  it("says the model is absent rather than guessing a revision path", async () => {
    const home = await emptyHome();

    const report = await buildPathsReport({ environment: { CONTEXTCTL_HOME: home } });
    const revisionEntry = report.groups
      .flatMap((group) => group.entries)
      .find((entry) => entry.label === "현재 revision");

    expect(revisionEntry?.kind).toBe("absent");
  });

  it("distinguishes a configured Qdrant from none", async () => {
    const home = await emptyHome();

    const without = await buildPathsReport({ environment: { CONTEXTCTL_HOME: home } });
    const with_ = await buildPathsReport({
      environment: { CONTEXTCTL_HOME: home, CONTEXTCTL_QDRANT_URL: "http://localhost:6333" },
    });

    const entry = (report: typeof without) =>
      report.groups.flatMap((g) => g.entries).find((e) => e.label === "Qdrant");
    expect(entry(without)?.kind).toBe("absent");
    expect(entry(without)?.value).toContain("실행할 수 없습니다");
    expect(entry(without)?.note).toContain("시험 전용");
    expect(entry(without)?.value).not.toContain("메모리에만");
    expect(entry(with_)?.kind).toBe("present");
    expect(entry(with_)?.value).toContain("localhost:6333");
  });

  it("names the Node interpreter, which is what a version manager varies", async () => {
    const home = await emptyHome();

    const report = await buildPathsReport({ environment: { CONTEXTCTL_HOME: home } });
    const node = report.groups
      .flatMap((group) => group.entries)
      .find((entry) => entry.label === "Node");

    // The interpreter path, not the module's own directory: under fnm or nvm a
    // second install under another version is invisible unless the operator is
    // told which one they are looking at.
    expect(node?.value).toContain(process.execPath);
    expect(node?.note ?? "").toContain("fnm");
  });

  it("promises no deletion anywhere in its output", async () => {
    const home = await emptyHome();

    const rendered = renderPathsReport(
      await buildPathsReport({ environment: { CONTEXTCTL_HOME: home } }),
    );

    expect(rendered).toContain("아무것도 지우지 않습니다");
  });

  it("formats sizes without pretending to a precision it lacks", () => {
    expect(formatBytes(undefined)).toBe("—");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KiB");
    expect(formatBytes(415_321_225)).toBe("396.1 MiB");
  });
});
