# contextctl

Contextctl is a knowledge retrieval control plane for managing source ingestion,
context lifecycle, and retrieval scope selection.

> The project is in its initial development stage. Public APIs and runtime
> behavior are not stable yet.

## Requirements

- Node.js `24.18.0`
- npm `11.16.0`

## Quick start

The CLI (`contextctl`) takes a Markdown file from registration to an answered
query. Two things must exist before the first query, and neither is downloaded
for you.

### Prerequisites

**1. Embedding assets — about 390MB.** The daemon pins one artifact revision and
never downloads at runtime, so the install is an explicit step:

```bash
node apps/contextctl-daemon/scripts/install-embedding-assets.mjs
```

They land in `~/.contextctl/embedding-assets` unless
`CONTEXTCTL_EMBEDDING_ASSET_DIRECTORY` says otherwise. Without them the daemon
refuses to assemble rather than silently producing vectors of another kind.

**2. A vector index that outlives one process.** Each CLI command is its own
process, so the default in-memory index is empty again by the time you query.
Start Qdrant and point the CLI at it:

```bash
docker run -p 6333:6333 qdrant/qdrant
export CONTEXTCTL_QDRANT_URL=http://localhost:6333
```

Skipping this is allowed — `contextctl serve` keeps one process alive, and the
CLI warns on `ingest` and diagnoses on `query` rather than answering with a
silent empty result.

### Install and build

```bash
npm ci
npm run build          # bin lands at node_modules/.bin/contextctl
export PATH="$PWD/node_modules/.bin:$PATH"
```

### From a document to an answer

```bash
contextctl source add apps/contextctl-daemon/demo/docs/payment.md
contextctl source add apps/contextctl-daemon/demo/docs/shipping.md
contextctl source add apps/contextctl-daemon/demo/docs/leave.md
contextctl source list

contextctl ingest              # publish every registered Source, then claim it
contextctl cards list          # what each Card means, and what awaits approval
contextctl cards approve <cardId>
contextctl query "결제가 실패하면 몇 번까지 재시도하나요"
```

`cards approve` records the operating system account as the deciding operator
unless `--by` names someone else; approval is a decision and the audit trail
says who made it. Nothing reaches service because a document arrived.

### Card text from a model

The built-in meaning generator describes a Card from its coordinates and fact
names alone, which is honest but gives a query little to match on. Point the CLI
at any OpenAI-compatible endpoint and Card descriptions, questions, aliases and
keywords come from a model instead, with the deterministic generator kept as the
fallback so an outage degrades the text rather than stopping ingestion:

```bash
export CONTEXTCTL_CARD_MEANING_BASE_URL=https://your-endpoint
export CONTEXTCTL_CARD_MEANING_MODEL=your-model
export CONTEXTCTL_CARD_MEANING_API_KEY=...
```

All three are required together; with any of them missing the CLI says which one
and stays deterministic. Every fallback is reported on stderr, so a model that
has been unreachable for a week cannot look like a model that writes tersely.

### Configuration

| Variable | Default |
|---|---|
| `CONTEXTCTL_HOME` | `~/.contextctl` |
| `CONTEXTCTL_SOURCES_FILE` | `$CONTEXTCTL_HOME/sources.json` |
| `CONTEXTCTL_REGISTRY_DATABASE` | `$CONTEXTCTL_HOME/registry.db` |
| `CONTEXTCTL_INGESTION_DATABASE` | `$CONTEXTCTL_HOME/ingestion.db` |
| `CONTEXTCTL_EMBEDDING_ASSET_DIRECTORY` | `$CONTEXTCTL_HOME/embedding-assets` |
| `CONTEXTCTL_QDRANT_URL` | unset — in-memory vector index |
| `CONTEXTCTL_QDRANT_API_KEY` | unset |
| `CONTEXTCTL_HTTP_PORT` | unset — `serve` opens MCP stdio only |

`contextctl serve` starts the same composition as an MCP stdio server, adding an
HTTP query surface when `CONTEXTCTL_HTTP_PORT` is set. Its stdout carries
JSON-RPC and nothing else.

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
