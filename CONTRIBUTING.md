# Contributing

Thank you for contributing to Contextctl.

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). Report
security vulnerabilities through the private process in [SECURITY.md](SECURITY.md),
not through a public issue.

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
`npm test`, because a suite that cannot run without a 396.1 MiB download and a
running server is a suite that stops being run.

```bash
npm run test:integration:qdrant     # against a real Qdrant
npm run test:integration:granite    # against the real Granite assets
```

Release verification packs the five workspaces and installs them into an empty
prefix, which is the only path that exercises the published artefacts rather
than the working tree.

The repository root stays private. The five release workspaces are public scoped
packages and keep one integrated exact version. Publish them only after the
release commit has passed every required check; dependency order is contracts,
selection-delivery, registry-lifecycle, ingestion-indexing, then daemon. A
GitHub tag or release never substitutes for confirming the same version from the
public npm registry in an empty prefix.

| Script | Environment |
|---|---|
| `npm run test:release-package` | — |
| `npm run test:release-product` | `CONTEXTCTL_RELEASE_E2E_QDRANT_URL` (`…_QDRANT_API_KEY` if the server needs one) |
| `npm run test:release-product-local` | the two above plus `CONTEXTCTL_RELEASE_E2E_ASSET_ROOT` |

`npm run release:publish:plan` derives and prints the dependency DAG.
`npm run release:publish:dry-run` checks all five publication payloads in that
order without changing a Registry. Do not run `npm publish --workspaces`.

For an isolated Verdaccio on loopback, publish the candidate and verify a clean
daemon-only install with:

```bash
npm run release:publish:candidate -- \
  --target isolated --registry http://127.0.0.1:4873/ --yes
npm run release:verify:published -- \
  --target isolated --registry http://127.0.0.1:4873/
```

Public candidates are published only by the `Publish npm candidate` workflow.
It requires a clean `main` whose HEAD equals `origin/main`, an immutable
`v<version>` tag at that commit, the protected `npm` environment and npm Trusted
Publishing. The workflow repeats the release-critical Qdrant, Granite, quality,
consumer and installed-product gates before publishing with provenance.

All five published package names already trust this workflow. Keep candidate
publishing credential-free: the job receives short-lived npm authorization from
GitHub OIDC and must not read an npm token from repository or environment
secrets. A future package name that does not yet exist on npm needs a separate,
reviewed first-publication plan; do not turn that one-time bootstrap into a
fallback credential for the existing packages.

After the exact candidate passes its public install, audit, CLI, demo and native
load checks, an authenticated release operator promotes it locally. Promotion
is idempotent, advances dependencies in DAG order and advances daemon last:

```bash
npm run release:publish:promote -- --yes
```

Authenticate with npm's user configuration or a least-privilege automation
token. Never pass tokens or one-time passwords as command-line arguments.

If candidate publication stops after any package, never reuse that version.
Prepare a new integrated patch version instead; npm versions are immutable.

Development pins Node **24.18.0** and npm **11.16.0** exactly — `.nvmrc` and CI
say so. Published packages declare `>=24.18.0 <25`: patch and later 24.x releases
are accepted, while untested Node majors are refused until the release matrix
covers them.

The user quickstart pins Qdrant to the `v1.15.5` tag. CI pins that version to an
exact image digest, so reproduce a CI failure with the image in
`.github/workflows/ci.yml` rather than relying on the mutable tag.

## Workspaces

| Workspace | Responsibility |
|---|---|
| `apps/contextctl-daemon` | Runtime entry point, dependency assembly, CLI |
| `packages/contracts` | Versioned lifecycle types and schemas stored or transmitted independently across domain boundaries |
| `packages/ingestion-indexing` | Document capture, semantic units, chunks, index |
| `packages/registry-lifecycle` | Context Cards, lineage, versions, lifecycle |
| `packages/selection-delivery` | Retrieval scope selection and delivery surfaces |

Each package exposes its public API through `src/index.ts` only. Packages never
import each other's internal paths. When a real cross-package import is
introduced, add the workspace dependency and the TypeScript project reference in
the same change.

Domain packages do not depend on each other at all. Independently stored or
transmitted lifecycle values travel through `@contextctl/contracts`, and the
daemon is the only place that knows about more than one domain. Process-local
application DTOs — such as Selection plans, Indexing search commands and
results, and Delivery assembly inputs — stay with the package whose public API
defines them; the daemon translates them without promoting them into shared
lifecycle contracts.

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
| GitHub Release titles and notes | English — public distribution metadata |
| Team pull-request bodies | Korean; titles remain English |
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
