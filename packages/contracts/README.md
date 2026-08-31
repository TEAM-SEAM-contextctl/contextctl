# @contextctl/contracts

Versioned lifecycle contracts shared across Contextctl package boundaries.

This is an advanced building block from the
[Contextctl monorepo](https://github.com/TEAM-SEAM-contextctl/contextctl). Most
users should install `@contextctl/daemon`, which provides the complete product
and installs this package as an exact-version dependency.

If you import Contextctl packages directly, pin every `@contextctl/*` package in
the process to the same exact version. Mixed release lines are unsupported.

The supported public API is the package-root ESM export and the TypeScript
declarations shipped with the package. Internal source paths are not part of the
compatibility contract. This package contains serializable lifecycle contracts;
process-local application DTOs remain in their owning domain packages.

Report bugs through [GitHub Issues](https://github.com/TEAM-SEAM-contextctl/contextctl/issues)
and security vulnerabilities through [SECURITY.md](https://github.com/TEAM-SEAM-contextctl/contextctl/blob/main/SECURITY.md).
