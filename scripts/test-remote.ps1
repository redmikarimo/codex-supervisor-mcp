param(
    [string] $BaseUrl = 'http://127.0.0.1:8787',
    [string] $Path = '/mcp',
    [string] $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
    [string] $EnvFile = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')).Path '.env'),
    [string] $TokenFile = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')).Path '.remote-bearer-token'),
    [switch] $SkipCodexListThreads
)

$ErrorActionPreference = 'Stop'

function Import-EnvFile {
    param([string] $File)
    if (-not (Test-Path -LiteralPath $File)) {
        return
    }
    foreach ($line in Get-Content -LiteralPath $File) {
        $trimmed = $line.Trim()
        if ($trimmed -eq '' -or $trimmed.StartsWith('#')) {
            continue
        }
        $parts = $trimmed.Split('=', 2)
        if ($parts.Count -eq 2 -and $parts[0] -match '^[A-Za-z_][A-Za-z0-9_]*$') {
            [Environment]::SetEnvironmentVariable($parts[0], $parts[1], 'Process')
        }
    }
}

function Get-BearerToken {
    if ($env:CODEX_REMOTE_BEARER_TOKEN) {
        return $env:CODEX_REMOTE_BEARER_TOKEN
    }
    if (Test-Path -LiteralPath $TokenFile) {
        return (Get-Content -LiteralPath $TokenFile -Raw).Trim()
    }
    throw 'No bearer token found. Set CODEX_REMOTE_BEARER_TOKEN or start with scripts/start-remote.ps1 first.'
}

function Invoke-Mcp {
    param(
        [int] $Id,
        [string] $Method,
        [hashtable] $Params,
        [hashtable] $Headers
    )
    $body = @{
        jsonrpc = '2.0'
        id = $Id
        method = $Method
        params = $Params
    } | ConvertTo-Json -Depth 20 -Compress

    Invoke-RestMethod -Method Post -Uri "$BaseUrl$Path" -Headers $Headers -Body $body -TimeoutSec 60
}

Import-EnvFile -File $EnvFile
$token = Get-BearerToken
$headers = @{
    Authorization = "Bearer $token"
    'Content-Type' = 'application/json'
}

$health = Invoke-RestMethod -Method Get -Uri "$BaseUrl/healthz" -TimeoutSec 15

$unauthStatus = $null
try {
    Invoke-WebRequest -Method Post -Uri "$BaseUrl$Path" -ContentType 'application/json' -Body '{"jsonrpc":"2.0","id":99,"method":"initialize","params":{}}' -TimeoutSec 15 | Out-Null
    $unauthStatus = 200
} catch {
    $unauthStatus = [int]$_.Exception.Response.StatusCode
}

$initialize = Invoke-Mcp -Id 1 -Method 'initialize' -Params @{
    protocolVersion = '2025-11-25'
    capabilities = @{}
    clientInfo = @{ name = 'codex-supervisor-remote-test'; version = '1.0.0' }
} -Headers $headers
$tools = Invoke-Mcp -Id 2 -Method 'tools/list' -Params @{} -Headers $headers

$listThreads = $null
if (-not $SkipCodexListThreads) {
    $listThreads = Invoke-Mcp -Id 3 -Method 'tools/call' -Params @{
        name = 'codex_list_threads'
        arguments = @{ limit = 1; cwd = $RepoRoot }
    } -Headers $headers
}

[pscustomobject]@{
    baseUrl = $BaseUrl
    healthStatus = $health.status
    healthVersion = $health.version
    unauthenticatedMcpStatus = $unauthStatus
    initializeServer = $initialize.result.serverInfo.name
    toolCount = @($tools.result.tools).Count
    codexListThreadsSucceeded = if ($SkipCodexListThreads) { $null } else { -not [bool]$listThreads.result.isError }
}
