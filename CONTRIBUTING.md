# Contributing

Thank you for contributing to Contextctl.

## Setup

```bash
npm ci
npm run typecheck
npm run build
npm test
npm run test:operational
```

`test:operational` re-checks the release-critical regressions in one command:
embedding and Qdrant call limits and retries, last-known-good index preservation,
publication recovery intent, Registry delay isolation, credential non-exposure,
and the rule that external document text is never read as instruction.

Tests that need a real Qdrant or the real Granite artifact are kept out of
`npm test`, because a suite that cannot run without a 396 MiB download and a
running server is a suite that stops being run. They are
`test:integration:qdrant` and `test:integration:granite`.

Development pins Node **24.18.0** and npm **11.16.0** exactly — `.nvmrc` and CI
say so. The published packages declare only a floor (`>=24.0.0`): the exact pin
exists to make a build reproducible, not to make it usable.

## Workspaces

| Workspace | Responsibility |
|---|---|
| `apps/contextctl-daemon` | Runtime entry point, dependency assembly, CLI |
| `packages/contracts` | Types and schemas that cross a package boundary |
| `packages/ingestion-indexing` | Document capture, semantic units, chunks, index |
| `packages/registry-lifecycle` | Context Cards, lineage, versions, lifecycle |
| `packages/selection-delivery` | Retrieval scope selection and delivery surfaces |

Each package exposes its public API through `src/index.ts` only. Packages never
import each other's internal paths. When a real cross-package import is
introduced, add the workspace dependency and the TypeScript project reference in
the same change.

Domain packages do not depend on each other at all. Values that cross a boundary
travel through `@contextctl/contracts`, and the daemon is the only place that
knows about more than one domain.

## Language

One rule decides it:

> **A document is written in the language of the output it quotes.**

| | Language |
|---|---|
| `README.md` | English — the front door, and it quotes almost no output |
| `README.ko.md` | Korean, kept short and linked from the English one |
| `docs/*.md` | Korean — the reference quotes CLI output extensively |
| `packages/*/docs/adr/*.md` | Korean — internal decision records |
| Code, comments, commit messages | English |
| CLI messages | Korean today; locale support is planned, not implemented |

**The two READMEs are the only mirrored pair.** Do not add a second language to
`docs/` — four files would become eight, and one side would be updated without
the other.

If you change a user-facing CLI message, remember that some tests assert those
strings. Moving messages into one place is the prerequisite for translating them
at all, and that work has not been done yet.

## Scope

- Keep one logical change per branch and pull request.
- Do not import another workspace's internal files.
- Add cross-workspace dependencies to both `package.json` and the consuming
  package's TypeScript project references.
- Update tests and documentation when behavior or a public contract changes.
- Never commit credentials, connection strings, or real customer data.

## Branches and commits

Create a short-lived branch from the latest `main`.

```text
feat/short-description
fix/short-description
refactor/short-description
test/short-description
docs/short-description
chore/short-description
```

Use focused commit messages.

```text
<type>(<scope>): <summary>
```

## Pull requests

Before requesting review:

1. Run the full verification commands.
2. Describe the problem, change, verification, and affected contracts.
3. Remove unrelated changes and temporary commits.
4. Confirm that no secrets or private data are included.

Pull requests require review and must pass CI before merge.
