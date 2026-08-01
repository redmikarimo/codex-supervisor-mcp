# Biotele Codex Supervisor MCP

## Value Proposition

Enable a developer/operator to supervise Codex from a ChatGPT web conversation and carry on a meaningful bidirectional exchange through an MCP bridge.

The current pain is uncertainty: a configured plugin may appear connected while message delivery, task state, cancellation, timeouts, or error reporting are incomplete or misleading.

**Core actions**:

1. Send a message or task from ChatGPT to Codex and receive the resulting Codex response.
2. Send a response or follow-up from Codex back into the same ChatGPT-mediated workflow.
3. Inspect and control the lifecycle of bridge-mediated work using the capabilities the server actually advertises.

## Why LLM?

**Conversational win**: A user can describe work, clarification, or a follow-up naturally instead of translating it into low-level process-control commands.

**LLM adds**: ChatGPT interprets intent and selects bridge tools; Codex reasons over the local workspace and performs or reports the requested work.

**What the LLM lacks**: Direct access to the other assistant's task/session state, reliable delivery semantics, and lifecycle control. The MCP server supplies those capabilities.

## User Journey

**First view**: The user opens an existing ChatGPT conversation with the Biotele Codex Supervisor MCP available.

**Key interactions**:

- ChatGPT discovers the server and its tools without receiving secret values.
- ChatGPT starts or addresses a Codex task and sends a distinctive test message.
- Codex observes the inbound message and returns a distinctive response through the bridge.
- ChatGPT receives and explains the response, then performs a follow-up exchange.
- The conversation exercises every advertised safe capability, including status, waiting/polling, and lifecycle controls where applicable.

**End state**: The browser visibly contains a meaningful multi-turn ChatGPT/Codex conversation whose delivery can be correlated with server evidence. Failures and timeouts are explicit rather than reported as success.

## Product Context

- **Existing product**: Local `codex-supervisor-mcp` repository and a configured ChatGPT web plugin named "Biotele Codex Supervisor".
- **Interface**: MCP tools consumed by ChatGPT; local Codex supervision/runtime integration behind the server.
- **Authentication**: Preserve the repository's configured authentication model. Never print, commit, or expose bearer tokens or other secret values.
- **Constraints**:
  - Use the already-open in-app browser session for end-to-end validation.
  - Preserve unrelated user changes and avoid destructive Git or task operations.
  - Distinguish a locally passing server/test suite from an actually validated browser-to-Codex round trip.
  - Do not claim a capability passed unless both the client-visible behavior and server/runtime evidence support it.

## Acceptance Criteria

1. Installation and documented baseline checks pass, or any remaining external blocker is identified precisely.
2. ChatGPT can discover and invoke the bridge without leaking credentials.
3. At least two correlated message turns cross the bridge in both directions and are visible in the ChatGPT conversation.
4. Every advertised safe MCP capability is exercised end to end; destructive controls are tested only on disposable bridge-created work.
5. Invalid input, unknown task/session identifiers, timeout/empty-result behavior, and server restart/reconnection behavior are tested where supported.
6. Bugs found are covered by regression tests and the relevant documentation/configuration is updated.
7. Final reporting clearly separates automated/local validation from live browser validation.
8. `codex_status.latestAgentMessage` reconciles live bridge state with the
   authorized persisted transcript before responding. It includes completed
   assistant messages from synthesized `rollout-*` turns, deterministically
   selects the newest fully persisted response, refreshes after transcript
   changes or terminal turns, and agrees with `codex_read_thread` without
   exposing partial transcript writes.

## UX Flows

Start or continue Codex work:

1. Attach the Biotele Codex Supervisor app in ChatGPT.
2. List authorized threads or start a thread inside an allowed root.
3. Wait for progress, steer an active turn, or send a follow-up after it is idle.
4. Read the persisted thread and report the terminal state with identifiers and event cursors.

Inspect and control disposable work:

1. Read status and pending approvals for an authorized thread.
2. Inspect the exact command or file-change request before resolving it.
3. Accept, decline, cancel, or interrupt only as authorized.
4. Verify the terminal thread state, empty approval queue, and absence of unintended changes.

## Tools and API Design

This is a tool-only conversational app; its outputs are compact structured data and do not need a custom view.

- `codex_start`: start a thread and turn in an allowed repository.
- `codex_send`: begin a follow-up turn only while the thread is idle.
- `codex_steer`: append guidance to the active turn, optionally guarded by the expected turn ID.
- `codex_status`: return thread state, current turn, recent events, latest
  message/diff/error, approvals, and event cursor. Its latest assistant message
  is reconciled with the persisted authorized thread on every status snapshot,
  so externally completed and synthesized turns cannot leave a stale cached
  bridge response behind.
- `codex_wait`: long-poll from an event cursor until a terminal event, request, or bounded timeout.
- `codex_interrupt`: cancel an active disposable turn.
- `codex_list_threads` and `codex_read_thread`: list/read only threads whose current canonical paths remain authorized.
- `codex_list_approvals`: return inspectable pending command and file-change requests.
- `codex_resolve_approval`: accept, accept for the session, decline, or cancel a supported inspected request.

Remote action calls are idempotent within an OAuth-subject-bound MCP session.
The relay negotiates a supported protocol, requires the issued session on
follow-up requests, and cancels or invalidates its work when the session is
terminated. Same-thread mutations and approval responses are serialized. Public
errors are redacted and bounded.
