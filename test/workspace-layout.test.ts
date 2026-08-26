import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

interface PackageManifest {
  readonly name?: string;
  readonly private?: boolean;
  readonly type?: string;
  readonly packageManager?: string;
  readonly engines?: {
    readonly node?: string;
    readonly npm?: string;
  };
  readonly exports?: {
    readonly "."?: {
      readonly "contextctl-local-embedding-worker"?: string;
      readonly import?: string;
      readonly types?: string;
    };
  };
}

const workspaces = [
  [
    "../apps/contextctl-daemon/package.json",
    "@contextctl/daemon",
    "./dist/main.js",
  ],
  [
    "../packages/contracts/package.json",
    "@contextctl/contracts",
    "./dist/index.js",
  ],
  [
    "../packages/ingestion-indexing/package.json",
    "@contextctl/ingestion-indexing",
    "./dist/index.js",
  ],
  [
    "../packages/registry-lifecycle/package.json",
    "@contextctl/registry-lifecycle",
    "./dist/index.js",
  ],
  [
    "../packages/selection-delivery/package.json",
    "@contextctl/selection-delivery",
    "./dist/index.js",
  ],
] as const;

describe("workspace scaffold", () => {
  it("pins the agreed Node.js and npm runtime versions", async () => {
    const [nodeVersion, manifestText, lockfileText] = await Promise.all([
      readFile(new URL("../.nvmrc", import.meta.url), "utf8"),
      readFile(new URL("../package.json", import.meta.url), "utf8"),
      readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
    ]);
    const manifest = JSON.parse(manifestText) as PackageManifest;
    const lockfile = JSON.parse(lockfileText) as {
      readonly packages?: {
        readonly ""?: PackageManifest;
      };
    };

    expect(nodeVersion.trim()).toBe("24.18.0");
    expect(manifest.packageManager).toBe("npm@11.16.0");
    expect(manifest.engines).toEqual({
      node: "24.18.0",
      npm: "11.16.0",
    });
    expect(lockfile.packages?.[""]?.engines).toEqual(manifest.engines);
  });

  it("declares only the app and package workspace roots", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { readonly workspaces?: readonly string[] };

    expect(manifest.workspaces).toEqual(["apps/*", "packages/*"]);
  });

  it.each(workspaces)(
    "%s exposes one private ESM package boundary",
    async (path, name, entrypoint) => {
      const manifest = JSON.parse(
        await readFile(new URL(path, import.meta.url), "utf8"),
      ) as PackageManifest;

      expect(manifest).toMatchObject({
        name,
        private: true,
        type: "module",
      });
      expect(manifest.exports?.["."]?.import).toBe(entrypoint);
      expect(manifest.exports?.["."]?.types).toMatch(/\.\/dist\/.+\.d\.ts$/);
    },
  );

  it("keeps the local embedding Worker on the package root with a narrow runtime condition", async () => {
    const manifest = JSON.parse(
      await readFile(
        new URL("../packages/ingestion-indexing/package.json", import.meta.url),
        "utf8",
      ),
    ) as PackageManifest;

    expect(
      manifest.exports?.["."]?.["contextctl-local-embedding-worker"],
    ).toBe("./dist/infrastructure/local-embedding-worker-entry.js");
    expect(Object.keys(manifest.exports ?? {})).toEqual(["."]);
  });

  it("assigns shared and domain paths to their owner teams", async () => {
    const codeowners = await readFile(
      new URL("../.github/CODEOWNERS", import.meta.url),
      "utf8",
    );

    expect(codeowners.trimEnd().split("\n")).toEqual([
      "* @TEAM-SEAM-contextctl/contextctl-shared-owners",
      "",
      "/packages/ingestion-indexing/ @TEAM-SEAM-contextctl/contextctl-ingestion-owners",
      "/packages/registry-lifecycle/ @TEAM-SEAM-contextctl/contextctl-registry-owners",
      "/packages/selection-delivery/ @TEAM-SEAM-contextctl/contextctl-selection-owners",
      "/packages/contracts/ @TEAM-SEAM-contextctl/contextctl-shared-owners",
      "/apps/contextctl-daemon/ @TEAM-SEAM-contextctl/contextctl-shared-owners",
      "/.github/ @TEAM-SEAM-contextctl/contextctl-shared-owners",
    ]);
  });
});
