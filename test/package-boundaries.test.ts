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

interface DomainPackage {
  readonly name: string;
  readonly root: string;
}

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const domainPackages: readonly DomainPackage[] = [
  {
    name: "@contextctl/ingestion-indexing",
    root: resolve(repositoryRoot, "packages/ingestion-indexing"),
  },
  {
    name: "@contextctl/registry-lifecycle",
    root: resolve(repositoryRoot, "packages/registry-lifecycle"),
  },
  {
    name: "@contextctl/selection-delivery",
    root: resolve(repositoryRoot, "packages/selection-delivery"),
  },
];

describe("domain package boundaries", () => {
  it.each(domainPackages)(
    "$name does not declare another domain package as a dependency",
    async (domainPackage) => {
      const manifest = JSON.parse(
        await readFile(resolve(domainPackage.root, "package.json"), "utf8"),
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
        domainPackages
          .filter((candidate) => candidate.name !== domainPackage.name)
          .map((candidate) => candidate.name)
          .filter((name) => dependencyNames.has(name)),
      ).toEqual([]);
    },
  );

  it.each(domainPackages)(
    "$name source does not import another domain package",
    async (domainPackage) => {
      const violations: string[] = [];
      const sourceFiles = await listTypeScriptFiles(
        resolve(domainPackage.root, "src"),
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
          const target = resolveDomainImport(sourceFile, specifier);
          if (target !== undefined && target.name !== domainPackage.name) {
            violations.push(
              `${relative(repositoryRoot, sourceFile)} -> ${specifier}`,
            );
          }
        }
      }

      expect(violations).toEqual([]);
    },
  );
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

function resolveDomainImport(
  sourceFile: string,
  specifier: string,
): DomainPackage | undefined {
  const packageImport = domainPackages.find(
    (candidate) =>
      specifier === candidate.name || specifier.startsWith(`${candidate.name}/`),
  );
  if (packageImport !== undefined) {
    return packageImport;
  }
  if (!specifier.startsWith(".")) {
    return undefined;
  }

  const resolvedImport = resolve(dirname(sourceFile), specifier);
  return domainPackages.find((candidate) => {
    const sourceRoot = resolve(candidate.root, "src");
    return (
      resolvedImport === sourceRoot ||
      resolvedImport.startsWith(`${sourceRoot}${sep}`)
    );
  });
}
