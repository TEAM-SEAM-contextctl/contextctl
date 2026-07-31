# contextctl

Contextctl is a knowledge retrieval control plane for managing source ingestion,
context lifecycle, and retrieval scope selection.

> The project is in its initial development stage. Public APIs and runtime
> behavior are not stable yet.

## Requirements

- Node.js `24.18.0`
- npm `11.16.0`

## Development

```bash
npm ci
npm run typecheck
npm run build
npm test
```

## Workspace

| Workspace | Responsibility |
|---|---|
| `apps/contextctl-daemon` | Runtime entrypoint and dependency composition |
| `packages/contracts` | Types and schemas shared across package boundaries |
| `packages/ingestion-indexing` | Knowledge capture, semantic units, chunks, and indexing |
| `packages/registry-lifecycle` | Context cards, lineage, versions, and lifecycle |
| `packages/selection-delivery` | Retrieval scope selection and delivery surfaces |

Each package exposes its public API through `src/index.ts`. Packages must not
import another package's internal paths.

Add a workspace dependency and its TypeScript project reference together in
the same change when a real cross-package import is introduced.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## License

MIT
