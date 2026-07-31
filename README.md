# Codex Supervisor MCP

A local Model Context Protocol (MCP) bridge that lets a compatible host start, monitor, steer, interrupt, resume, and approve Codex app-server work.

It wraps `codex app-server`; it does not automate a terminal UI or scrape an IDE.

## Capabilities

The server exposes these MCP tools:

| Tool | Purpose |
|---|---|
| `codex_start` | Start a new Codex thread and turn in an allowed repository. |
| `codex_send` | Send a new instruction after the active turn is idle. |
| `codex_steer` | Append guidance to the active turn. |
| `codex_status` | Read thread state, recent events, the latest agent message, diff, and pending requests. |
| `codex_wait` | Long-poll until completion, failure, interruption, or an approval request. |
| `codex_interrupt` | Interrupt an active turn. |
| `codex_list_threads` | List persisted threads inside configured roots. |
| `codex_read_thread` | Read a persisted authorized thread. |
| `codex_list_approvals` | Inspect pending app-server requests. |
| `codex_resolve_approval` | Accept or reject command-execution and file-change approvals. |

## Requirements

- Node.js 20 or newer.
- A current Codex CLI available as `codex`.
- Codex CLI authentication already configured.
- One or more explicit local repository roots.

This project has no npm runtime dependencies.

## Verify the package

```bash
npm test
```

The test suite uses a protocol-compatible mock app-server. It does not make model requests or require Codex authentication.

## Install with the Codex CLI

Use the MCP server name `codex-supervisor`. The name must match
`CODEX_SUPERVISOR_MCP_NAME`; the bridge uses it to prevent the child
app-server from loading this same MCP server recursively.

### macOS or Linux

```bash
codex mcp add codex-supervisor \
  --env CODEX_ALLOWED_ROOTS="/Users/you/code:/Users/you/work" \
  --env CODEX_SUPERVISOR_MCP_NAME="codex-supervisor" \
  -- node "/absolute/path/to/codex-supervisor-mcp/src/index.mjs"
```

Use the platform path-list delimiter between roots. On macOS and Linux it is
a colon (`:`).

### Windows PowerShell

```powershell
codex mcp add codex-supervisor `
  --env CODEX_ALLOWED_ROOTS="C:\src;D:\work" `
  --env CODEX_SUPERVISOR_MCP_NAME="codex-supervisor" `
  -- node "C:\absolute\path\to\codex-supervisor-mcp\src\index.mjs"
```

On Windows the path-list delimiter is a semicolon (`;`).

Confirm the registration:

```bash
codex mcp list
```

In Codex, type `/mcp` to inspect the connected server.

## Install with `config.toml`

Copy and adapt `examples/config.toml`, then place its contents in
`~/.codex/config.toml` or a trusted project's `.codex/config.toml`.

Use absolute paths. Keep the server id and
`CODEX_SUPERVISOR_MCP_NAME` identical.

## ChatGPT desktop or the Codex IDE extension

1. Open **Settings → MCP servers → Add server**.
2. Set the name to `codex-supervisor`.
3. Select **STDIO**.
4. Set the command to `node`.
5. Add the absolute path to `src/index.mjs` as the only argument.
6. Add `CODEX_ALLOWED_ROOTS` and
   `CODEX_SUPERVISOR_MCP_NAME=codex-supervisor`.
7. Save and restart the host.
8. Type `/mcp` to verify the tools.

Local STDIO MCP servers are not loaded by ordinary ChatGPT web chats.
Using this bridge from the web requires a separately deployed,
authenticated remote MCP service or hosted plugin.

## Typical workflow

Ask the MCP host to:

```text
Use codex_start in /absolute/path/to/repository to implement the requested
change. Use workspaceWrite, keep network access disabled, wait for progress,
show me every approval request before resolving it, and report the final diff
and test result.
```

The host should follow this sequence:

```text
codex_start -> codex_wait
  approval request -> inspect -> codex_resolve_approval -> codex_wait
  active correction -> codex_steer -> codex_wait
  completed -> codex_status
  later follow-up -> codex_send -> codex_wait
```

Every start/send/steer/interrupt call returns an `eventCursor`. Pass it as
`afterSequence` to `codex_wait` or `codex_status` to avoid replaying older
events.

`approvalPolicy` accepts the current app-server wire values `on-request`
(default) and `untrusted`. The legacy values `onRequest` and `unlessTrusted`
are accepted by the bridge and normalized before the app-server request.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `CODEX_ALLOWED_ROOTS` | Required | Repository roots separated by the platform path-list delimiter. |
| `CODEX_BIN` | `codex` | Codex executable path. |
| `CODEX_SUPERVISOR_MCP_NAME` | `codex-supervisor` | MCP config id disabled in the nested app-server to prevent recursion. |
| `CODEX_ALLOW_NETWORK` | `0` | Set to `1` to allow callers to request network access. |
| `CODEX_EVENT_LIMIT` | `1000` | In-memory event count, clamped to 100–10,000. |
| `CODEX_SUPERVISOR_DEBUG` | `0` | Set to `1` to copy Codex app-server stderr to this server's stderr. |
| `CODEX_APP_SERVER_ARGS` | Internal safe default | Advanced JSON array replacing every argument passed to `codex`. |

The default app-server arguments are equivalent to:

```text
-c mcp_servers.<CODEX_SUPERVISOR_MCP_NAME>.enabled=false app-server
```

Overriding `CODEX_APP_SERVER_ARGS` removes that recursion guard. Include an
equivalent disable override yourself.

## Security model

- `CODEX_ALLOWED_ROOTS` is mandatory.
- Paths are canonicalized with `realpath`; symlink escapes are rejected.
- Codex receives restricted read access to the selected repository and
  platform defaults.
- `workspaceWrite` limits writable roots to the selected repository.
- `dangerFullAccess` is not exposed.
- Network access requires both `CODEX_ALLOW_NETWORK=1` and
  `networkAccess: true` on a task.
- The bridge has no generic, unsandboxed shell tool.
- Command and file-change approvals must be resolved explicitly.
- Threads outside allowed roots are denied or filtered.
- Event payloads are size-bounded before storage.

The child app-server still inherits the MCP server process environment and
your broader Codex configuration. Audit environment secrets, apps, skills,
hooks, and other configured MCP servers before using it with untrusted code.

## Supported approval requests

This release resolves:

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`

Other app-server requests remain visible through `codex_status` and
`codex_list_approvals`, but the bridge refuses to answer them. This prevents
a generic response endpoint from silently granting permissions or supplying
sensitive user input.

## Persistence and monitoring

Codex owns persisted thread history. The bridge keeps streamed event buffers,
latest deltas, and pending request state in memory. Restarting the MCP server
clears that transient state, but `codex_list_threads` and
`codex_read_thread` can recover authorized persisted threads.

## Development

```bash
npm test
node --check src/index.mjs
```

Project layout:

```text
src/app-server-client.mjs  Codex app-server JSONL client
src/approval-policy.mjs    Approval-policy validation and legacy normalization
src/event-store.mjs        Bounded event, turn, and approval state
src/security.mjs           Repository-root policy
src/supervisor-service.mjs Codex lifecycle orchestration
src/tool-registry.mjs      MCP tool schemas and validation
src/mcp-server.mjs         Dual-era MCP STDIO transport
src/index.mjs              Entrypoint
test/                      Unit and integration tests
```

## License

MIT

### Codex App Server compatibility

Version 1.0.3 removes the deprecated `readOnly.access` and
`workspaceWrite.readOnlyAccess` fields from `turn/start`. Current Codex App
Server releases use permission profiles when a client needs custom restricted
read scopes. The supervisor continues to restrict writable roots to the selected
repository and validates every task directory against `CODEX_ALLOWED_ROOTS`.
