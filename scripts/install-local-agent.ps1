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
  $command = "Set-Location -LiteralPath '$escapedProjectPath'; npm run start:local-agent"
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -Command `"$command`""
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel LeastPrivilege
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Description 'Outbound-only Biotele MCP relay local agent' -Force | Out-Null
  Write-Host "Registered scheduled task: $TaskName"
}

Write-Host 'Start manually with: npm run start:local-agent'
