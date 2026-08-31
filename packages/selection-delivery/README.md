# @contextctl/selection-delivery

Context Card selection, retrieval-guide planning, and context delivery for Contextctl.

This is an advanced building block from the
[Contextctl monorepo](https://github.com/TEAM-SEAM-contextctl/contextctl). Most
users should install `@contextctl/daemon`, which provides the approved Card read
model, embedding provider, managed retrieval orchestration, and delivery
surfaces.

If you import Contextctl packages directly, pin every `@contextctl/*` package in
the process to the same exact version. Mixed release lines are unsupported.

The supported public API is the package-root ESM export and the TypeScript
declarations shipped with the package. Internal ranking and planning data are
not public wire contracts. Selection creates plans; the daemon executes managed
document retrieval before Delivery assembles the resolution.

Current decisions and their supersession history are summarized in the package
[decision record](https://github.com/TEAM-SEAM-contextctl/contextctl/blob/main/packages/selection-delivery/docs/decisions.md).
Report bugs through [GitHub Issues](https://github.com/TEAM-SEAM-contextctl/contextctl/issues)
and security vulnerabilities through [SECURITY.md](https://github.com/TEAM-SEAM-contextctl/contextctl/blob/main/SECURITY.md).
