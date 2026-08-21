# contextctl

**Decide where to search before you search.**

[한국어](README.ko.md)

MCP connects external data to an AI. contextctl makes that connected knowledge
searchable, keeps it current, and restricts what an AI may search to **what a
person approved**.

Registering a document does not make it searchable. A human approves a Card
first, and every query answers from inside that approved scope.

It also runs as an MCP server, so an agent like Claude Code can use it.

> **The CLI speaks Korean.** Command names and flags are English; messages,
> diagnostics and the reference docs are Korean. Locale support is planned, not
> implemented.

> Verified on **darwin arm64**. Linux and WSL are untested.

---

## What it does

| | |
|---|---|
| **Represent** | Turns external knowledge into retrieval units that keep its structure and meaning. Markdown is split along document structure into semantic units and chunks, embedded, and published to an index. PostgreSQL and OpenAPI are never copied — only their **coordinates** are published |
| **Lifecycle** | Capture and registration run on **independent cycles**. When a document changes, only the changed chunks are re-embedded; when registration falls behind, the delay is reported rather than hidden. Cards are never overwritten — versions accumulate and only a validated one is promoted |
| **Select** | Picks the knowledge areas and retrieval scopes that fit a question. The answer is not a ranked list but an **admit / defer / reject verdict**, and it reports what it discarded as well as what it chose |
| **Deliver** | For managed documents it assembles the supporting text in the same request. For databases and APIs it returns **coordinates you can verify** before acting on them |

## What it will not do

Keeping the responsibility narrow is the design, not a missing feature.

- **It does not write or run SQL.** Instead of turning a question into a query,
  it gives you verifiable coordinates — schema, table, columns, permitted
  operations
- **It does not call HTTP APIs.** It tells you which operation
- **It does not produce the final answer.** It assembles grounds; the caller
  answers
- **It never reads retrieved document text as instruction.** Every response
  carries `contentTrust: untrusted` — retrieved text is data

---

## Requirements

| | |
|---|---|
| **Node.js** | **24 or newer** — the stores are built on `node:sqlite`, first shipped in Node 24 |
| **Qdrant** | Required. `ingest`, `query` and `serve` refuse to start without `CONTEXTCTL_QDRANT_URL` |
| **Disk** | **396.1 MiB** for the embedding model |

> ★ **Using `fnm`, `nvm` or `asdf`?** They install into the **active Node
> version's `bin` only**. Switching versions makes `contextctl` look like it
> vanished. `contextctl paths` reports which Node it is under.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/TEAM-SEAM-contextctl/contextctl/main/install.sh | bash
```

The script does three things — check the Node version, install five packages
globally, confirm `PATH` reaches them. **It does not download the model.** A
396 MiB download needs its own consent, so the next step asks for it.

---

## Five minutes

> Every command prints a `SQLite is an experimental feature` warning on
> `stderr`. That is expected and harmless — the stores use Node's built-in
> `node:sqlite`. No suppression flag is documented, because silencing this
> warning silences the ones that matter too.

```bash
# 1. Start the vector index
docker run -d -p 6333:6333 qdrant/qdrant
export CONTEXTCTL_QDRANT_URL=http://localhost:6333

# 2. Install the embedding model (396.1 MiB, asks for consent)
contextctl install-assets

# 3. Check the installation
contextctl doctor

# 4. Register a document and capture it
contextctl source add ./docs/leave.md
contextctl ingest

# 5. Read what was produced, then approve it
contextctl cards list
contextctl cards approve <cardId>

# 6. Ask
contextctl query "How do I take a half day?"
```

**Step 5 is the boundary this product exists for.** Capturing alone searches
nothing. A Card you do not approve is never used, and one you did approve can be
withdrawn with `cards disable` and approved again later — without re-capturing.

> ★ **Configure a Card meaning generator.** Without one, capture falls back to a
> generator that restates the observed facts — it answers simple questions, but a
> Card's description reads as a list of field values rather than a sentence about
> the area. What each generator produces, measured, is in
> [설정 / Configuration](docs/configuration.md#card-의미-생성기--설정을-권장합니다)
> (Korean).

---

## As an MCP server

```bash
contextctl serve
```

Speaks MCP over stdin/stdout. Exactly **one tool** is exposed to an agent:
`resolve_context`. Control commands like approve and reject are deliberately
absent — approval stays in human hands.

For Claude Code, in the project's `.mcp.json`:

```json
{
  "mcpServers": {
    "contextctl": {
      "command": "contextctl",
      "args": ["serve"],
      "env": { "CONTEXTCTL_QDRANT_URL": "http://localhost:6333" }
    }
  }
}
```

> ★ **This configuration shape is not verified in this repository.** We confirmed
> that `contextctl serve` works as an MCP stdio server, but we have not
> registered it in Claude Code with the `.mcp.json` above.

HTTP 질의 표면은 기본으로 꺼져 있습니다. 필요한 경우에만 포트를 지정합니다.

```bash
CONTEXTCTL_HTTP_PORT=8080 contextctl serve
```

v1 HTTP에는 인증 계층이 없으므로 기본 주소는 `127.0.0.1`이고, `CONTEXTCTL_HTTP_HOST`도
`127.0.0.0/8` 또는 `::1`의 숫자 loopback 주소만 허용합니다. `0.0.0.0`, `::`, 외부 주소와
`localhost` 같은 호스트명으로는 시작하지 않습니다. 인터넷이나 사내망에 공개하려면 인증과
TLS를 제공하는 별도 프록시 뒤에 두고, daemon 자체는 loopback에 유지하십시오.

MCP·HTTP·`query` 요청은 UTF-8 `64KiB`, 최종 응답은 UTF-8 `2MiB`를 넘을 수 없습니다.
초과 응답을 맞추기 위해 문서 청크를 임의로 자르거나 부분 성공을 전송하지 않습니다.

---

## Documentation

The reference is in Korean, for the reason stated at the top — it quotes CLI
output extensively.

| | |
|---|---|
| [CLI 레퍼런스](docs/cli.md) | Every command, flag and exit code |
| [설정](docs/configuration.md) | Environment variables, embedding model, meaning generator |
| [운영](docs/operations.md) | Status checks, reachability, index rebuild, uninstall |
| [CONTRIBUTING](CONTRIBUTING.md) | Development setup, branch and review rules |

In a terminal the CLI tells you itself.

```bash
contextctl help                 # everything
contextctl help cards approve   # one command
contextctl status               # which execution lane cannot work right now
```

## License

MIT
