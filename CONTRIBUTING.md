# Contributing

Thank you for contributing to Contextctl.

## Setup

Use Node.js 24 LTS.

```bash
npm ci
npm run typecheck
npm run build
npm test
```

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
