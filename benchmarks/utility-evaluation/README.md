# Contextctl utility evaluation

This benchmark compares the released Contextctl path with a strong Hybrid RAG
baseline under the same corpus, chunks, document vectors, document-query
embedding profile, final top-k, context budget, answer prompt, and answer model.

Contextctl is prepared through its public CLI:

```text
demo init -> source add -> ingest -> cards approve -> serve -> HTTP resolve
```

The baseline does not recreate or approximate the product corpus. It reads the
exact immutable chunk payloads and vectors that the run published to Qdrant,
then performs global BM25 plus Qdrant dense retrieval followed by RRF. Contextctl
performs hybrid Card selection and then Qdrant dense retrieval inside the selected
Scopes. This is a comparison of the complete retrieval strategies, not a
single-variable experiment that isolates only scope selection.

## Requirements

- Node.js 24.18.0 and npm 11.16.0
- a reachable Qdrant instance
- the Granite fp32 assets installed by `contextctl install-assets`
- a built repository, or an external `contextctl` 1.1.3 command

The benchmark creates a fresh Contextctl home and a unique state namespace. It
does not delete Qdrant collections or touch an existing Contextctl home.

## Validate without infrastructure

```bash
npm run test:benchmark:utility:validate
```

This checks the fixture schema, corpus facts, deterministic ranking rules, and
report contract. It is not a retrieval-quality result.

## Run the held-out evaluation

```bash
export CONTEXTCTL_QDRANT_URL=http://127.0.0.1:6333
export CONTEXTCTL_EMBEDDING_ASSET_DIRECTORY="$HOME/.contextctl/embedding-assets"
npm run build
npm run test:benchmark:utility
```

Optional variables:

| Variable | Purpose |
| --- | --- |
| `CONTEXTCTL_QDRANT_API_KEY` | Optional API key used by both Contextctl and the baseline Qdrant client |
| `CONTEXTCTL_UTILITY_EVAL_CONTEXTCTL` | External `contextctl` executable. The repository launcher is used by default |
| `CONTEXTCTL_UTILITY_EVAL_HTTP_PORT` | Loopback HTTP port; default `18080` |
| `CONTEXTCTL_UTILITY_EVAL_REPETITIONS` | Timed repetitions per query; default `5` |
| `CONTEXTCTL_UTILITY_EVAL_TOP_K` | Final chunks per path; default `5` |
| `CONTEXTCTL_UTILITY_EVAL_PREFETCH_K` | Dense and lexical candidates before RRF; default `20` |
| `CONTEXTCTL_UTILITY_EVAL_MAX_CONTEXT` | Shared character budget; default `8000` |
| `CONTEXTCTL_UTILITY_EVAL_GENERATION_ENDPOINT` | Full OpenAI-compatible chat-completions URL |
| `CONTEXTCTL_UTILITY_EVAL_GENERATION_MODEL` | Answer model identifier |
| `CONTEXTCTL_UTILITY_EVAL_GENERATION_API_KEY` | Bearer token for the answer model |

All three generation variables are required together. Without them, retrieval
and context metrics are produced but prompt-token and blinded answer-quality
evidence remains incomplete.

## Outputs

Each run writes an immutable timestamped directory under `results/`:

- `result.json`: machine-readable observations and summaries
- `report.md`: conditions, metrics, warnings, and claim boundary
- `blind-review.json`: randomly ordered answer pairs without path names
- `answer-key.json`: the separate path mapping and token observations

Generated results are ignored by Git. A result must be reviewed before a
specific evidence bundle is intentionally committed.

## Claim boundary

The bundled corpus is the five-document public demo and the held-out fixture has
25 questions. It can detect regressions and measure this product scenario; it
does not establish general RAG superiority. A run without the generation
variables cannot claim LLM token reduction or answer-quality parity.
