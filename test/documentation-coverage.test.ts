import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { usageText } from "../apps/contextctl-daemon/src/cli/arguments.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath: string): string {
  return readFileSync(resolve(repositoryRoot, relativePath), "utf8");
}

/**
 * The documents were split so the README could answer "what is this" in one
 * screen, which means the reference material now lives somewhere a reader has to
 * be sent to. Two things go stale in that arrangement, and both are cheap to
 * catch here.
 *
 * A new command reaching the CLI and never reaching the reference is the first.
 * The command surface is generated from one table in `arguments.ts`, so adding a
 * command changes `--help` and nothing else — the docs stay quiet and correct
 * until someone notices. Reading the real usage text rather than a copy of the
 * command list is the point: a hard-coded list here would be the second copy
 * this test exists to prevent.
 *
 * A cross-document link pointing at nothing is the second. Relative links
 * between four files break whenever a heading is renamed, and nothing in a
 * TypeScript build looks at Markdown.
 */
describe("documentation coverage", () => {
  const commands = [
    "install-assets",
    "paths",
    "doctor",
    "source add",
    "source list",
    "source remove",
    "ingest",
    "cards list",
    "cards approve",
    "cards reject",
    "cards disable",
    "cards rollback",
    "reachability",
    "status",
    "query",
    "serve",
  ] as const;

  it("documents every command the CLI advertises", () => {
    const usage = usageText();
    const reference = read("docs/cli.md");

    for (const command of commands) {
      // Matched with a boundary rather than as a substring. `toContain` would
      // accept `contextctl status-renamed` as proof that `status` is documented,
      // which is exactly the rename this test is supposed to catch.
      const mention = new RegExp(
        `contextctl ${command.replaceAll(" ", "\\s")}(?![\\p{L}\\p{N}_-])`,
        "u",
      );

      // Asserted against the CLI's own usage text first, so a command removed
      // from the CLI does not silently keep this list — and the docs — alive.
      expect(usage, `${command} is missing from the CLI usage text`).toMatch(
        mention,
      );
      expect(reference, `${command} is missing from docs/cli.md`).toMatch(
        mention,
      );
    }
  });

  it("keeps the exit codes in exactly one prose table", () => {
    // The codes are a contract with whatever runs `contextctl`. Two prose copies
    // would disagree eventually, and the one a reader found first would be the
    // one they trusted.
    const reference = read("docs/cli.md");
    const others = [
      "README.md",
      "README.ko.md",
      "docs/configuration.md",
      "docs/operations.md",
    ];

    expect(reference).toContain("## 종료 코드");
    for (const path of others) {
      const body = read(path);
      expect(body, `${path} should link to the exit codes, not repeat them`)
        .not.toContain("## 종료 코드");
      // The English README would spell the same duplication differently.
      expect(body, `${path} should link to the exit codes, not repeat them`)
        .not.toMatch(/^#{2,3} Exit codes$/mu);
    }
  });

  /**
   * The two READMEs are the one mirrored pair in the repository, so they are the
   * one place a reader can be told two different things. Only their shape is
   * asserted — a translation check belongs to a person, but a missing language
   * link, a lost section, or one side quietly growing into a manual again is
   * mechanical.
   */
  it("keeps the two READMEs pointing at each other", () => {
    expect(read("README.md")).toContain("(README.ko.md)");
    expect(read("README.ko.md")).toContain("(README.md)");
  });

  it("keeps both READMEs short enough to read in one sitting", () => {
    // The split exists because a 497-line README buried the introduction. A
    // number here is arbitrary; a number that fails when the manual creeps back
    // in is the point.
    for (const path of ["README.md", "README.ko.md"]) {
      const lines = read(path).split("\n").length;
      expect(lines, `${path} is ${lines} lines — the reference belongs in docs/`)
        .toBeLessThan(220);
    }
  });

  it("resolves every relative link between the documents", () => {
    const documents = [
      "README.md",
      "README.ko.md",
      "docs/cli.md",
      "docs/configuration.md",
      "docs/operations.md",
    ];

    for (const path of documents) {
      const body = read(path);
      for (const match of body.matchAll(/\]\((?!https?:)([^)]+)\)/gu)) {
        const [rawFile, anchor] = (match[1] ?? "").split("#");
        // An in-page link (`#heading`) has an empty file part, and a link with
        // no anchor has none at all. Both are legal and neither is a lookup of
        // another file.
        const file = rawFile ?? "";
        const from =
          file === ""
            ? resolve(repositoryRoot, path)
            : resolve(dirname(resolve(repositoryRoot, path)), file);
        // A missing file throws, which is the assertion: `readFileSync` failing
        // names the path, and that is more useful than a boolean.
        const targetBody = readFileSync(from, "utf8");
        if (anchor !== undefined && anchor !== "") {
          expect(
            headings(targetBody),
            `${path} links to #${anchor}, which ${file === "" ? path : file} does not have`,
          ).toContain(anchor);
        }
      }
    }
  });
});

/**
 * GitHub's anchor form: lowercased, spaces to hyphens, punctuation dropped.
 *
 * Reimplemented rather than depended on, because the only alternative is to add
 * a Markdown toolchain to a repository that has none — and the subset used here
 * is small enough to be checked by eye when a heading is written.
 */
function headings(markdown: string): readonly string[] {
  return [...markdown.matchAll(/^#{1,6} (.+)$/gmu)].map(([, title]) =>
    (title ?? "")
      .trim()
      .toLowerCase()
      .replaceAll(/[`*]/gu, "")
      .replaceAll(/[^\p{L}\p{N}\s-]/gu, "")
      .replaceAll(/\s/gu, "-"),
  );
}
