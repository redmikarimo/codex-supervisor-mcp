import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AppServerClient,
  assertSafeAppServerCommand,
  sanitizeAppServerEnvironment,
} from "../src/app-server-client.mjs";
import { EventStore } from "../src/event-store.mjs";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const mockServer = path.join(currentDirectory, "mock-codex-app-server.mjs");

test("AppServerClient streams completion and resolves approvals", async (t) => {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), "codex-supervisor-client-"));
  t.after(async () => {
    await fs.rm(repository, { recursive: true, force: true });
  });

  const eventStore = new EventStore();
  const client = new AppServerClient({
    command: process.execPath,
    args: [mockServer],
    eventStore,
    requestTimeoutMs: 5_000,
  });
  t.after(async () => {
    await client.stop();
  });

  const threadResult = await client.request("thread/start", { cwd: repository });
  const threadId = threadResult.thread.id;
  const firstCursor = eventStore.sequence;
  const turnResult = await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "finish normally" }],
  });

  assert.match(turnResult.turn.id, /^turn-/);
  const completed = await eventStore.waitFor(threadId, {
    afterSequence: firstCursor,
    timeoutMs: 2_000,
  });
  assert.equal(completed.reason, "completed");
  assert.match(completed.latestAgentMessage, /Completed: finish normally/);

  const approvalCursor = eventStore.sequence;
  const approvalTurn = await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "needs approval" }],
  });
  assert.match(approvalTurn.turn.id, /^turn-/);

  const requested = await eventStore.waitFor(threadId, {
    afterSequence: approvalCursor,
    timeoutMs: 2_000,
  });
  assert.equal(requested.reason, "request");
  assert.equal(requested.pendingRequests.length, 1);

  const approval = requested.pendingRequests[0];
  const resolutionCursor = eventStore.sequence;
  await client.resolveServerRequest(approval.requestKey, { decision: "accept" });

  const approved = await eventStore.waitFor(threadId, {
    afterSequence: resolutionCursor,
    timeoutMs: 2_000,
  });
  assert.equal(approved.reason, "completed");
  assert.match(approved.latestDiff.preview ?? approved.latestDiff, /needs approval/);

  const description = client.describe();
  assert.equal(description.state, "ready");
  assert.equal(description.loadedThreadCount, 1);
  assert.equal("command" in description, false);
  assert.equal("args" in description, false);
  assert.equal("stderrTail" in description, false);
});

test("AppServerClient strips relay credentials from the child environment", () => {
  const source = {
    PATH: "C:\\Windows",
    CODEX_ALLOWED_ROOTS: "C:\\repo",
    BIOTELE_RELAY_AGENT_SECRET: "secret-value",
    biotele_other: "mixed-case-secret",
    CODEX_REMOTE_BEARER_TOKEN: "remote-secret",
    Codex_Remote_Other: "mixed-remote-secret",
  };

  const sanitized = sanitizeAppServerEnvironment(source);
  assert.deepEqual(sanitized, {
    PATH: "C:\\Windows",
    CODEX_ALLOWED_ROOTS: "C:\\repo",
  });
  assert.equal(source.BIOTELE_RELAY_AGENT_SECRET, "secret-value");
  assert.notEqual(sanitized, source);
});

test("AppServerClient rejects shell shims and keeps native executables", () => {
  for (const command of ["codex.cmd", "CODEX.BAT", "C:\\tools\\codex.ps1"]) {
    assert.throws(() => assertSafeAppServerCommand(command), /native executable/);
    assert.throws(
      () => new AppServerClient({ command, args: [] }),
      /native executable/,
    );
  }
  assert.equal(assertSafeAppServerCommand("codex"), "codex");
  assert.equal(assertSafeAppServerCommand(process.execPath), process.execPath);
});
