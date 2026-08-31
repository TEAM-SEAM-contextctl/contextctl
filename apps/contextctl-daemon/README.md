# @contextctl/daemon

The installable `contextctl` command, MCP server, optional loopback HTTP
adapter, and runtime composition for Contextctl.

## Install

```bash
npm install -g @contextctl/daemon
contextctl --version
contextctl --help
```

Runtime support is Node.js `>=24.18.0 <25`. Qdrant is required for `ingest`,
`query`, and `serve`; the default local embedding model is installed separately
with explicit consent.

The [Contextctl README](https://github.com/TEAM-SEAM-contextctl/contextctl#readme)
contains the five-minute walkthrough. Configuration, backup and restore,
resource limits, remote embedding providers, and MCP registration are covered
in the linked reference documents. CLI commands and flags are English; current
CLI messages and the detailed reference are Korean.

This package installs the other four `@contextctl/*` workspaces at the same exact
integrated version. Do not mix Contextctl package versions in one installation.

Report bugs through [GitHub Issues](https://github.com/TEAM-SEAM-contextctl/contextctl/issues)
and security vulnerabilities through the repository's
[private reporting process](https://github.com/TEAM-SEAM-contextctl/contextctl/blob/main/SECURITY.md).
