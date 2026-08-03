param(
  [string]$ProjectPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path,
  [string]$RelayBaseUrl = 'https://mcp.biotele.mx',
  [string]$AgentKeyId = 'windows-agent-1',
  [string]$AllowedRoots,
  [string]$CodexBin,
  [string]$TaskName = 'Biotele Codex MCP Local Agent',
  [switch]$RegisterScheduledTask
)

$ErrorActionPreference = 'Stop'

function Read-SecretText {
  param([string]$Prompt)
  $secure = Read-Host -Prompt $Prompt -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

function Assert-NativeCodexPath {
  param([Parameter(Mandatory = $true)][string]$Path)

  $resolved = Resolve-Path -LiteralPath $Path -ErrorAction Stop
  if ($resolved.Provider.Name -ne 'FileSystem') {
    throw "Codex executable must use the FileSystem provider: $Path"
  }
  if (-not (Test-Path -LiteralPath $resolved.ProviderPath -PathType Leaf)) {
    throw "Codex executable is not a file: $Path"
  }
  if ([IO.Path]::GetExtension($resolved.ProviderPath) -ine '.exe' -or
      [IO.Path]::GetFileName($resolved.ProviderPath) -ine 'codex.exe') {
    throw 'CODEX_BIN must point to the native codex.exe, not a .cmd, .bat, or .ps1 shell shim.'
  }
  return $resolved.ProviderPath
}

function Resolve-NativeCodex {
  param(
    [string]$ExplicitPath,
    [switch]$SkipCommandDiscovery
  )

  $candidates = [Collections.Generic.List[string]]::new()
  if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) {
    $candidates.Add($ExplicitPath)
  }

  $storedPath = [Environment]::GetEnvironmentVariable('CODEX_BIN', 'User')
  if (-not [string]::IsNullOrWhiteSpace($storedPath)) {
    $candidates.Add($storedPath)
  }

  if (-not $SkipCommandDiscovery) {
    $command = Get-Command codex.exe -CommandType Application -ErrorAction SilentlyContinue
    if ($command) {
      $candidates.Add($command.Source)
    }
  }

  if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    $candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\OpenAI\Codex\bin\codex.exe'))
  }

  $openAiScopes = [Collections.Generic.List[string]]::new()
  if (-not [string]::IsNullOrWhiteSpace($env:APPDATA)) {
    $openAiScopes.Add((Join-Path $env:APPDATA 'npm\node_modules\@openai'))
  }
  if (-not $SkipCommandDiscovery) {
    Get-Command codex -All -ErrorAction SilentlyContinue |
      Where-Object { -not [string]::IsNullOrWhiteSpace($_.Source) } |
      ForEach-Object {
        $shimDirectory = Split-Path -Parent $_.Source
        $openAiScopes.Add((Join-Path $shimDirectory 'node_modules\@openai'))
      }
  }

  foreach ($scope in ($openAiScopes | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $scope -PathType Container)) {
      continue
    }
    $searchRoots = [Collections.Generic.List[string]]::new()
    $mainPackage = Join-Path $scope 'codex'
    if (Test-Path -LiteralPath $mainPackage -PathType Container) {
      $searchRoots.Add($mainPackage)
    }
    Get-ChildItem -LiteralPath $scope -Directory -Filter 'codex-win32-*' -ErrorAction SilentlyContinue |
      ForEach-Object { $searchRoots.Add($_.FullName) }
    foreach ($searchRoot in ($searchRoots | Select-Object -Unique)) {
      Get-ChildItem -LiteralPath $searchRoot -Recurse -Filter codex.exe -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match '\\bin\\codex\.exe$' } |
        ForEach-Object { $candidates.Add($_.FullName) }
    }
  }

  foreach ($candidate in ($candidates | Select-Object -Unique)) {
    try {
      return Assert-NativeCodexPath -Path $candidate
    } catch {
      if (-not [string]::IsNullOrWhiteSpace($ExplicitPath) -and $candidate -eq $ExplicitPath) {
        throw
      }
    }
  }
  throw 'Native codex.exe was not found. Install Codex or pass -CodexBin with its absolute path.'
}

function Resolve-AllowedRoots {
  param([Parameter(Mandatory = $true)][string]$Value)

  if ([string]::IsNullOrWhiteSpace($Value)) {
    throw 'AllowedRoots must contain at least one existing directory.'
  }
  $resolvedRoots = [Collections.Generic.List[string]]::new()
  foreach ($candidate in $Value.Split(';')) {
    if ([string]::IsNullOrWhiteSpace($candidate)) {
      throw 'AllowedRoots contains an empty path.'
    }
    $resolved = Resolve-Path -LiteralPath $candidate.Trim() -ErrorAction Stop
    if ($resolved.Provider.Name -ne 'FileSystem' -or
        -not (Test-Path -LiteralPath $resolved.ProviderPath -PathType Container)) {
      throw "Allowed root is not an existing filesystem directory: $candidate"
    }
    $resolvedRoots.Add($resolved.ProviderPath)
  }
  return ($resolvedRoots | Select-Object -Unique) -join ';'
}

function Get-ByteSha256Hex {
  param([Parameter(Mandatory = $true)][byte[]]$Bytes)

  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha256.ComputeHash($Bytes))).Replace('-', '')
  } finally {
    $sha256.Dispose()
  }
}

function Install-McpServerIcon {
  param(
    [Parameter(Mandatory = $true)][string]$ResolvedProjectPath,
    [Parameter(Mandatory = $true)][string]$LauncherDirectory
  )

  $sourcePath = Join-Path $ResolvedProjectPath 'scripts\McpServerIcon.png.base64'
  if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
    throw "MCP Server icon source was not found: $sourcePath"
  }
  try {
    $pngBytes = [Convert]::FromBase64String((Get-Content -LiteralPath $sourcePath -Raw).Trim())
  } catch {
    throw 'MCP Server icon source is not valid Base64.'
  }

  $expectedPngSha256 = 'CDB4785CA8EA328B1E88B50B67D12E0A3D86D4039664C1F93BFEDBB2BE63CA46'
  if ((Get-ByteSha256Hex -Bytes $pngBytes) -ne $expectedPngSha256) {
    throw 'MCP Server icon source does not match the approved PNG.'
  }
  if ($pngBytes.Length -lt 24 -or
      $pngBytes[0] -ne 0x89 -or $pngBytes[1] -ne 0x50 -or
      $pngBytes[2] -ne 0x4E -or $pngBytes[3] -ne 0x47 -or
      $pngBytes[16] -ne 0 -or $pngBytes[17] -ne 0 -or
      $pngBytes[18] -ne 0 -or $pngBytes[19] -ne 180 -or
      $pngBytes[20] -ne 0 -or $pngBytes[21] -ne 0 -or
      $pngBytes[22] -ne 0 -or $pngBytes[23] -ne 180) {
    throw 'MCP Server icon source must be the approved 180 by 180 PNG.'
  }

  $stream = [IO.MemoryStream]::new()
  $writer = [IO.BinaryWriter]::new($stream)
  try {
    # ICO header followed by one PNG-backed 180x180, 32-bit image entry.
    $writer.Write([uint16]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]1)
    $writer.Write([byte]180)
    $writer.Write([byte]180)
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]32)
    $writer.Write([uint32]$pngBytes.Length)
    $writer.Write([uint32]22)
    $writer.Write($pngBytes)
    $writer.Flush()
    $iconBytes = $stream.ToArray()
  } finally {
    $writer.Dispose()
    $stream.Dispose()
  }

  $iconPath = Join-Path $LauncherDirectory 'MCP Server.ico'
  $changed = $true
  if (Test-Path -LiteralPath $iconPath -PathType Leaf) {
    $changed = (Get-ByteSha256Hex -Bytes ([IO.File]::ReadAllBytes($iconPath))) -ne
      (Get-ByteSha256Hex -Bytes $iconBytes)
  }
  if ($changed) {
    [IO.File]::WriteAllBytes($iconPath, $iconBytes)
  }
  return [pscustomobject]@{
    Path = (Resolve-Path -LiteralPath $iconPath).ProviderPath
    Changed = $changed
  }
}

function Install-McpServerLauncher {
  param([Parameter(Mandatory = $true)][string]$ResolvedProjectPath)

  $sourcePath = Join-Path $ResolvedProjectPath 'scripts\McpServerLauncher.cs'
  if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
    throw "MCP Server launcher source was not found: $sourcePath"
  }

  $localAppData = [Environment]::GetFolderPath(
    [Environment+SpecialFolder]::LocalApplicationData
  )
  if ([string]::IsNullOrWhiteSpace($localAppData)) {
    throw 'Windows LocalApplicationData is unavailable for the MCP Server launcher.'
  }
  $launcherDirectory = Join-Path $localAppData 'Biotele Codex MCP'
  $launcherPath = Join-Path $launcherDirectory 'MCP Server.exe'
  New-Item -ItemType Directory -Path $launcherDirectory -Force | Out-Null
  $icon = Install-McpServerIcon `
    -ResolvedProjectPath $ResolvedProjectPath `
    -LauncherDirectory $launcherDirectory

  $compilerCandidates = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
  )
  $compiler = $compilerCandidates |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
    Select-Object -First 1
  if (-not $compiler) {
    throw 'The Windows .NET Framework C# compiler is required to build MCP Server.exe.'
  }

  $needsBuild = $icon.Changed -or -not (Test-Path -LiteralPath $launcherPath -PathType Leaf)
  if (-not $needsBuild) {
    $needsBuild = (Get-Item -LiteralPath $sourcePath).LastWriteTimeUtc -gt
      (Get-Item -LiteralPath $launcherPath).LastWriteTimeUtc
  }
  if ($needsBuild) {
    & $compiler /nologo /target:winexe /optimize+ "/win32icon:$($icon.Path)" "/out:$launcherPath" $sourcePath
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
      throw 'Failed to build MCP Server.exe. Stop the scheduled agent if the launcher is in use, then retry.'
    }
  }
  return (Resolve-Path -LiteralPath $launcherPath).ProviderPath
}

$ProjectPath = (Resolve-Path -LiteralPath $ProjectPath -ErrorAction Stop).ProviderPath

if (-not $PSBoundParameters.ContainsKey('AllowedRoots')) {
  $storedAllowedRoots = [Environment]::GetEnvironmentVariable('CODEX_ALLOWED_ROOTS', 'User')
  $AllowedRoots = if ([string]::IsNullOrWhiteSpace($storedAllowedRoots)) {
    $ProjectPath
  } else {
    $storedAllowedRoots
  }
}
$AllowedRoots = Resolve-AllowedRoots -Value $AllowedRoots

$agentSecret = [Environment]::GetEnvironmentVariable('BIOTELE_RELAY_AGENT_SECRET', 'User')
if ([string]::IsNullOrWhiteSpace($agentSecret)) {
  $agentSecret = Read-SecretText -Prompt 'Agent HMAC secret (32+ bytes; input hidden)'
}
if ([Text.Encoding]::UTF8.GetByteCount($agentSecret) -lt 32) {
  throw 'Agent secret must contain at least 32 UTF-8 bytes.'
}

$nativeCodex = Resolve-NativeCodex -ExplicitPath $CodexBin
$nodeExecutable = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
$mcpServerLauncher = Install-McpServerLauncher -ResolvedProjectPath $ProjectPath
$agentFile = Join-Path $ProjectPath 'src\local-agent.mjs'
if (-not (Test-Path -LiteralPath $agentFile -PathType Leaf)) {
  throw "Local agent entrypoint was not found: $agentFile"
}
$appServerArgs = ConvertTo-Json -Compress -InputObject @(
  '-c'
  'mcp_servers.codex-supervisor.enabled=false'
  '-c'
  'approvals_reviewer="user"'
  'app-server'
)
$configuration = [ordered]@{
  BIOTELE_RELAY_BASE_URL = $RelayBaseUrl
  BIOTELE_RELAY_AGENT_KEY_ID = $AgentKeyId
  BIOTELE_RELAY_AGENT_SECRET = $agentSecret
  CODEX_ALLOWED_ROOTS = $AllowedRoots
  CODEX_ALLOW_NETWORK = '0'
  CODEX_BIN = $nativeCodex
  CODEX_APP_SERVER_ARGS = $appServerArgs
}
foreach ($entry in $configuration.GetEnumerator()) {
  [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'User')
  [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
}

Write-Host 'Stored local-agent environment variables for the current Windows user.'
Write-Host 'Secret values were not printed.'

if ($RegisterScheduledTask) {
  $launcherArguments = '"{0}" "{1}" "{2}"' -f $nodeExecutable, $agentFile, $ProjectPath
  $action = New-ScheduledTaskAction `
    -Execute $mcpServerLauncher `
    -Argument $launcherArguments `
    -WorkingDirectory $ProjectPath
  $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
  $settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
  try {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Outbound-only Biotele MCP relay local agent' -Force -ErrorAction Stop | Out-Null
  } catch {
    if ($_.Exception.Message -match 'Access is denied') {
      throw 'Scheduled task registration was denied. Re-run this installer from an Administrator PowerShell; the task itself remains least-privilege.'
    }
    throw
  }
  Write-Host "Registered scheduled task: $TaskName"
  Write-Host "Controlled handoff: close any manual agent, then run Stop-ScheduledTask -TaskName '$TaskName'; Start-ScheduledTask -TaskName '$TaskName'."
}

$manualProjectPath = $ProjectPath.Replace("'", "''")
$manualNodePath = $nodeExecutable.Replace("'", "''")
$manualAgentPath = $agentFile.Replace("'", "''")
$manualLauncherPath = $mcpServerLauncher.Replace("'", "''")
Write-Host "Start manually with: Set-Location -LiteralPath '$manualProjectPath'; & '$manualLauncherPath' '$manualNodePath' '$manualAgentPath' '$manualProjectPath'"
