import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const installerUrl = new URL("../scripts/install-local-agent.ps1", import.meta.url);
const launcherUrl = new URL("../scripts/McpServerLauncher.cs", import.meta.url);
const iconSourceUrl = new URL("../scripts/McpServerIcon.png.base64", import.meta.url);

test("local-agent installer registers a least-privilege Windows task", async () => {
  const installer = await readFile(installerUrl, "utf8");

  assert.match(installer, /New-ScheduledTaskPrincipal[^\r\n]+-RunLevel Limited/);
  assert.doesNotMatch(installer, /-RunLevel LeastPrivilege/);
  assert.doesNotMatch(installer, /BIOTELE_RELAY_AGENT_SECRET[^\r\n]+New-ScheduledTaskAction/);
  assert.match(installer, /New-ScheduledTaskAction\s+`[\s\S]+?-Execute \$mcpServerLauncher/);
  assert.match(installer, /-Argument \$launcherArguments/);
  assert.doesNotMatch(installer, /New-ScheduledTaskAction[^\r\n]+powershell\.exe/i);
  assert.doesNotMatch(installer, /EncodedCommand/);
  assert.match(installer, /New-ScheduledTaskSettingsSet[^\r\n]+-RestartCount 3[^\r\n]+-RestartInterval/);
  assert.match(installer, /Register-ScheduledTask[^\r\n]+-Settings \$settings/);
  assert.match(installer, /Register-ScheduledTask[^\r\n]+-ErrorAction Stop/);
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
  assert.match(installer, /mcp_servers\.codex-supervisor\.enabled=false/);
  assert.match(
    installer,
    /'mcp_servers\.codex-supervisor\.enabled=false'[\s\S]+?'-c'[\s\S]+?'approvals_reviewer="user"'[\s\S]+?'app-server'/,
  );
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
  assert.match(installer, /Install-McpServerLauncher/);
  assert.match(installer, /Install-McpServerIcon/);
  assert.match(installer, /'MCP Server\.exe'/);
  assert.match(installer, /\/target:winexe/);
  assert.match(installer, /\/win32icon:\$\(\$icon\.Path\)/);
  assert.match(installer, /CDB4785CA8EA328B1E88B50B67D12E0A3D86D4039664C1F93BFEDBB2BE63CA46/);
});

test("MCP Server launcher loads HKCU settings and kills its hidden Node child on exit", async () => {
  const launcher = await readFile(launcherUrl, "utf8");

  assert.match(launcher, /AssemblyTitle\("MCP Server"\)/);
  assert.match(launcher, /AssemblyProduct\("MCP Server"\)/);
  assert.match(launcher, /JobObjectLimitKillOnJobClose\s*=\s*0x00002000/);
  assert.match(launcher, /AssignProcessToJobObject/);
  assert.match(launcher, /CreateNoWindow\s*=\s*true/);
  assert.match(launcher, /Registry\.CurrentUser\.OpenSubKey\("Environment", false\)/);
  assert.match(launcher, /EnvironmentVariableTarget\.Process/);
  assert.match(launcher, /BIOTELE_RELAY_AGENT_SECRET/);
  assert.match(launcher, /LoadRequiredUserEnvironment\(\);[\s\S]+?Process\.Start/);
  assert.doesNotMatch(launcher, /Console\.(?:Error\.)?WriteLine\([^\r\n]*value/);
});

test("MCP Server icon source is the exact approved PNG", async () => {
  const encoded = (await readFile(iconSourceUrl, "utf8")).replace(/\s/g, "");
  const png = Buffer.from(encoded, "base64");

  assert.equal(png.length, 5_850);
  assert.equal(
    createHash("sha256").update(png).digest("hex").toUpperCase(),
    "CDB4785CA8EA328B1E88B50B67D12E0A3D86D4039664C1F93BFEDBB2BE63CA46",
  );
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(png.readUInt32BE(16), 180);
  assert.equal(png.readUInt32BE(20), 180);
});
