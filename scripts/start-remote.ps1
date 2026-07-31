param(
    [string] $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
    [string] $EnvFile = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')).Path '.env'),
    [string] $TokenFile = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')).Path '.remote-bearer-token')
)

$ErrorActionPreference = 'Stop'

function Import-EnvFile {
    param([string] $Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }

    foreach ($line in Get-Content -LiteralPath $Path) {
        $trimmed = $line.Trim()
        if ($trimmed -eq '' -or $trimmed.StartsWith('#')) {
            continue
        }
        $parts = $trimmed.Split('=', 2)
        if ($parts.Count -ne 2 -or $parts[0] -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
            throw "Invalid environment line in ${Path}: $line"
        }
        [Environment]::SetEnvironmentVariable($parts[0], $parts[1], 'Process')
    }
}

function New-BearerToken {
    $bytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    [Convert]::ToBase64String($bytes)
}

function Get-TokenFingerprint {
    param([string] $Token)
    $sha = [Security.Cryptography.SHA256]::Create()
    $hash = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Token))
    ([BitConverter]::ToString($hash) -replace '-', '').Substring(0, 12).ToLowerInvariant()
}

function Resolve-NativeCodex {
    if ($env:CODEX_BIN) {
        if (-not (Test-Path -LiteralPath $env:CODEX_BIN)) {
            throw "CODEX_BIN is set but does not exist."
        }
        return $env:CODEX_BIN
    }

    $npmRoot = Join-Path $env:APPDATA 'npm\node_modules\@openai\codex'
    if (Test-Path -LiteralPath $npmRoot) {
        $candidate = Get-ChildItem -LiteralPath $npmRoot -Recurse -Filter codex.exe -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match '\\bin\\codex\.exe$' } |
            Select-Object -First 1
        if ($candidate) {
            return $candidate.FullName
        }
    }

    $command = Get-Command codex.exe -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    throw 'Could not find native codex.exe. Install or update @openai/codex, or set CODEX_BIN.'
}

Set-Location -LiteralPath $RepoRoot
Import-EnvFile -Path $EnvFile

if (-not $env:CODEX_ALLOWED_ROOTS) {
    $env:CODEX_ALLOWED_ROOTS = $RepoRoot
}
if (-not $env:CODEX_ALLOW_NETWORK) {
    $env:CODEX_ALLOW_NETWORK = '0'
}
if (-not $env:CODEX_SUPERVISOR_MCP_NAME) {
    $env:CODEX_SUPERVISOR_MCP_NAME = 'codex-supervisor'
}
if (-not $env:CODEX_REMOTE_HOST) {
    $env:CODEX_REMOTE_HOST = '127.0.0.1'
}
if (-not $env:CODEX_REMOTE_PORT) {
    $env:CODEX_REMOTE_PORT = '8787'
}
if (-not $env:CODEX_REMOTE_PATH) {
    $env:CODEX_REMOTE_PATH = '/mcp'
}
if (-not $env:CODEX_REMOTE_AUTH_MODE) {
    $env:CODEX_REMOTE_AUTH_MODE = 'bearer'
}

if ($env:CODEX_REMOTE_HOST -notin @('127.0.0.1', '::1')) {
    throw 'CODEX_REMOTE_HOST must stay bound to loopback for Cloudflare Tunnel deployment.'
}
if ($env:CODEX_REMOTE_AUTH_MODE -eq 'none') {
    throw 'CODEX_REMOTE_AUTH_MODE=none is not allowed for deployment startup.'
}
if ($env:CODEX_REMOTE_AUTH_MODE -eq 'bearer') {
    if (-not $env:CODEX_REMOTE_BEARER_TOKEN) {
        if (Test-Path -LiteralPath $TokenFile) {
            $env:CODEX_REMOTE_BEARER_TOKEN = (Get-Content -LiteralPath $TokenFile -Raw).Trim()
        } else {
            $token = New-BearerToken
            [IO.File]::WriteAllText($TokenFile, $token, [Text.UTF8Encoding]::new($false))
            $env:CODEX_REMOTE_BEARER_TOKEN = $token
            Write-Host "Generated bearer token and stored it in $TokenFile"
        }
    }
    if ([Text.Encoding]::UTF8.GetByteCount($env:CODEX_REMOTE_BEARER_TOKEN) -lt 32) {
        throw 'CODEX_REMOTE_BEARER_TOKEN must contain at least 32 bytes.'
    }
    Write-Host "Bearer token loaded; sha256 fingerprint: $(Get-TokenFingerprint $env:CODEX_REMOTE_BEARER_TOKEN)"
}

$env:CODEX_BIN = Resolve-NativeCodex
Write-Host "Starting Codex Supervisor Remote on http://$($env:CODEX_REMOTE_HOST):$($env:CODEX_REMOTE_PORT)$($env:CODEX_REMOTE_PATH)"
Write-Host "Task network access enabled: $($env:CODEX_ALLOW_NETWORK -eq '1')"

node .\src\remote-server.mjs
