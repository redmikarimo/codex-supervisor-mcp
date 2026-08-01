import assert from "node:assert/strict";
import { generateKeyPairSync, sign as signJwtInput } from "node:crypto";
import http from "node:http";
import test from "node:test";

import {
  createHostingerRelayServer,
  requiredPort,
  startHostingerRelay,
} from "../src/hostinger-relay-server.mjs";
import { OAuthResourceServer } from "../src/oauth-resource-server.mjs";
import { signRequest } from "../src/relay-auth.mjs";
import { RelayQueue } from "../src/relay-queue.mjs";
import {
  RESULT_SUBMISSION_PROTOCOL,
  encodeResultSubmission,
} from "../src/relay-result-protocol.mjs";

const AGENT_KEY_ID = "windows-agent-1";
const AGENT_SECRET = "agent-secret-0123456789-0123456789";
const BASE64_AGENT_SECRET = Buffer.alloc(48, 0x5a).toString("base64");
const AUDIENCE = "https://mcp.biotele.mx/mcp";
const READ_SCOPE = "biotele.mcp.read";
const WRITE_SCOPE = "biotele.mcp.write";

function b64urlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function createRsaKey(kid) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    kid,
    privateKey,
    jwk: {
      ...publicKey.export({ format: "jwk" }),
      kid,
      alg: "RS256",
      use: "sig",
    },
  };
}

function mintJwt({
  issuer,
  audience = AUDIENCE,
  key,
  subject = "user-1",
  scope = READ_SCOPE,
  expiresInSeconds = 300,
  notBefore = undefined,
  algorithm = "RS256",
  overrideClaims = {},
}) {
  const now = Math.floor(Date.now() / 1_000);
  const header = {
    alg: algorithm,
    typ: "JWT",
    kid: key?.kid ?? "kid-1",
  };
  const claims = {
    iss: issuer,
    aud: audience,
    sub: subject,
    iat: now,
    exp: now + expiresInSeconds,
    ...(notBefore === undefined ? {} : { nbf: notBefore }),
    ...(scope === undefined ? {} : { scope }),
    ...overrideClaims,
  };
  const input = `${b64urlJson(header)}.${b64urlJson(claims)}`;
  if (algorithm !== "RS256") {
    return `${input}.unsigned`;
  }
  const signature = signJwtInput("RSA-SHA256", Buffer.from(input), key.privateKey).toString("base64url");
  return `${input}.${signature}`;
}

async function withIdentityProvider(t, { keys, rotatingKid = null } = {}) {
  let jwksRequests = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/.well-known/openid-configuration") {
      const { port } = server.address();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          issuer: `http://127.0.0.1:${port}`,
          jwks_uri: `http://127.0.0.1:${port}/jwks`,
        }),
      );
      return;
    }
    if (url.pathname === "/jwks") {
      jwksRequests += 1;
      const exposedKeys =
        rotatingKid && jwksRequests === 1
          ? keys.filter((key) => key.kid !== rotatingKid)
          : keys;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: exposedKeys.map((key) => key.jwk) }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  return {
    issuer: `http://127.0.0.1:${port}`,
    jwksRequests: () => jwksRequests,
  };
}

async function withRelay(t, {
  queue = new RelayQueue(),
  issuer,
  env = process.env,
} = {}) {
  const server = createHostingerRelayServer({
    env,
    queue,
    agentCredentials: new Map([[AGENT_KEY_ID, AGENT_SECRET]]),
    publicUrl: "https://mcp.biotele.mx",
    logger: { write() {} },
    oauthResourceServer: new OAuthResourceServer({
      issuer,
      audience: AUDIENCE,
      jwksCacheMs: 60_000,
      clockSkewSeconds: 0,
    }),
    autoInitialize: false,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const readiness = await server.initialize();
  assert.equal(readiness.status, "ready");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

async function withRawRelay(t, options = {}) {
  const server = createHostingerRelayServer({
    autoInitialize: false,
    ...options,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
  };
}

function validEnv({ agentSecret = AGENT_SECRET, issuer = "https://issuer.example" } = {}) {
  return {
    PORT: "0",
    BIOTELE_RELAY_PUBLIC_URL: "https://mcp.biotele.mx",
    BIOTELE_RELAY_OAUTH_REQUIRED: "true",
    BIOTELE_RELAY_OAUTH_ISSUER: issuer,
    BIOTELE_RELAY_OAUTH_AUDIENCE: AUDIENCE,
    BIOTELE_RELAY_OAUTH_READ_SCOPE: READ_SCOPE,
    BIOTELE_RELAY_OAUTH_WRITE_SCOPE: WRITE_SCOPE,
    BIOTELE_RELAY_AGENT_KEYS: JSON.stringify({
      [AGENT_KEY_ID]: agentSecret,
    }),
  };
}

function splitAgentEnv({ agentSecret = AGENT_SECRET, issuer = "https://issuer.example" } = {}) {
  const env = validEnv({ agentSecret, issuer });
  delete env.BIOTELE_RELAY_AGENT_KEYS;
  env.BIOTELE_RELAY_AGENT_KEY_ID = AGENT_KEY_ID;
  env.BIOTELE_RELAY_AGENT_SECRET = agentSecret;
  return env;
}

async function oauthPost(baseUrl, path, bodyObject, token) {
  return await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(bodyObject),
  });
}

async function agentSignedPost(
  baseUrl,
  path,
  bodyObject,
  overrides = {},
  extraHeaders = {},
) {
  const body = JSON.stringify(bodyObject);
  const signed = signRequest({
    method: "POST",
    path,
    body,
    keyId: AGENT_KEY_ID,
    secret: AGENT_SECRET,
    ...overrides,
  });
  return await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...signed.headers,
      ...extraHeaders,
    },
    body,
  });
}

test("relay listen path does not wait for initialization or OAuth discovery", async (t) => {
  let releaseInitialization;
  const blocker = new Promise((resolve) => {
    releaseInitialization = resolve;
  });
  const { server, baseUrl } = await withRawRelay(t, {
    env: validEnv(),
    logger: { write() {} },
    initializeBlocker: () => blocker,
  });
  const initializePromise = server.initialize();
  const response = await fetch(`${baseUrl}/readyz`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { status: "initializing" });
  releaseInitialization();
  const readiness = await initializePromise;
  assert.equal(readiness.status, "ready");
});

test("/readyz returns 200 after initialization", async (t) => {
  const { server, baseUrl } = await withRawRelay(t, {
    env: validEnv(),
    logger: { write() {} },
  });
  await server.initialize();
  const response = await fetch(`${baseUrl}/readyz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ready" });
});

test("/monitorz returns relay health without secrets after initialization", async (t) => {
  const { server, baseUrl } = await withRawRelay(t, {
    env: validEnv(),
    logger: { write() {} },
  });
  await server.initialize();
  const response = await fetch(`${baseUrl}/monitorz`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.status, "ok");
  assert.equal(payload.checks.readiness.ok, true);
  assert.equal(payload.checks.queue.pending, 0);
  assert.doesNotMatch(JSON.stringify(payload), new RegExp(AGENT_SECRET));
});

test("relay health monitor alerts on initialization failure without leaking secrets", async (t) => {
  const logs = [];
  let webhookRequest;
  const { server } = await withRawRelay(t, {
    env: {
      ...validEnv(),
      BIOTELE_RELAY_OAUTH_ISSUER: "",
      BIOTELE_RELAY_MONITOR_FAILURE_THRESHOLD: "1",
      BIOTELE_RELAY_MONITOR_WEBHOOK_URL: "https://alerts.example.invalid/relay",
    },
    logger: { write() {} },
    errorLogger: { write(message) { logs.push(message); } },
    monitorFetch: async (url, options) => {
      webhookRequest = { url, options };
      return { ok: true, status: 202 };
    },
  });
  const readiness = await server.initialize();
  assert.equal(readiness.status, "failed");
  assert.match(logs.join(""), /Hostinger relay health alert/);
  assert.equal(webhookRequest.url, "https://alerts.example.invalid/relay");
  const webhookBody = JSON.parse(webhookRequest.options.body);
  assert.equal(webhookBody.type, "biotele.relay.health_alert");
  assert.equal(webhookBody.status, "degraded");
  assert.match(webhookBody.failedChecks, /readiness/);
  const emitted = `${logs.join("")}\n${webhookRequest.options.body}`;
  assert.doesNotMatch(emitted, new RegExp(AGENT_SECRET));
  assert.doesNotMatch(logs.join(""), /alerts\.example/);
});

test("relay health monitor alerts when queued jobs reach the warning threshold", async (t) => {
  const queue = new RelayQueue();
  let webhookBody;
  const { server } = await withRawRelay(t, {
    env: {
      ...validEnv(),
      BIOTELE_RELAY_MONITOR_QUEUE_WARNING_THRESHOLD: "1",
      BIOTELE_RELAY_MONITOR_FAILURE_THRESHOLD: "1",
      BIOTELE_RELAY_MONITOR_WEBHOOK_URL: "https://alerts.example.invalid/relay",
    },
    queue,
    logger: { write() {} },
    errorLogger: { write() {} },
    monitorFetch: async (_url, options) => {
      webhookBody = JSON.parse(options.body);
      return { ok: true, status: 202 };
    },
  });
  await server.initialize();
  queue.enqueue({ toolName: "codex_status", arguments: { threadId: "thread-1" } });
  const snapshot = await server.monitor.check();
  assert.equal(snapshot.status, "degraded");
  assert.equal(snapshot.checks.queue.ok, false);
  assert.equal(webhookBody.checks.queue.pending, 1);
});

test("relay health monitor tracks authenticated local-agent heartbeats", async (t) => {
  let now = 10_000;
  const { server, baseUrl } = await withRawRelay(t, {
    env: {
      ...validEnv(),
      BIOTELE_RELAY_MONITOR_AGENT_STALE_MS: "1000",
    },
    logger: { write() {} },
    monitorNow: () => now,
  });
  await server.initialize();
  let response = await fetch(`${baseUrl}/monitorz`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).checks.agent.ok, false);

  response = await agentSignedPost(baseUrl, "/agent/status", {});
  assert.equal(response.status, 200);
  response = await fetch(`${baseUrl}/monitorz`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).checks.agent.ok, true);

  now += 1_001;
  response = await fetch(`${baseUrl}/monitorz`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).checks.agent.ok, false);
});

test("relay test alert route requires agent HMAC authentication", async (t) => {
  const { server, baseUrl } = await withRawRelay(t, {
    env: validEnv(),
    logger: { write() {} },
  });
  await server.initialize();
  const response = await fetch(`${baseUrl}/agent/monitor/test-alert`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 401);
});

test("relay test alert reports missing webhook without sending secrets", async (t) => {
  const logs = [];
  const { server, baseUrl } = await withRawRelay(t, {
    env: validEnv(),
    logger: { write() {} },
    errorLogger: { write(message) { logs.push(message); } },
  });
  await server.initialize();
  const response = await agentSignedPost(baseUrl, "/agent/monitor/test-alert", {});
  assert.equal(response.status, 202);
  const payload = await response.json();
  assert.deepEqual(payload, {
    accepted: true,
    delivery: { delivered: false, reason: "webhook_not_configured" },
  });
  assert.match(logs.join(""), /Hostinger relay test alert requested/);
  assert.doesNotMatch(logs.join(""), new RegExp(AGENT_SECRET));
});

test("relay test alert posts a synthetic webhook payload without real failure", async (t) => {
  const logs = [];
  let webhookRequest;
  const { server, baseUrl } = await withRawRelay(t, {
    env: {
      ...validEnv(),
      BIOTELE_RELAY_MONITOR_WEBHOOK_URL: "https://alerts.example.invalid/relay",
    },
    logger: { write() {} },
    errorLogger: { write(message) { logs.push(message); } },
    monitorFetch: async (url, options) => {
      webhookRequest = { url, options };
      return { ok: true, status: 202 };
    },
  });
  await server.initialize();
  const response = await agentSignedPost(baseUrl, "/agent/monitor/test-alert", {});
  assert.equal(response.status, 202);
  const payload = await response.json();
  assert.deepEqual(payload.delivery, { delivered: true, statusCode: 202 });
  assert.equal(webhookRequest.url, "https://alerts.example.invalid/relay");

  const webhookBody = JSON.parse(webhookRequest.options.body);
  assert.equal(webhookBody.type, "biotele.relay.test_alert");
  assert.equal(webhookBody.status, "test");
  assert.equal(webhookBody.relayStatus, "ok");
  assert.equal(webhookBody.checks.readiness.ok, true);
  assert.equal(webhookBody.checks.queue.pending, 0);
  assert.doesNotMatch(webhookRequest.options.body, new RegExp(AGENT_SECRET));
  assert.doesNotMatch(logs.join(""), /alerts\.example/);
});

test("/mcp fails closed while initializing", async (t) => {
  const { server, baseUrl } = await withRawRelay(t, {
    env: validEnv(),
    logger: { write() {} },
    initializeDelayMs: 100,
  });
  const initializePromise = server.initialize();
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).status, "initializing");
  await initializePromise;
});

test("agent routes fail closed while initializing", async (t) => {
  const { server, baseUrl } = await withRawRelay(t, {
    env: validEnv(),
    logger: { write() {} },
    initializeDelayMs: 100,
  });
  const initializePromise = server.initialize();
  const response = await agentSignedPost(baseUrl, "/agent/status", {});
  assert.equal(response.status, 503);
  assert.equal((await response.json()).status, "initializing");
  await initializePromise;
});

test("initialization failure never enables unauthenticated access", async (t) => {
  const { server, baseUrl } = await withRawRelay(t, {
    env: {
      ...validEnv(),
      BIOTELE_RELAY_OAUTH_ISSUER: "",
    },
    logger: { write() {} },
  });
  const readiness = await server.initialize();
  assert.equal(readiness.status, "failed");
  const readyz = await fetch(`${baseUrl}/readyz`);
  assert.equal(readyz.status, 503);
  const mcp = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  assert.equal(mcp.status, 503);
});

test("PORT defaults to 3000 when absent or blank", () => {
  assert.equal(requiredPort({}), 3000);
  assert.equal(requiredPort({ PORT: "" }), 3000);
  assert.equal(requiredPort({ PORT: "   " }), 3000);
});

test("valid PORT is honored and invalid PORT is rejected", () => {
  assert.equal(requiredPort({ PORT: "3000" }), 3000);
  assert.equal(requiredPort({ PORT: "0" }), 0);
  assert.equal(requiredPort({ PORT: "65535" }), 65_535);
  assert.throws(() => requiredPort({ PORT: "abc" }), /PORT must be an integer/);
  assert.throws(() => requiredPort({ PORT: "-1" }), /PORT must be an integer/);
  assert.throws(() => requiredPort({ PORT: "70000" }), /PORT must be an integer/);
});

test("relay enforces safe result and lease configuration bounds", async (t) => {
  for (const override of [
    { BIOTELE_RELAY_MAX_RESULT_BYTES: "1" },
    {
      BIOTELE_RELAY_MCP_WAIT_MS: "60000",
      BIOTELE_RELAY_JOB_LEASE_MS: "55000",
    },
  ]) {
    const { server } = await withRawRelay(t, {
      env: { ...validEnv(), ...override },
      logger: { write() {} },
      errorLogger: { write() {} },
    });
    const readiness = await server.initialize();
    assert.equal(readiness.status, "failed");
  }
});

test("startHostingerRelay calls listen immediately with resolved port", async (t) => {
  const logs = [];
  const server = startHostingerRelay({
    env: validEnv({ issuer: "" }),
    logger: { write: (line) => logs.push(line) },
    hostname: "127.0.0.1",
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once("listening", resolve));
  assert.ok(server.address().port > 0);
  assert.match(logs.join(""), /Hostinger relay listening on port 0/);
});

test("startup and initialization error logs do not include secret values", async (t) => {
  const logs = [];
  const secret = "this-secret-must-not-appear-0123456789";
  const { server } = await withRawRelay(t, {
    env: {
      ...validEnv({ agentSecret: secret }),
      BIOTELE_RELAY_OAUTH_ISSUER: "",
    },
    logger: { write: (line) => logs.push(line) },
  });
  await server.initialize();
  const output = logs.join("");
  assert.match(output, /Hostinger relay initialization failed/);
  assert.doesNotMatch(output, new RegExp(secret));
});

test("relay writes lifecycle logs to stdout and initialization failures to stderr", async (t) => {
  const output = [];
  const errors = [];
  const { server } = await withRawRelay(t, {
    env: {
      ...validEnv(),
      BIOTELE_RELAY_OAUTH_ISSUER: "",
    },
    logger: { write: (line) => output.push(line) },
    errorLogger: { write: (line) => errors.push(line) },
  });
  await server.initialize();

  assert.doesNotMatch(output.join(""), /initialization failed/);
  assert.match(errors.join(""), /Hostinger relay initialization failed/);
});

test("relay accepts split Hostinger agent credential environment variables", async (t) => {
  const { server, baseUrl } = await withRawRelay(t, {
    env: splitAgentEnv(),
    logger: { write() {} },
  });
  const readiness = await server.initialize();
  assert.equal(readiness.status, "ready");
  const response = await agentSignedPost(baseUrl, "/agent/status", {});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "ok");
});

test("split Hostinger agent secret takes precedence over stale legacy placeholder", async (t) => {
  const { server, baseUrl } = await withRawRelay(t, {
    env: {
      ...splitAgentEnv(),
      BIOTELE_RELAY_AGENT_KEYS: '{"windows-agent-1":"replace-with-32-plus-byte-agent-secret"}',
    },
    logger: { write() {} },
  });
  const readiness = await server.initialize();
  assert.equal(readiness.status, "ready");
  const response = await agentSignedPost(baseUrl, "/agent/status", {});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "ok");
});

test("split Hostinger agent secret defaults to the Windows agent key id", async (t) => {
  const env = splitAgentEnv();
  delete env.BIOTELE_RELAY_AGENT_KEY_ID;
  const { server, baseUrl } = await withRawRelay(t, {
    env,
    logger: { write() {} },
  });
  const readiness = await server.initialize();
  assert.equal(readiness.status, "ready");
  const response = await agentSignedPost(baseUrl, "/agent/status", {});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "ok");
});

test("Hostinger agent keys accept one canonical Base64 secret", async (t) => {
  const { server, baseUrl } = await withRawRelay(t, {
    env: {
      ...validEnv(),
      BIOTELE_RELAY_AGENT_KEYS: BASE64_AGENT_SECRET,
    },
    logger: { write() {} },
  });
  const readiness = await server.initialize();
  assert.equal(readiness.status, "ready");
  const response = await agentSignedPost(baseUrl, "/agent/status", {}, {
    secret: BASE64_AGENT_SECRET,
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "ok");
});

test("standalone Hostinger agent secret must be canonical Base64", async (t) => {
  const { server } = await withRawRelay(t, {
    env: {
      ...validEnv(),
      BIOTELE_RELAY_AGENT_KEYS: `${BASE64_AGENT_SECRET.slice(0, -1)}!`,
    },
    logger: { write() {} },
  });
  const readiness = await server.initialize();
  assert.equal(readiness.status, "failed");
});

test("legacy Hostinger agent keys accept JSON-like smart quotes and dash characters", async (t) => {
  const { server, baseUrl } = await withRawRelay(t, {
    env: {
      ...validEnv(),
      BIOTELE_RELAY_AGENT_KEYS: `{\u201Cwindows\u2013agent\u20131\u201D:\u201C${AGENT_SECRET}\u201D}`,
    },
    logger: { write() {} },
  });
  const readiness = await server.initialize();
  assert.equal(readiness.status, "ready");
  const response = await agentSignedPost(baseUrl, "/agent/status", {});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "ok");
});

test("legacy Hostinger agent keys accept wrapped key ids", async (t) => {
  const { server, baseUrl } = await withRawRelay(t, {
    env: {
      ...validEnv(),
      BIOTELE_RELAY_AGENT_KEYS: `{"windows-agent-\n1":"${AGENT_SECRET}"}`,
    },
    logger: { write() {} },
  });
  const readiness = await server.initialize();
  assert.equal(readiness.status, "ready");
  const response = await agentSignedPost(baseUrl, "/agent/status", {});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "ok");
});

test("legacy Hostinger agent keys accept escaped quotes", async (t) => {
  const { server, baseUrl } = await withRawRelay(t, {
    env: {
      ...validEnv(),
      BIOTELE_RELAY_AGENT_KEYS: `{\\"windows-agent-1\\":\\"${AGENT_SECRET}\\"}`,
    },
    logger: { write() {} },
  });
  const readiness = await server.initialize();
  assert.equal(readiness.status, "ready");
  const response = await agentSignedPost(baseUrl, "/agent/status", {});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "ok");
});

test("legacy Hostinger agent keys accept escaped JSON braces", async (t) => {
  const { server, baseUrl } = await withRawRelay(t, {
    env: {
      ...validEnv(),
      BIOTELE_RELAY_AGENT_KEYS: `\\{"windows-agent-1":"${AGENT_SECRET}"\\}`,
    },
    logger: { write() {} },
  });
  const readiness = await server.initialize();
  assert.equal(readiness.status, "ready");
  const response = await agentSignedPost(baseUrl, "/agent/status", {});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "ok");
});

test("legacy Hostinger agent keys accept HTML quote entities", async (t) => {
  const { server, baseUrl } = await withRawRelay(t, {
    env: {
      ...validEnv(),
      BIOTELE_RELAY_AGENT_KEYS: `{&quot;windows-agent-1&quot;:&quot;${AGENT_SECRET}&quot;}`,
    },
    logger: { write() {} },
  });
  const readiness = await server.initialize();
  assert.equal(readiness.status, "ready");
  const response = await agentSignedPost(baseUrl, "/agent/status", {});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "ok");
});

test("split agent credential environment variables must be paired", async (t) => {
  const { server } = await withRawRelay(t, {
    env: {
      ...splitAgentEnv(),
      BIOTELE_RELAY_AGENT_SECRET: "",
    },
    logger: { write() {} },
  });
  const readiness = await server.initialize();
  assert.equal(readiness.status, "failed");
  assert.match(readiness.error.message, /BIOTELE_RELAY_AGENT_SECRET is required/);
});

test("relay rejects missing OAuth token and returns WWW-Authenticate metadata", async (t) => {
  const key = createRsaKey("kid-1");
  const idp = await withIdentityProvider(t, { keys: [key] });
  const baseUrl = await withRelay(t, { issuer: idp.issuer });
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate"), /oauth-protected-resource/);
});

test("relay rejects malformed JWT", async (t) => {
  const key = createRsaKey("kid-1");
  const idp = await withIdentityProvider(t, { keys: [key] });
  const baseUrl = await withRelay(t, { issuer: idp.issuer });
  const response = await oauthPost(
    baseUrl,
    "/mcp",
    { jsonrpc: "2.0", id: 1, method: "ping", params: {} },
    "not-a-jwt",
  );
  assert.equal(response.status, 401);
});

test("relay rejects expired JWT", async (t) => {
  const key = createRsaKey("kid-1");
  const idp = await withIdentityProvider(t, { keys: [key] });
  const baseUrl = await withRelay(t, { issuer: idp.issuer });
  const token = mintJwt({ issuer: idp.issuer, key, expiresInSeconds: -1 });
  const response = await oauthPost(baseUrl, "/mcp", { jsonrpc: "2.0", id: 1, method: "ping" }, token);
  assert.equal(response.status, 401);
});

test("relay rejects invalid issuer", async (t) => {
  const key = createRsaKey("kid-1");
  const idp = await withIdentityProvider(t, { keys: [key] });
  const baseUrl = await withRelay(t, { issuer: idp.issuer });
  const token = mintJwt({ issuer: "https://issuer.invalid", key });
  const response = await oauthPost(baseUrl, "/mcp", { jsonrpc: "2.0", id: 1, method: "ping" }, token);
  assert.equal(response.status, 401);
});

test("relay rejects invalid audience", async (t) => {
  const key = createRsaKey("kid-1");
  const idp = await withIdentityProvider(t, { keys: [key] });
  const baseUrl = await withRelay(t, { issuer: idp.issuer });
  const token = mintJwt({ issuer: idp.issuer, audience: "https://wrong.example/mcp", key });
  const response = await oauthPost(baseUrl, "/mcp", { jsonrpc: "2.0", id: 1, method: "ping" }, token);
  assert.equal(response.status, 401);
});

test("relay rejects invalid signature", async (t) => {
  const trusted = createRsaKey("kid-1");
  const untrusted = createRsaKey("kid-1");
  const idp = await withIdentityProvider(t, { keys: [trusted] });
  const baseUrl = await withRelay(t, { issuer: idp.issuer });
  const token = mintJwt({ issuer: idp.issuer, key: untrusted });
  const response = await oauthPost(baseUrl, "/mcp", { jsonrpc: "2.0", id: 1, method: "ping" }, token);
  assert.equal(response.status, 401);
});

test("relay rejects unsupported JWT algorithm", async (t) => {
  const key = createRsaKey("kid-1");
  const idp = await withIdentityProvider(t, { keys: [key] });
  const baseUrl = await withRelay(t, { issuer: idp.issuer });
  const token = mintJwt({ issuer: idp.issuer, key, algorithm: "HS256" });
  const response = await oauthPost(baseUrl, "/mcp", { jsonrpc: "2.0", id: 1, method: "ping" }, token);
  assert.equal(response.status, 401);
});

test("relay refreshes JWKS after unknown kid", async (t) => {
  const oldKey = createRsaKey("old-kid");
  const rotatedKey = createRsaKey("rotated-kid");
  const idp = await withIdentityProvider(t, {
    keys: [oldKey, rotatedKey],
    rotatingKid: "rotated-kid",
  });
  const baseUrl = await withRelay(t, { issuer: idp.issuer });
  const token = mintJwt({ issuer: idp.issuer, key: rotatedKey });
  const response = await oauthPost(baseUrl, "/mcp", { jsonrpc: "2.0", id: 1, method: "ping" }, token);
  assert.equal(response.status, 200);
  assert.equal(idp.jwksRequests(), 2);
});

test("relay permits valid read scope for tools/list", async (t) => {
  const key = createRsaKey("kid-1");
  const idp = await withIdentityProvider(t, { keys: [key] });
  const baseUrl = await withRelay(t, { issuer: idp.issuer });
  const token = mintJwt({ issuer: idp.issuer, key, scope: READ_SCOPE });
  const response = await oauthPost(baseUrl, "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, token);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.ok(payload.result.tools.some((tool) => tool.name === "codex_wait"));
});

test("relay denies write tool without write scope", async (t) => {
  const key = createRsaKey("kid-1");
  const idp = await withIdentityProvider(t, { keys: [key] });
  const queue = new RelayQueue();
  const baseUrl = await withRelay(t, { issuer: idp.issuer, queue });
  const token = mintJwt({ issuer: idp.issuer, key, scope: READ_SCOPE });
  const response = await oauthPost(
    baseUrl,
    "/mcp",
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "codex_start", arguments: { cwd: "C:\\repo", prompt: "go" } },
    },
    token,
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.error.code, -32001);
  assert.equal(queue.size, 0);
});

test("relay permits write tool with write scope", async (t) => {
  const key = createRsaKey("kid-1");
  const idp = await withIdentityProvider(t, { keys: [key] });
  const baseUrl = await withRelay(t, { issuer: idp.issuer });
  const token = mintJwt({ issuer: idp.issuer, key, scope: WRITE_SCOPE });
  const mcpCall = oauthPost(
    baseUrl,
    "/mcp",
    {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "codex_interrupt", arguments: { threadId: "thread-1" } },
    },
    token,
  );
  const claimResponse = await agentSignedPost(baseUrl, "/agent/jobs/claim", { maxWaitMs: 100 });
  assert.equal(claimResponse.status, 200);
  const { job } = await claimResponse.json();
  assert.equal(job.toolName, "codex_interrupt");
  const result = {
    content: [{ type: "text", text: "{}" }],
    structuredContent: { interrupted: true },
    isError: false,
  };
  const resultResponse = await agentSignedPost(baseUrl, "/agent/jobs/result", {
    jobId: job.id,
    leaseId: job.leaseId,
    result,
  });
  assert.equal(resultResponse.status, 202);
  const mcpResponse = await mcpCall;
  const payload = await mcpResponse.json();
  assert.deepEqual(payload.result, result);
});

test("relay rejects agent HMAC credentials on MCP endpoint", async (t) => {
  const key = createRsaKey("kid-1");
  const idp = await withIdentityProvider(t, { keys: [key] });
  const baseUrl = await withRelay(t, { issuer: idp.issuer });
  const response = await agentSignedPost(baseUrl, "/mcp", { jsonrpc: "2.0", id: 1, method: "ping" });
  assert.equal(response.status, 401);
});

test("relay rejects OAuth token on agent routes", async (t) => {
  const key = createRsaKey("kid-1");
  const idp = await withIdentityProvider(t, { keys: [key] });
  const baseUrl = await withRelay(t, { issuer: idp.issuer });
  const token = mintJwt({ issuer: idp.issuer, key, scope: `${READ_SCOPE} ${WRITE_SCOPE}` });
  const response = await fetch(`${baseUrl}/agent/status`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ maxWaitMs: 1 }),
  });
  assert.equal(response.status, 401);
});

test("relay accepts agent HMAC credentials on agent status route", async (t) => {
  const key = createRsaKey("kid-1");
  const idp = await withIdentityProvider(t, { keys: [key] });
  const baseUrl = await withRelay(t, { issuer: idp.issuer });
  const response = await agentSignedPost(baseUrl, "/agent/status", {});
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.status, "ok");
  assert.equal(payload.version, "1.2.3");
  assert.equal(payload.resultSubmission.preferredProtocol, RESULT_SUBMISSION_PROTOCOL);
  assert.ok(payload.resultSubmission.maxResultBytes >= 262_144);
  assert.ok(payload.resultSubmission.chunkBytes <= 32 * 1024);
});

test("chunk result traffic has a separate authenticated rate budget", async (t) => {
  const { server, baseUrl } = await withRawRelay(t, {
    env: validEnv(),
    logger: { write() {} },
  });
  await server.initialize();
  for (let index = 0; index < 130; index += 1) {
    const response = await agentSignedPost(baseUrl, "/agent/jobs/result", {
      jobId: `missing-job-${index}`,
      leaseId: `missing-lease-${index}`,
      result: { index },
    });
    assert.equal(response.status, 409);
  }
});

test("unauthenticated result failures keep the conservative pre-auth budget", async (t) => {
  const { server, baseUrl } = await withRawRelay(t, {
    env: {
      ...validEnv(),
      BIOTELE_RELAY_RATE_LIMIT_PER_MINUTE: "2",
      BIOTELE_RELAY_RESULT_RATE_LIMIT_PER_MINUTE: "200",
    },
    logger: { write() {} },
  });
  await server.initialize();
  for (const expectedStatus of [401, 401, 429]) {
    const response = await fetch(`${baseUrl}/agent/jobs/result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId: "missing", leaseId: "missing", result: {} }),
    });
    assert.equal(response.status, expectedStatus);
  }
});

test("trusted proxy client buckets cannot poison another forwarded agent address", async (t) => {
  const { server, baseUrl } = await withRawRelay(t, {
    env: {
      ...validEnv(),
      BIOTELE_RELAY_TRUST_PROXY: "true",
      BIOTELE_RELAY_RATE_LIMIT_PER_MINUTE: "2",
      BIOTELE_RELAY_RESULT_RATE_LIMIT_PER_MINUTE: "200",
    },
    logger: { write() {} },
  });
  await server.initialize();
  for (const expectedStatus of [401, 401, 429]) {
    const response = await fetch(`${baseUrl}/agent/jobs/result`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.20, 198.51.100.20",
      },
      body: JSON.stringify({ jobId: "missing", leaseId: "missing", result: {} }),
    });
    assert.equal(response.status, expectedStatus);
  }

  const validAgent = await agentSignedPost(
    baseUrl,
    "/agent/jobs/result",
    { jobId: "missing", leaseId: "missing", result: {} },
    {},
    { "x-forwarded-for": "203.0.113.30, 198.51.100.30" },
  );
  assert.equal(validAgent.status, 409);
});

test("relay exposes OAuth protected-resource metadata", async (t) => {
  const key = createRsaKey("kid-1");
  const idp = await withIdentityProvider(t, { keys: [key] });
  const baseUrl = await withRelay(t, { issuer: idp.issuer });
  const response = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.resource, "https://mcp.biotele.mx/mcp");
  assert.deepEqual(payload.authorization_servers, [idp.issuer]);
});

test("relay does not echo bearer token in auth failure body or challenge", async (t) => {
  const key = createRsaKey("kid-1");
  const idp = await withIdentityProvider(t, { keys: [key] });
  const baseUrl = await withRelay(t, { issuer: idp.issuer });
  const token = "sensitive.access.token";
  const response = await oauthPost(baseUrl, "/mcp", { jsonrpc: "2.0", id: 1, method: "ping" }, token);
  assert.equal(response.status, 401);
  const body = await response.text();
  assert.doesNotMatch(body, /sensitive\.access\.token/);
  assert.doesNotMatch(response.headers.get("www-authenticate") ?? "", /sensitive\.access\.token/);
});

test("relay queue leases jobs, rejects stale duplicate submissions, and accepts current result", () => {
  let now = 1_000;
  const queue = new RelayQueue({
    jobTtlMs: 10_000,
    leaseMs: 100,
    now: () => now,
  });
  const job = queue.enqueue({ toolName: "codex_status", arguments: { threadId: "thread-1" } });
  const firstClaim = queue.claim();
  assert.equal(firstClaim.id, job.id);
  assert.equal(firstClaim.deliveryCount, 1);

  now += 101;
  const secondClaim = queue.claim();
  assert.equal(secondClaim.id, job.id);
  assert.equal(secondClaim.deliveryCount, 2);
  assert.throws(
    () => queue.complete({ jobId: job.id, leaseId: firstClaim.leaseId, result: { stale: true } }),
    /lease is not current/,
  );

  queue.complete({ jobId: job.id, leaseId: secondClaim.leaseId, result: { ok: true } });
  assert.equal(queue.size, 0);
});

test("relay rejects expired leases and leases owned by another agent identity", () => {
  let now = 1_000;
  const queue = new RelayQueue({ jobTtlMs: 10_000, leaseMs: 100, now: () => now });
  const job = queue.enqueue({
    toolName: "codex_status",
    arguments: {},
    resultTimeoutMs: 2_000,
  });
  const claim = queue.claim({ leaseOwner: "agent-a" });
  assert.throws(
    () => queue.assertCurrentLease({
      jobId: job.id,
      leaseId: claim.leaseId,
      leaseOwner: "agent-b",
    }),
    /another agent identity/,
  );
  now += 101;
  assert.throws(
    () => queue.assertCurrentLease({
      jobId: job.id,
      leaseId: claim.leaseId,
      leaseOwner: "agent-a",
    }),
    /lease has expired/,
  );
});

test("relay records the MCP result deadline before a waiting claim resolves", async () => {
  let now = 1_000;
  const queue = new RelayQueue({ jobTtlMs: 10_000, leaseMs: 5_000, now: () => now });
  const claimPromise = queue.waitForClaimable({ timeoutMs: 1_000, leaseOwner: "agent-a" });
  const job = queue.enqueue({
    toolName: "codex_status",
    arguments: {},
    resultTimeoutMs: 2_000,
  });
  const resultPromise = queue.waitForResult(job, { timeoutMs: 2_000 });
  const claim = await claimPromise;
  assert.equal(claim.resultDeadlineAt, 3_000);
  assert.equal(claim.resultBudgetMs, 2_000);
  queue.complete({
    jobId: job.id,
    leaseId: claim.leaseId,
    leaseOwner: "agent-a",
    result: { ok: true },
  });
  assert.deepEqual(await resultPromise, { result: { ok: true } });
});

test("relay queue returns timeout result for uncompleted jobs", async () => {
  const queue = new RelayQueue();
  const job = queue.enqueue({ toolName: "codex_wait", arguments: { threadId: "thread-1" } });
  const outcome = await queue.waitForResult(job, { timeoutMs: 10 });
  assert.equal(outcome.error.type, "RelayTimeout");
});

test("relay result submission completes a pending MCP read tool call through a mocked local agent", async (t) => {
  const key = createRsaKey("kid-1");
  const idp = await withIdentityProvider(t, { keys: [key] });
  const baseUrl = await withRelay(t, { issuer: idp.issuer });
  const token = mintJwt({ issuer: idp.issuer, key, scope: READ_SCOPE });
  const mcpCall = oauthPost(
    baseUrl,
    "/mcp",
    {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "codex_list_threads",
        arguments: { limit: 1 },
      },
    },
    token,
  );

  const claimResponse = await agentSignedPost(baseUrl, "/agent/jobs/claim", { maxWaitMs: 100 });
  assert.equal(claimResponse.status, 200);
  const { job } = await claimResponse.json();
  assert.equal(job.toolName, "codex_list_threads");
  assert.deepEqual(job.arguments, { limit: 1 });

  const toolResult = {
    content: [{ type: "text", text: "{}" }],
    structuredContent: { data: [], nextCursor: null },
    isError: false,
  };
  const resultResponse = await agentSignedPost(baseUrl, "/agent/jobs/result", {
    jobId: job.id,
    leaseId: job.leaseId,
    result: toolResult,
  });
  assert.equal(resultResponse.status, 202);

  const mcpResponse = await mcpCall;
  assert.equal(mcpResponse.status, 200);
  const payload = await mcpResponse.json();
  assert.deepEqual(payload.result, toolResult);
});

test("legacy result submissions obey the configured result limit and payload shape", async (t) => {
  const key = createRsaKey("kid-1");
  const idp = await withIdentityProvider(t, { keys: [key] });
  const baseUrl = await withRelay(t, {
    issuer: idp.issuer,
    env: {
      ...process.env,
      BIOTELE_RELAY_MAX_RESULT_BYTES: "4096",
    },
  });
  const token = mintJwt({ issuer: idp.issuer, key, scope: READ_SCOPE });
  const mcpCall = oauthPost(
    baseUrl,
    "/mcp",
    {
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: { name: "codex_list_threads", arguments: {} },
    },
    token,
  );
  const claim = await (await agentSignedPost(
    baseUrl,
    "/agent/jobs/claim",
    { maxWaitMs: 100 },
  )).json();

  let response = await agentSignedPost(baseUrl, "/agent/jobs/result", {
    jobId: claim.job.id,
    leaseId: claim.job.leaseId,
    result: { text: "x".repeat(5_000) },
  });
  assert.equal(response.status, 409);
  assert.match((await response.json()).message, /relay limit is 4096 bytes/);

  response = await agentSignedPost(baseUrl, "/agent/jobs/result", {
    jobId: claim.job.id,
    leaseId: claim.job.leaseId,
    result: { ok: true },
    error: { bad: true },
  });
  assert.equal(response.status, 409);
  assert.match((await response.json()).message, /exactly one/);

  response = await agentSignedPost(baseUrl, "/agent/jobs/result", {
    jobId: claim.job.id,
    leaseId: claim.job.leaseId,
    result: { ok: true },
  });
  assert.equal(response.status, 202);
  assert.equal((await mcpCall).status, 200);
});

test("relay reconstructs a large opaque multi-chunk result without plaintext on the wire", async (t) => {
  const key = createRsaKey("kid-1");
  const idp = await withIdentityProvider(t, { keys: [key] });
  const baseUrl = await withRelay(t, { issuer: idp.issuer });
  const token = mintJwt({ issuer: idp.issuer, key, scope: READ_SCOPE });
  const mcpCall = oauthPost(
    baseUrl,
    "/mcp",
    {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: {
        name: "codex_status",
        arguments: { threadId: "thread-1", maxEvents: 100 },
      },
    },
    token,
  );

  const claimResponse = await agentSignedPost(baseUrl, "/agent/jobs/claim", { maxWaitMs: 100 });
  assert.equal(claimResponse.status, 200);
  const claim = await claimResponse.json();
  assert.equal(claim.resultSubmission.preferredProtocol, RESULT_SUBMISSION_PROTOCOL);

  const WAF_TEXT = "powershell.exe -ExecutionPolicy Bypass <script>blocked</script>";
  const toolResult = {
    content: [{ type: "text", text: "Structured result available." }],
    structuredContent: {
      events: Array.from({ length: 5_000 }, (_, index) => ({
        sequence: index,
        command: `${WAF_TEXT} ${index}`,
      })),
    },
    isError: false,
  };
  const encoded = encodeResultSubmission(
    { result: toolResult },
    {
      maxResultBytes: claim.resultSubmission.maxResultBytes,
      chunkBytes: claim.resultSubmission.chunkBytes,
      uploadId: "upload-hostinger-large-result",
    },
  );
  assert.ok(encoded.totalBytes > 262_144);
  assert.ok(encoded.submissions.length > 1);

  for (const [index, submission] of encoded.submissions.entries()) {
    const wire = JSON.stringify({
      jobId: claim.job.id,
      leaseId: claim.job.leaseId,
      submission,
    });
    assert.equal(wire.includes(WAF_TEXT), false);
    assert.ok(Buffer.byteLength(wire) < 64 * 1024);
    const response = await agentSignedPost(baseUrl, "/agent/jobs/result", {
      jobId: claim.job.id,
      leaseId: claim.job.leaseId,
      submission,
    });
    assert.equal(response.status, 202);
    const accepted = await response.json();
    assert.equal(accepted.complete, index === encoded.submissions.length - 1);
  }

  const mcpResponse = await mcpCall;
  assert.equal(mcpResponse.status, 200);
  const payload = await mcpResponse.json();
  assert.deepEqual(payload.result, toolResult);
});

test("relay rejects chunk uploads for a stale lease before buffering", async (t) => {
  let now = 1_000;
  const queue = new RelayQueue({
    jobTtlMs: 10_000,
    leaseMs: 100,
    now: () => now,
  });
  const { server, baseUrl } = await withRawRelay(t, {
    env: validEnv(),
    queue,
    logger: { write() {} },
  });
  const readiness = await server.initialize();
  assert.equal(readiness.status, "ready");
  const queued = queue.enqueue({
    toolName: "codex_status",
    arguments: { threadId: "thread-1" },
  });
  const first = queue.claim();
  now += 101;
  const second = queue.claim();
  assert.equal(first.id, queued.id);
  assert.notEqual(first.leaseId, second.leaseId);

  const encoded = encodeResultSubmission(
    { result: { ok: true } },
    { uploadId: "upload-stale-lease-1234" },
  );
  const response = await agentSignedPost(baseUrl, "/agent/jobs/result", {
    jobId: first.id,
    leaseId: first.leaseId,
    submission: encoded.submissions[0],
  });
  assert.equal(response.status, 409);
  assert.match((await response.json()).message, /lease is not current/);
});
