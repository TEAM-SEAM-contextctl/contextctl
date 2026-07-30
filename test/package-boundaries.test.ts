import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

interface PackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

interface Workspace {
  readonly name: string;
  readonly root: string;
  readonly kind: "app" | "contracts" | "domain";
}

interface WorkspaceImport {
  readonly workspace: Workspace;
  readonly internal: boolean;
}

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const workspaces: readonly Workspace[] = [
  {
    name: "@contextctl/daemon",
    root: resolve(repositoryRoot, "apps/contextctl-daemon"),
    kind: "app",
  },
  {
    name: "@contextctl/contracts",
    root: resolve(repositoryRoot, "packages/contracts"),
    kind: "contracts",
  },
  {
    name: "@contextctl/ingestion-indexing",
    root: resolve(repositoryRoot, "packages/ingestion-indexing"),
    kind: "domain",
  },
  {
    name: "@contextctl/registry-lifecycle",
    root: resolve(repositoryRoot, "packages/registry-lifecycle"),
    kind: "domain",
  },
  {
    name: "@contextctl/selection-delivery",
    root: resolve(repositoryRoot, "packages/selection-delivery"),
    kind: "domain",
  },
];
describe("Workspace package boundaries", () => {
  it.each(workspaces)(
    "$name declares only allowed Workspace dependencies",
    async (workspace) => {
      const manifest = JSON.parse(
        await readFile(resolve(workspace.root, "package.json"), "utf8"),
      ) as PackageManifest;
      const dependencyNames = new Set(
        [
          manifest.dependencies,
          manifest.devDependencies,
          manifest.optionalDependencies,
          manifest.peerDependencies,
        ].flatMap((dependencies) => Object.keys(dependencies ?? {})),
      );

      expect(
        workspaces
          .filter((candidate) => candidate.name !== workspace.name)
          .map((candidate) => candidate.name)
          .filter((name) => {
            const target = workspaces.find(
              (candidate) => candidate.name === name,
            );
            return (
              dependencyNames.has(name) &&
              target !== undefined &&
              !isAllowedWorkspaceDependency(workspace, target)
            );
          }),
      ).toEqual([]);
    },
  );

  it.each(workspaces)(
    "$name imports other Workspaces only through allowed package roots",
    async (workspace) => {
      const violations: string[] = [];
      const sourceFiles = await listTypeScriptFiles(
        resolve(workspace.root, "src"),
      );

      for (const sourceFile of sourceFiles) {
        const sourceText = await readFile(sourceFile, "utf8");
        const syntaxTree = ts.createSourceFile(
          sourceFile,
          sourceText,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TS,
        );

        for (const specifier of collectModuleSpecifiers(syntaxTree)) {
          const target = resolveWorkspaceImport(sourceFile, specifier);
          if (
            target !== undefined &&
            target.workspace.name !== workspace.name &&
            (target.internal ||
              !isAllowedWorkspaceDependency(workspace, target.workspace))
          ) {
            violations.push(
              `${relative(repositoryRoot, sourceFile)} -> ${specifier}`,
            );
          }
        }
      }

      expect(violations).toEqual([]);
    },
  );

  it("recognizes package subpaths and relative cross-Workspace imports as internal", () => {
    const sourceFile = resolve(
      repositoryRoot,
      "packages/ingestion-indexing/src/example.ts",
    );

    expect(
      resolveWorkspaceImport(
        sourceFile,
        "@contextctl/contracts/src/identifiers.js",
      ),
    ).toMatchObject({
      workspace: { name: "@contextctl/contracts" },
      internal: true,
    });
    expect(
      resolveWorkspaceImport(
        sourceFile,
        "../../contracts",
      ),
    ).toMatchObject({
      workspace: { name: "@contextctl/contracts" },
      internal: true,
    });
    expect(
      resolveWorkspaceImport(sourceFile, "@contextctl/contracts"),
    ).toMatchObject({
      workspace: { name: "@contextctl/contracts" },
      internal: false,
    });
  });

  it("enforces the Composition Root dependency direction", () => {
    const daemon = getWorkspace("@contextctl/daemon");
    const contracts = getWorkspace("@contextctl/contracts");
    const ingestion = getWorkspace("@contextctl/ingestion-indexing");
    const registry = getWorkspace("@contextctl/registry-lifecycle");

    expect(isAllowedWorkspaceDependency(daemon, ingestion)).toBe(true);
    expect(isAllowedWorkspaceDependency(ingestion, contracts)).toBe(true);
    expect(isAllowedWorkspaceDependency(ingestion, registry)).toBe(false);
    expect(isAllowedWorkspaceDependency(ingestion, daemon)).toBe(false);
    expect(isAllowedWorkspaceDependency(contracts, ingestion)).toBe(false);
  });
});

async function listTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        return listTypeScriptFiles(path);
      }
      return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
    }),
  );
  return files.flat().sort();
}

function collectModuleSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = [];

  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      specifiers.push(node.argument.literal.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const argument = node.arguments[0];
      if (
        node.arguments.length === 1 &&
        argument !== undefined &&
        ts.isStringLiteral(argument)
      ) {
        specifiers.push(argument.text);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}

function resolveWorkspaceImport(
  sourceFile: string,
  specifier: string,
): WorkspaceImport | undefined {
  const packageImport = workspaces.find(
    (candidate) =>
      specifier === candidate.name || specifier.startsWith(`${candidate.name}/`),
  );
  if (packageImport !== undefined) {
    return {
      workspace: packageImport,
      internal: specifier !== packageImport.name,
    };
  }
  if (!specifier.startsWith(".")) {
    return undefined;
  }

  const resolvedImport = resolve(dirname(sourceFile), specifier);
  const workspace = workspaces.find((candidate) => {
    return (
      resolvedImport === candidate.root ||
      resolvedImport.startsWith(`${candidate.root}${sep}`)
    );
  });
  return workspace === undefined ? undefined : { workspace, internal: true };
}

function isAllowedWorkspaceDependency(
  source: Workspace,
  target: Workspace,
): boolean {
  if (source.name === target.name || source.kind === "app") {
    return true;
  }
  return target.kind === "contracts";
}

function getWorkspace(name: string): Workspace {
  const workspace = workspaces.find((candidate) => candidate.name === name);
  if (workspace === undefined) {
    throw new Error(`unknown test Workspace: ${name}`);
  }
  return workspace;
}
