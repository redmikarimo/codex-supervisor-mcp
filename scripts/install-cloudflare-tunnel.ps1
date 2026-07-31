param(
    [string] $InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\cloudflared'),
    [string] $DownloadUrl = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
    [string] $TunnelTokenFile,
    [switch] $InstallService
)

$ErrorActionPreference = 'Stop'

$exe = Join-Path $InstallDir 'cloudflared.exe'
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null

if (-not (Test-Path -LiteralPath $exe)) {
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $exe
}

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$entries = @($userPath -split ';' | Where-Object { $_ })
if ($entries -notcontains $InstallDir) {
    [Environment]::SetEnvironmentVariable('Path', (@($entries) + $InstallDir) -join ';', 'User')
}
$env:Path = "$InstallDir;$env:Path"

$version = & $exe --version
Write-Host $version

if ($InstallService) {
    if (-not $TunnelTokenFile) {
        throw 'Pass -TunnelTokenFile with a local file containing the remotely managed tunnel token. Do not commit this file.'
    }
    if (-not (Test-Path -LiteralPath $TunnelTokenFile)) {
        throw "Tunnel token file not found: $TunnelTokenFile"
    }

    & $exe service install --token-file $TunnelTokenFile
    Write-Host 'cloudflared service install requested with token file.'
}

Write-Host 'Next: create a remotely managed tunnel in Cloudflare Zero Trust, publish a hostname to http://127.0.0.1:8787, and use the dashboard install token with -InstallService.'
