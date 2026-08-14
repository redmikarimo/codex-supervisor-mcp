# Reeves Android routing

The hosted MCP relay exposes the existing `codex_*` tools plus:

- `reeves_status`
- `reeves_tap`
- `reeves_swipe`
- `reeves_type`
- `reeves_back`
- `reeves_home`
- `reeves_recents`
- `reeves_sequence`
- `reeves_screenshot`

`reeves_status` and `reeves_screenshot` require the configured MCP read scope.
The seven device-changing tools, including `reeves_sequence`, require the
configured MCP write scope.

## Low-latency sequences

`reeves_sequence` enqueues one Reeves-routed job containing 1 through 50
ordered local actions: tap, swipe, type, Back, Home, Recents, wait, or
screenshot. It stops on the first failure by default and returns the exact
failed index and type. `screenshotBefore` defaults to false,
`screenshotAfter` defaults to true, `stopOnError` defaults to true,
`perActionTimeoutMs` defaults to 5,000, and `overallTimeoutMs` defaults to
60,000.

The Android claim request is a 25-second long poll that the queue wakes as soon
as matching work is enqueued. The value is a connection lifetime, not a poll
sleep. Android starts the next claim immediately after result submission and
does not expose an inbound port. Reeves MCP results include additive timestamps
for MCP receipt, queueing, claim, Android execution, result receipt, and MCP
return so pickup, execution, upload, and serialization costs remain visible.

## Trusted routing boundary

The relay derives a private queue route from the tool namespace. It derives the
claim route independently from the successfully authenticated HMAC key ID. A
client-supplied routing property is ignored and cannot affect either decision.

- Authenticated `reeves-android-1` requests can claim only `reeves_*` jobs.
- The existing Windows credential and legacy Windows key IDs can claim only
  `codex_*` jobs.
- Result and artifact submissions must use the same authenticated key ID and
  current lease that claimed the job.

Lease expiry, job expiry, long polling, result chunking, HMAC replay protection,
OAuth authorization, MCP idempotency, and result timeouts are unchanged.

## Hostinger configuration

Keep the existing Windows values and add an independent Reeves secret:

```text
BIOTELE_RELAY_AGENT_KEY_ID=windows-agent-1
BIOTELE_RELAY_AGENT_SECRET=<existing Windows HMAC secret, at least 32 bytes>
BIOTELE_RELAY_REEVES_AGENT_KEY_ID=reeves-android-1
BIOTELE_RELAY_REEVES_AGENT_SECRET=<independent Reeves HMAC secret, at least 32 bytes>
```

Never commit or log either secret. Configure Reeves Android with key ID
`reeves-android-1` and only the matching Reeves secret.

## Deployment

Use the repository's existing reversible Hostinger workflow:

1. Add the two `BIOTELE_RELAY_REEVES_AGENT_*` variables in hPanel.
2. Deploy the tested Git commit through Hostinger's Git integration.
3. Restart the Node.js application whose startup command is
   `npm run start:hostinger-relay`.
4. Verify `https://mcp.biotele.mx/readyz` returns ready.
5. Start Reeves and verify `reeves_status`, `reeves_sequence`, then
   `reeves_screenshot`.
6. Explicitly approve a low-risk device-changing tool call and confirm that the
   Windows agent remains able to execute a `codex_status` job.

The Windows scheduled task, key ID, and secret do not change.
