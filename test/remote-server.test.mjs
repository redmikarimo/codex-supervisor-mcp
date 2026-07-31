import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("remote server requires authentication by default and binds to loopback", () => {
  const source = fs.readFileSync(new URL("../src/remote-server.mjs", import.meta.url), "utf8");
  assert.match(source, /CODEX_REMOTE_AUTH_MODE \?\? "bearer"/);
  assert.match(source, /CODEX_REMOTE_HOST \?\? "127\.0\.0\.1"/);
  assert.match(source, /CODEX_ALLOWED_ROOTS/);
  assert.match(source, /timingSafeStringEqual/);
});

test("remote server exposes MCP initialize, tools list, and tool call methods", () => {
  const source = fs.readFileSync(new URL("../src/remote-server.mjs", import.meta.url), "utf8");
  assert.match(source, /case "initialize"/);
  assert.match(source, /case "tools\/list"/);
  assert.match(source, /case "tools\/call"/);
});
