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
$agentFile = Join-Path $ProjectPath 'src\local-agent.mjs'
if (-not (Test-Path -LiteralPath $agentFile -PathType Leaf)) {
  throw "Local agent entrypoint was not found: $agentFile"
}
$appServerArgs = ConvertTo-Json -Compress -InputObject @(
  '-c'
  'mcp_servers.codex-supervisor.enabled=false'
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
  $escapedProjectPath = $ProjectPath.Replace("'", "''")
  $agentPath = $agentFile.Replace("'", "''")
  $nodePath = $nodeExecutable.Replace("'", "''")
  $startupScript = @"
`$ErrorActionPreference = 'Stop'
`$requiredEnvironment = @(
  'BIOTELE_RELAY_BASE_URL',
  'BIOTELE_RELAY_AGENT_KEY_ID',
  'BIOTELE_RELAY_AGENT_SECRET',
  'CODEX_ALLOWED_ROOTS',
  'CODEX_ALLOW_NETWORK',
  'CODEX_BIN',
  'CODEX_APP_SERVER_ARGS'
)
foreach (`$name in `$requiredEnvironment) {
  `$value = [Environment]::GetEnvironmentVariable(`$name, 'User')
  if ([string]::IsNullOrWhiteSpace(`$value)) {
    throw "Required user environment variable is missing: `$name"
  }
  [Environment]::SetEnvironmentVariable(`$name, `$value, 'Process')
}
Set-Location -LiteralPath '$escapedProjectPath'
& '$nodePath' '$agentPath'
exit `$LASTEXITCODE
"@
  $encodedStartup = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($startupScript))
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand $encodedStartup" -WorkingDirectory $ProjectPath
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
Write-Host "Start manually with: Set-Location -LiteralPath '$manualProjectPath'; & '$manualNodePath' '$manualAgentPath'"
