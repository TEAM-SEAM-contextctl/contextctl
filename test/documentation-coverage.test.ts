import { readdirSync, readFileSync } from "node:fs";
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
 * between the public documents break whenever a heading is renamed, and
 * nothing in a TypeScript build looks at Markdown.
 */
describe("documentation coverage", () => {
  const commands = [
    "install-assets",
    "demo init",
    "paths",
    "doctor",
    "source add",
    "source list",
    "source remove",
    "ingest",
    "cards list",
    "cards show",
    "cards approve",
    "cards reject",
    "cards disable",
    "cards rollback",
    "reachability",
    "status",
    "backup create",
    "backup restore",
    "query",
    "serve",
    "help",
    "--version",
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

  it("keeps security and conduct reporting discoverable", () => {
    for (const path of ["README.md", "README.ko.md", "CONTRIBUTING.md"]) {
      const body = read(path);
      expect(body, `${path} should link to the security policy`).toContain(
        "(SECURITY.md)",
      );
      expect(body, `${path} should link to the code of conduct`).toContain(
        "(CODE_OF_CONDUCT.md)",
      );
    }

    expect(read("SECURITY.md")).toContain(
      "contextctl/security/advisories/new",
    );
    expect(read("CODE_OF_CONDUCT.md")).toContain(
      "contextctl/security/advisories/new",
    );
  });

  it("keeps public npm publishing credential-free", () => {
    const contributing = read("CONTRIBUTING.md");
    const workflow = read(".github/workflows/publish-npm-candidate.yml");

    for (const body of [contributing, workflow]) {
      expect(body).not.toContain("NPM_BOOTSTRAP_TOKEN");
      expect(body).not.toContain("NODE_AUTH_TOKEN:");
    }
    expect(contributing).toContain("GitHub OIDC");
    expect(workflow).toContain("id-token: write");
  });

  it("gives npm package pages a usable support boundary", () => {
    const daemon = read("apps/contextctl-daemon/README.md");
    expect(daemon).toContain("npm install -g @contextctl/daemon");
    expect(daemon).toContain("Node.js `>=24.18.0 <25`");
    expect(daemon).toContain("Qdrant is required");

    for (const path of [
      "packages/contracts/README.md",
      "packages/ingestion-indexing/README.md",
      "packages/registry-lifecycle/README.md",
      "packages/selection-delivery/README.md",
    ]) {
      const body = read(path);
      expect(body, `${path} should state integrated-version compatibility`).toContain(
        "same exact version",
      );
      expect(body, `${path} should state its public API boundary`).toContain(
        "package-root ESM export",
      );
      expect(body, `${path} should link private security reporting`).toContain(
        "SECURITY.md",
      );
    }
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

  it("states the released Source support without claiming deferred adapters", () => {
    expect(read("README.md")).toContain(
      "their capture adapters are not included in this release",
    );
    expect(read("README.ko.md")).toContain(
      "해당 수집 어댑터는 이 릴리스에 포함하지 않습니다",
    );
    expect(read("docs/architecture.md")).toContain("Source (markdown)");
    expect(read("docs/cli.md")).toContain("Markdown 문서 파일 하나");
    expect(usageText()).toContain("Markdown 문서 파일 하나");
    expect(usageText()).not.toContain("문서 파일이나 디렉터리");
  });

  it("distinguishes a complete state backup from source content and destructive rebuild", () => {
    const cli = read("docs/cli.md");
    const operations = read("docs/operations.md");

    expect(cli.replaceAll(/\s+/gu, " ")).toContain(
      "원본 Markdown 파일은 포함하지 않습니다",
    );
    expect(operations).toContain("색인이 비었을 때: 파괴적 최후 수단");
    expect(operations).toContain("정상 복구 경로");
    expect(operations).toContain("새 Source·문서·Scope·Card를 만드는 파괴적");
  });

  it("does not render duplicate thematic breaks", () => {
    for (const path of [
      "README.md",
      "README.ko.md",
      "docs/architecture.md",
      "docs/benchmark.md",
      "docs/cli.md",
      "docs/configuration.md",
      "docs/operations.md",
    ]) {
      expect(read(path), `${path} contains consecutive thematic breaks`)
        .not.toMatch(/^---\n\n---$/mu);
    }
  });

  it("lists every document in the docs index", () => {
    // `docs/README.md` is what GitHub renders when someone opens the folder, so
    // a document missing from it is a document nobody browsing finds. Read from
    // the directory rather than a list here: a hard-coded list would need the
    // same edit the index does, which is the edit being forgotten.
    const index = read("docs/README.md");
    const documents = readdirSync(resolve(repositoryRoot, "docs"))
      .filter((entry) => entry.endsWith(".md") && entry !== "README.md");

    expect(documents.length).toBeGreaterThan(0);
    for (const document of documents) {
      expect(index, `docs/${document} is missing from docs/README.md`).toContain(
        `(${document})`,
      );
    }
  });

  it("resolves every relative link between the documents", () => {
    const documents = [
      "README.md",
      "README.ko.md",
      "SECURITY.md",
      "CODE_OF_CONDUCT.md",
      "CONTRIBUTING.md",
      "docs/README.md",
      "docs/architecture.md",
      "docs/benchmark.md",
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
