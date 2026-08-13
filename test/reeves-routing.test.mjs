import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_AGENT_ROUTE,
  REEVES_AGENT_ROUTE,
  REEVES_TOOL_DEFINITIONS,
} from "../src/agent-routing.mjs";
import { createHostingerRelayServer } from "../src/hostinger-relay-server.mjs";
import { signRequest } from "../src/relay-auth.mjs";
import { RelayQueue } from "../src/relay-queue.mjs";
import { TOOL_DEFINITIONS } from "../src/tool-registry.mjs";

const WINDOWS_KEY_ID = "windows-agent-1";
const WINDOWS_SECRET = "windows-agent-secret-0123456789-abcdef";
const REEVES_KEY_ID = "reeves-android-1";
const REEVES_SECRET = "reeves-agent-secret-0123456789-abcdefg";
const READ_SCOPE = "biotele.mcp.read";
const WRITE_SCOPE = "biotele.mcp.write";

const oauth = {
  async verifyRequest(req) {
    const authorization = String(req.headers.authorization ?? "");
    if (!authorization.startsWith("Bearer ")) {
      throw Object.assign(new Error("Missing bearer token."), { code: "invalid_token" });
    }
    return {
      subject: authorization.slice("Bearer ".length),
      scopes: new Set(
        authorization === "Bearer read-only"
          ? [READ_SCOPE]
          : [READ_SCOPE, WRITE_SCOPE],
      ),
    };
  },
  async protectedResourceMetadata() {
    return {};
  },
};

async function withRelay(t, queue = new RelayQueue()) {
  const server = createHostingerRelayServer({
    env: {
      BIOTELE_RELAY_OWNER_KEY_SECRET: "reeves-routing-owner-key-secret-0123456789",
    },
    queue,
    agentCredentials: new Map([
      [WINDOWS_KEY_ID, WINDOWS_SECRET],
      [REEVES_KEY_ID, REEVES_SECRET],
    ]),
    oauthResourceServer: oauth,
    artifactStore: { ready: Promise.resolve() },
    logger: { write() {} },
    autoInitialize: false,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  assert.equal((await server.initialize()).status, "ready");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function withSplitCredentialRelay(t, queue = new RelayQueue()) {
  const server = createHostingerRelayServer({
    env: {
      BIOTELE_RELAY_AGENT_KEY_ID: WINDOWS_KEY_ID,
      BIOTELE_RELAY_AGENT_SECRET: WINDOWS_SECRET,
      BIOTELE_RELAY_REEVES_AGENT_KEY_ID: REEVES_KEY_ID,
      BIOTELE_RELAY_REEVES_AGENT_SECRET: REEVES_SECRET,
      BIOTELE_RELAY_OWNER_KEY_SECRET: "reeves-routing-owner-key-secret-0123456789",
    },
    queue,
    oauthResourceServer: oauth,
    artifactStore: { ready: Promise.resolve() },
    logger: { write() {} },
    autoInitialize: false,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  assert.equal((await server.initialize()).status, "ready");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function mcpPost(baseUrl, token, body, sessionId = undefined) {
  return await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function initialize(baseUrl, token = "reeves-routing-user") {
  const response = await mcpPost(baseUrl, token, {
    jsonrpc: "2.0",
    id: "initialize",
    method: "initialize",
    params: { protocolVersion: "2025-11-25" },
  });
  assert.equal(response.status, 200);
  return { token, sessionId: response.headers.get("mcp-session-id") };
}

async function agentPost(baseUrl, keyId, secret, path, bodyObject) {
  const body = JSON.stringify(bodyObject);
  const signed = signRequest({ method: "POST", path, body, keyId, secret });
  return await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...signed.headers },
    body,
  });
}

test("Reeves schemas are strict and correctly annotated", () => {
  assert.deepEqual(
    REEVES_TOOL_DEFINITIONS.map((tool) => tool.name),
    [
      "reeves_status",
      "reeves_tap",
      "reeves_swipe",
      "reeves_type",
      "reeves_back",
      "reeves_home",
      "reeves_recents",
      "reeves_screenshot",
    ],
  );
  for (const tool of REEVES_TOOL_DEFINITIONS) {
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.annotations.openWorldHint, tool.name !== "reeves_status" && tool.name !== "reeves_screenshot");
  }
  assert.equal(REEVES_TOOL_DEFINITIONS[0].annotations.readOnlyHint, true);
  assert.equal(REEVES_TOOL_DEFINITIONS.at(-1).annotations.readOnlyHint, true);
  for (const tool of REEVES_TOOL_DEFINITIONS.slice(1, -1)) {
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.equal(tool.annotations.destructiveHint, true);
  }
  assert.ok(TOOL_DEFINITIONS.every((tool) => tool.name.startsWith("codex_")));
});

test("authenticated agent routes can claim only their tool namespace", () => {
  const queue = new RelayQueue();
  const codex = queue.enqueue({ toolName: "codex_status", arguments: {} });
  const reeves = queue.enqueue({ toolName: "reeves_status", arguments: {} });

  const windowsClaim = queue.claim({ leaseOwner: WINDOWS_KEY_ID, agentRoute: CODEX_AGENT_ROUTE });
  const reevesClaim = queue.claim({ leaseOwner: REEVES_KEY_ID, agentRoute: REEVES_AGENT_ROUTE });
  assert.equal(windowsClaim.id, codex.id);
  assert.equal(reevesClaim.id, reeves.id);

  assert.throws(
    () => queue.complete({
      jobId: reevesClaim.id,
      leaseId: reevesClaim.leaseId,
      leaseOwner: WINDOWS_KEY_ID,
      result: { ok: false },
    }),
    /another agent identity/,
  );
  queue.complete({
    jobId: reevesClaim.id,
    leaseId: reevesClaim.leaseId,
    leaseOwner: REEVES_KEY_ID,
    result: { ok: true },
  });
});

test("wrong-route claims cannot take queued or expired-lease work", () => {
  let now = 1_000;
  const queue = new RelayQueue({ jobTtlMs: 10_000, leaseMs: 100, now: () => now });
  const reeves = queue.enqueue({ toolName: "reeves_tap", arguments: { x: 1, y: 2 } });

  assert.equal(queue.claim({ leaseOwner: WINDOWS_KEY_ID, agentRoute: CODEX_AGENT_ROUTE }), null);
  const first = queue.claim({ leaseOwner: REEVES_KEY_ID, agentRoute: REEVES_AGENT_ROUTE });
  assert.equal(first.id, reeves.id);
  now += 101;
  assert.equal(queue.claim({ leaseOwner: WINDOWS_KEY_ID, agentRoute: CODEX_AGENT_ROUTE }), null);
  const second = queue.claim({ leaseOwner: REEVES_KEY_ID, agentRoute: REEVES_AGENT_ROUTE });
  assert.equal(second.id, reeves.id);
  assert.equal(second.deliveryCount, 2);

  const codexOnly = new RelayQueue();
  const codex = codexOnly.enqueue({ toolName: "codex_status", arguments: {} });
  assert.equal(
    codexOnly.claim({ leaseOwner: REEVES_KEY_ID, agentRoute: REEVES_AGENT_ROUTE }),
    null,
  );
  assert.equal(
    codexOnly.claim({ leaseOwner: WINDOWS_KEY_ID, agentRoute: CODEX_AGENT_ROUTE }).id,
    codex.id,
  );
});

test("long-poll waiters remain pending until work for their authenticated route arrives", async () => {
  const queue = new RelayQueue();
  const windowsWait = queue.waitForClaimable({
    timeoutMs: 1_000,
    leaseOwner: WINDOWS_KEY_ID,
    agentRoute: CODEX_AGENT_ROUTE,
  });
  const reevesWait = queue.waitForClaimable({
    timeoutMs: 1_000,
    leaseOwner: REEVES_KEY_ID,
    agentRoute: REEVES_AGENT_ROUTE,
  });

  const reeves = queue.enqueue({ toolName: "reeves_home", arguments: {} });
  assert.equal((await reevesWait).id, reeves.id);
  const codex = queue.enqueue({ toolName: "codex_status", arguments: {} });
  assert.equal((await windowsWait).id, codex.id);
});

test("routed jobs retain normal expiry behavior", async () => {
  let now = 1_000;
  const queue = new RelayQueue({ jobTtlMs: 100, leaseMs: 50, now: () => now });
  const job = queue.enqueue({ toolName: "reeves_screenshot", arguments: {} });
  const outcome = queue.waitForResult(job, { timeoutMs: 1_000 });
  now += 101;
  assert.equal(queue.size, 0);
  assert.equal((await outcome).error.type, "RelayExpired");
});

test("hosted tools/list exposes Codex and Reeves while Reeves calls route only to Reeves", async (t) => {
  const queue = new RelayQueue();
  const baseUrl = await withRelay(t, queue);
  const { token, sessionId } = await initialize(baseUrl);

  const listResponse = await mcpPost(baseUrl, token, {
    jsonrpc: "2.0",
    id: "list",
    method: "tools/list",
  }, sessionId);
  const names = (await listResponse.json()).result.tools.map((tool) => tool.name);
  assert.ok(names.includes("codex_status"));
  assert.ok(names.includes("reeves_status"));
  assert.ok(names.includes("reeves_screenshot"));

  const callPromise = mcpPost(baseUrl, token, {
    jsonrpc: "2.0",
    id: "tap",
    method: "tools/call",
    params: { name: "reeves_tap", arguments: { x: 40, y: 80 } },
  }, sessionId);

  const windowsClaim = await agentPost(
    baseUrl,
    WINDOWS_KEY_ID,
    WINDOWS_SECRET,
    "/agent/jobs/claim",
    { maxWaitMs: 0, route: REEVES_AGENT_ROUTE },
  );
  assert.equal(windowsClaim.status, 204);

  const reevesClaimResponse = await agentPost(
    baseUrl,
    REEVES_KEY_ID,
    REEVES_SECRET,
    "/agent/jobs/claim",
    { maxWaitMs: 100 },
  );
  assert.equal(reevesClaimResponse.status, 200);
  const { job } = await reevesClaimResponse.json();
  assert.equal(job.toolName, "reeves_tap");
  assert.deepEqual(job.arguments, { x: 40, y: 80 });

  const wrongResult = await agentPost(
    baseUrl,
    WINDOWS_KEY_ID,
    WINDOWS_SECRET,
    "/agent/jobs/result",
    { jobId: job.id, leaseId: job.leaseId, result: { ok: false } },
  );
  assert.equal(wrongResult.status, 409);

  const rightResult = await agentPost(
    baseUrl,
    REEVES_KEY_ID,
    REEVES_SECRET,
    "/agent/jobs/result",
    { jobId: job.id, leaseId: job.leaseId, result: { ok: true } },
  );
  assert.equal(rightResult.status, 202);
  assert.equal((await callPromise).status, 200);
});

test("split Windows and Reeves environment credentials authenticate independently", async (t) => {
  const queue = new RelayQueue();
  const baseUrl = await withSplitCredentialRelay(t, queue);
  queue.enqueue({ toolName: "codex_status", arguments: {} });
  queue.enqueue({ toolName: "reeves_status", arguments: {} });

  const windows = await agentPost(
    baseUrl,
    WINDOWS_KEY_ID,
    WINDOWS_SECRET,
    "/agent/jobs/claim",
    { maxWaitMs: 0 },
  );
  assert.equal((await windows.json()).job.toolName, "codex_status");

  const reeves = await agentPost(
    baseUrl,
    REEVES_KEY_ID,
    REEVES_SECRET,
    "/agent/jobs/claim",
    { maxWaitMs: 0 },
  );
  assert.equal((await reeves.json()).job.toolName, "reeves_status");
});

test("Reeves status is read-scoped and device actions require write scope", async (t) => {
  const queue = new RelayQueue();
  const baseUrl = await withRelay(t, queue);
  const { sessionId } = await initialize(baseUrl, "read-only");

  const denied = await mcpPost(baseUrl, "read-only", {
    jsonrpc: "2.0",
    id: "tap-denied",
    method: "tools/call",
    params: { name: "reeves_tap", arguments: { x: 1, y: 2 } },
  }, sessionId);
  assert.equal((await denied.json()).error.data.requiredScope, WRITE_SCOPE);
  assert.equal(queue.size, 0);

  const statusCall = mcpPost(baseUrl, "read-only", {
    jsonrpc: "2.0",
    id: "status-allowed",
    method: "tools/call",
    params: { name: "reeves_status", arguments: {} },
  }, sessionId);
  const claim = await agentPost(
    baseUrl,
    REEVES_KEY_ID,
    REEVES_SECRET,
    "/agent/jobs/claim",
    { maxWaitMs: 100 },
  );
  const { job } = await claim.json();
  assert.equal(job.toolName, "reeves_status");
  await agentPost(
    baseUrl,
    REEVES_KEY_ID,
    REEVES_SECRET,
    "/agent/jobs/result",
    { jobId: job.id, leaseId: job.leaseId, result: { status: "ok" } },
  );
  assert.equal((await statusCall).status, 200);
});
