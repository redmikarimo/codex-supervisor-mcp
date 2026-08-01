param(
  [string]$ProjectPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path,
  [string]$RelayBaseUrl = 'https://mcp.biotele.mx',
  [string]$AgentKeyId = 'windows-agent-1',
  [string]$AllowedRoots,
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

if (-not $AllowedRoots) {
  $AllowedRoots = $ProjectPath
}

$agentSecret = Read-SecretText -Prompt 'Agent HMAC secret (32+ bytes; input hidden)'
if ([Text.Encoding]::UTF8.GetByteCount($agentSecret) -lt 32) {
  throw 'Agent secret must contain at least 32 UTF-8 bytes.'
}

[Environment]::SetEnvironmentVariable('BIOTELE_RELAY_BASE_URL', $RelayBaseUrl, 'User')
[Environment]::SetEnvironmentVariable('BIOTELE_RELAY_AGENT_KEY_ID', $AgentKeyId, 'User')
[Environment]::SetEnvironmentVariable('BIOTELE_RELAY_AGENT_SECRET', $agentSecret, 'User')
[Environment]::SetEnvironmentVariable('CODEX_ALLOWED_ROOTS', $AllowedRoots, 'User')
[Environment]::SetEnvironmentVariable('CODEX_ALLOW_NETWORK', '0', 'User')

Write-Host 'Stored local-agent environment variables for the current Windows user.'
Write-Host 'Secret values were not printed.'

if ($RegisterScheduledTask) {
  $escapedProjectPath = $ProjectPath.Replace("'", "''")
  $agentPath = (Join-Path $ProjectPath 'src\local-agent.mjs').Replace("'", "''")
  $nodePath = (Get-Command node.exe -ErrorAction Stop).Source.Replace("'", "''")
  $startupScript = @"
`$ErrorActionPreference = 'Stop'
`$requiredEnvironment = @(
  'BIOTELE_RELAY_BASE_URL',
  'BIOTELE_RELAY_AGENT_KEY_ID',
  'BIOTELE_RELAY_AGENT_SECRET',
  'CODEX_ALLOWED_ROOTS',
  'CODEX_ALLOW_NETWORK'
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
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
  try {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Description 'Outbound-only Biotele MCP relay local agent' -Force | Out-Null
  } catch {
    if ($_.Exception.Message -match 'Access is denied') {
      throw 'Scheduled task registration was denied. Re-run this installer from an Administrator PowerShell; the task itself remains least-privilege.'
    }
    throw
  }
  Write-Host "Registered scheduled task: $TaskName"
}

Write-Host 'Start manually with: npm run start:local-agent'
