# Remote MCP Deployment

This project exposes a Streamable HTTP MCP endpoint at `/mcp`. Production deployment keeps Node bound to loopback and uses Cloudflare Tunnel for public HTTPS.

## Security Defaults

- Bind the Node server to `127.0.0.1`.
- Keep `CODEX_REMOTE_AUTH_MODE=bearer` for private testing or Responses API clients that can send an authorization header.
- Use `CODEX_REMOTE_AUTH_MODE=oauth` for a ChatGPT custom MCP app when your ChatGPT flow requires user authorization.
- Keep `CODEX_ALLOW_NETWORK=0` unless you intentionally allow supervised Codex tasks to use network access.
- Never use `CODEX_REMOTE_AUTH_MODE=none` for deployment.
- Never commit `.env`, bearer-token files, `cert.pem`, Cloudflare tunnel JSON credentials, dashboard tunnel tokens, or OAuth client secrets.

## Local Server

Copy `examples/remote.env.example` to `.env` and edit safe local values. Omit `CODEX_REMOTE_BEARER_TOKEN` to let the startup script create `.remote-bearer-token`.

```powershell
Set-Location -LiteralPath 'C:\Users\Red Mex\Documents\codex-supervisor-mcp'
.\scripts\start-remote.ps1
```

The script prints only a token fingerprint. To verify the local endpoint:

```powershell
.\scripts\test-remote.ps1 -BaseUrl 'http://127.0.0.1:8787'
```

## Cloudflare Tunnel

Cloudflare Tunnel creates outbound connections from this machine to Cloudflare and maps a public hostname to the loopback origin. Do not configure router port forwarding for port `8787`.

Install `cloudflared`:

```powershell
.\scripts\install-cloudflare-tunnel.ps1
cloudflared --version
```

Create a remotely managed production tunnel in the Cloudflare dashboard:

1. Open Cloudflare Zero Trust.
2. Go to `Networks` > `Tunnels`.
3. Select `Create tunnel`.
4. Choose `Cloudflared`.
5. Name the tunnel, for example `codex-supervisor-mcp`.
6. Select Windows and copy the install token.
7. Add a public hostname that you own in Cloudflare.
8. Set the origin service URL to `http://127.0.0.1:8787`.
9. Save and wait for the tunnel status to become healthy.

Store the dashboard tunnel token in an ignored local file, for example `.cloudflared-tunnel-token`, then install the service:

```powershell
.\scripts\install-cloudflare-tunnel.ps1 -InstallService -TunnelTokenFile .\.cloudflared-tunnel-token
```

Use the dashboard-managed token flow for production when possible. If you choose a locally managed tunnel instead, run `cloudflared tunnel login`, create a named tunnel, route DNS to your hostname, and keep `cert.pem` plus the generated tunnel JSON outside Git.

## External Verification

After the tunnel is healthy and your local remote server is running:

```powershell
.\scripts\test-remote.ps1 -BaseUrl 'https://YOUR-HOSTNAME'
```

Expected results:

- `/healthz` returns `status: ok`.
- Unauthenticated `/mcp` returns `401`.
- Authenticated `initialize` succeeds.
- Authenticated `tools/list` succeeds.
- Authenticated `codex_list_threads` succeeds without starting a write-enabled task.

## ChatGPT Connector Readiness

In ChatGPT Developer Mode, create a custom MCP app with endpoint:

```text
https://YOUR-HOSTNAME/mcp
```

If the ChatGPT setup page offers API key authentication with a custom `Authorization: Bearer ...` header, bearer mode can be used for private testing. If it requires OAuth or user authorization, bearer-only mode is not enough.

For OAuth mode, configure an OpenID Connect provider such as Auth0, Microsoft Entra ID, or Cloudflare Access with OIDC. The provider must issue RS256 JWT access tokens and publish discovery metadata plus JWKS. Configure:

```text
CODEX_REMOTE_AUTH_MODE=oauth
CODEX_REMOTE_OAUTH_ISSUER=https://YOUR_ISSUER
CODEX_REMOTE_OAUTH_AUDIENCE=https://YOUR-HOSTNAME/mcp
CODEX_REMOTE_PUBLIC_URL=https://YOUR-HOSTNAME
```

The provider should issue refresh tokens or advertise an equivalent offline access scope if ChatGPT needs to maintain connectivity.

## Startup And Restart

Start the MCP server:

```powershell
.\scripts\start-remote.ps1
```

Restart Cloudflare Tunnel service:

```powershell
sc.exe stop cloudflared
sc.exe start cloudflared
```

Check tunnel logs and status:

```powershell
cloudflared tunnel list
cloudflared tunnel info codex-supervisor-mcp
Get-Service cloudflared
```

## Troubleshooting

- `401` from `/mcp`: missing or wrong bearer token, or OAuth token failed validation.
- `spawn EPERM` from `codex_list_threads`: set `CODEX_BIN` to the native `codex.exe`, not the npm PowerShell shim.
- Tunnel unhealthy: confirm `cloudflared` service is running and this machine has outbound internet access.
- `404` through Cloudflare: confirm the public hostname route points to `http://127.0.0.1:8787`.
- ChatGPT cannot scan tools: confirm public HTTPS `/mcp` is reachable, auth is configured in the ChatGPT app, and the auth mode matches what ChatGPT expects.

## Rollback

1. Disable or delete the Cloudflare public hostname route.
2. Stop the tunnel service with `sc.exe stop cloudflared`.
3. Stop the Node remote server.
4. Rotate the bearer token or revoke OAuth credentials.
5. Remove local ignored credentials if the machine should no longer host the bridge.
