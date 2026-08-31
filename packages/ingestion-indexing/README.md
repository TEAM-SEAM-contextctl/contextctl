# @contextctl/ingestion-indexing

Source ingestion, document indexing, and managed document retrieval for Contextctl.

This is an advanced building block from the
[Contextctl monorepo](https://github.com/TEAM-SEAM-contextctl/contextctl). Most
users should install `@contextctl/daemon`, which provides the complete command
line, durable stores, Qdrant binding, embedding providers, and runtime assembly.

If you import Contextctl packages directly, pin every `@contextctl/*` package in
the process to the same exact version. Mixed release lines are unsupported.

The supported public API is the package-root ESM export and the TypeScript
declarations shipped with the package. Internal source paths and physical index
bindings are not public contracts. Provider adapters require explicit profile
and persistence configuration; there is no automatic in-memory production
fallback.

Design rationale is recorded in the package
[ADRs](https://github.com/TEAM-SEAM-contextctl/contextctl/tree/main/packages/ingestion-indexing/docs/adr).
Report bugs through [GitHub Issues](https://github.com/TEAM-SEAM-contextctl/contextctl/issues)
and security vulnerabilities through [SECURITY.md](https://github.com/TEAM-SEAM-contextctl/contextctl/blob/main/SECURITY.md).
