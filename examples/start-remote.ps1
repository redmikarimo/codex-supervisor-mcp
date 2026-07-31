$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
& (Join-Path $repoRoot 'scripts\start-remote.ps1') -RepoRoot $repoRoot
