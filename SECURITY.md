# Security Policy

## Supported versions

Security fixes are prepared for the latest published Contextctl release. Older
GitHub Release assets and npm versions remain immutable and do not receive
in-place fixes; upgrade to the latest integrated version after a security release.

| Version | Security support |
|---|---|
| Latest npm `latest` and matching GitHub Release | Supported |
| Older releases | No guaranteed fixes |

The five `@contextctl/*` packages form one integrated release. Do not mix their
versions when evaluating or applying a fix.

## Report a vulnerability privately

Do not open a public issue for a suspected vulnerability. Use GitHub's
[private vulnerability reporting form](https://github.com/TEAM-SEAM-contextctl/contextctl/security/advisories/new).

Include enough information to reproduce and assess the report:

- affected Contextctl package and exact version;
- operating system, architecture, Node.js version, and installation method;
- whether the issue requires Qdrant, a local model, or a remote provider;
- minimal reproduction steps and the expected security boundary;
- impact, required privileges, and whether the issue crosses a state namespace
  or security domain;
- logs or proof of concept with credentials, queries, retrieved text, and
  customer data removed.

Reports involving credential disclosure, unsafe archive or filesystem handling,
cross-domain data exposure, bypass of Card approval or sensitive-access policy,
MCP/HTTP boundary violations, and execution of retrieved text as instruction are
in scope. Ordinary search-quality disagreement without a security boundary
violation belongs in a public bug report.

Maintainers will confirm receipt, validate the affected versions, coordinate a
fix and disclosure with the reporter, and publish an advisory when appropriate.
Please avoid public disclosure until a fixed release and advisory are available.

## Operational security boundaries

- The optional HTTP surface is unauthenticated and restricted to numeric
  loopback addresses. Put authentication and TLS in a separate proxy if it must
  be reached across a network.
- Retrieved document text is untrusted data. Consumers must preserve and enforce
  the `contentTrust: untrusted` marker.
- API keys and provider credentials belong in runtime environment configuration,
  not Source files, Card facts, logs, issues, or test fixtures.
- Qdrant, backups, SQLite state, and model assets must be protected according to
  the data they contain and the host on which they run.

For non-security defects, use [GitHub Issues](https://github.com/TEAM-SEAM-contextctl/contextctl/issues).
