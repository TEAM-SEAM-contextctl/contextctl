# @contextctl/registry-lifecycle

Context Card generation, approval, lineage, versioning, and lifecycle management for Contextctl.

This is an advanced building block from the
[Contextctl monorepo](https://github.com/TEAM-SEAM-contextctl/contextctl). Most
users should install `@contextctl/daemon`, which provides the complete command
line, durable stores, publication consumer, and runtime assembly.

If you import Contextctl packages directly, pin every `@contextctl/*` package in
the process to the same exact version. Mixed release lines are unsupported.

The supported public API is the package-root ESM export and the TypeScript
declarations shipped with the package. Internal persistence models are not
public contracts. The package consumes versioned ingestion publications; it
does not observe sources or publish vectors.

Design rationale is recorded in the package
[ADRs](https://github.com/TEAM-SEAM-contextctl/contextctl/tree/main/packages/registry-lifecycle/docs/adr).
Report bugs through [GitHub Issues](https://github.com/TEAM-SEAM-contextctl/contextctl/issues)
and security vulnerabilities through [SECURITY.md](https://github.com/TEAM-SEAM-contextctl/contextctl/blob/main/SECURITY.md).
