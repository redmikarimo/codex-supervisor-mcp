import assert from "node:assert/strict";
import { generateKeyPairSync, sign as signJwtInput } from "node:crypto";
import http from "node:http";
import test from "node:test";

import {
  createHostingerRelayServer,
  requiredPort,
} from "../src/hostinger-relay-server.mjs";
import { OAuthResourceServer } from "../src/oauth-resource-server.mjs";
import { signRequest } from "../src/relay-auth.mjs";
import { RelayQueue } from "../src/relay-queue.mjs";

const AGENT_KEY_ID = "windows-agent-1";
const AGENT_SECRET = "agent-secret-0123456789-0123456789";
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
} = {}) {
  const server = createHostingerRelayServer({
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

async function agentSignedPost(baseUrl, path, bodyObject, overrides = {}) {
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
    },
    body,
  });
}

test("relay listen path does not wait for initialization or OAuth discovery", async (t) => {
  const { server, baseUrl } = await withRawRelay(t, {
    env: validEnv(),
    logger: { write() {} },
    initializeDelayMs: 100,
  });
  const initializePromise = server.initialize();
  const response = await fetch(`${baseUrl}/readyz`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { status: "initializing" });
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

test("PORT is required and validated", () => {
  assert.throws(() => requiredPort({}), /PORT is required/);
  assert.throws(() => requiredPort({ PORT: "" }), /PORT is required/);
  assert.throws(() => requiredPort({ PORT: "abc" }), /PORT is required/);
  assert.throws(() => requiredPort({ PORT: "70000" }), /PORT is required/);
  assert.equal(requiredPort({ PORT: "3000" }), 3000);
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
