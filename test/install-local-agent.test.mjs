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
});
