import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const installerUrl = new URL("../scripts/install-local-agent.ps1", import.meta.url);

test("local-agent installer registers a least-privilege Windows task", async () => {
  const installer = await readFile(installerUrl, "utf8");

  assert.match(installer, /New-ScheduledTaskPrincipal[^\r\n]+-RunLevel Limited/);
  assert.doesNotMatch(installer, /-RunLevel LeastPrivilege/);
  assert.doesNotMatch(installer, /BIOTELE_RELAY_AGENT_SECRET[^\r\n]+New-ScheduledTaskAction/);
  assert.match(installer, /GetEnvironmentVariable\(`\$name, 'User'\)/);
  assert.match(installer, /-WindowStyle Hidden[^\r\n]+-EncodedCommand/);
  assert.match(installer, /New-ScheduledTaskSettingsSet[^\r\n]+-RestartCount 3[^\r\n]+-RestartInterval/);
  assert.match(installer, /Register-ScheduledTask[^\r\n]+-Settings \$settings/);
  assert.match(installer, /Scheduled task registration was denied/);
  assert.match(installer, /\[string\]\$CodexBin/);
  assert.match(installer, /Get-Command codex\.exe -CommandType Application/);
  assert.match(installer, /Get-Command codex -All/);
  assert.match(installer, /codex-win32-\*/);
  assert.match(installer, /GetFileName\([^\r\n]+\) -ine 'codex\.exe'/);
  assert.match(installer, /native codex\.exe, not a \.cmd, \.bat, or \.ps1 shell shim/);
  assert.match(installer, /SetEnvironmentVariable\(\$entry\.Key, \$entry\.Value, 'User'\)/);
  assert.match(installer, /SetEnvironmentVariable\(\$entry\.Key, \$entry\.Value, 'Process'\)/);
  assert.match(installer, /CODEX_BIN = \$nativeCodex/);
  assert.match(installer, /CODEX_APP_SERVER_ARGS = \$appServerArgs/);
  assert.match(installer, /'CODEX_BIN',[\s\S]+?'CODEX_APP_SERVER_ARGS'/);
  assert.match(installer, /mcp_servers\.codex-supervisor\.enabled=false/);
  assert.match(installer, /PSBoundParameters\.ContainsKey\('AllowedRoots'\)/);
  assert.match(installer, /GetEnvironmentVariable\('CODEX_ALLOWED_ROOTS', 'User'\)/);
  assert.match(installer, /GetEnvironmentVariable\('BIOTELE_RELAY_AGENT_SECRET', 'User'\)/);
  assert.match(installer, /Resolve-AllowedRoots -Value \$AllowedRoots/);
  assert.match(installer, /AllowedRoots must contain at least one existing directory/);
  assert.match(installer, /WindowsIdentity\]::GetCurrent\(\)\.Name/);
  assert.match(installer, /New-ScheduledTaskTrigger -AtLogOn -User \$currentUser/);
  assert.match(installer, /-ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/);
  assert.match(installer, /-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries/);
  assert.match(installer, /Controlled handoff/);
  assert.match(installer, /Start manually with: Set-Location -LiteralPath/);
});
