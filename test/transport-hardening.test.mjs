import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { PassThrough } from "node:stream";
import test from "node:test";

import { AppServerError } from "../src/errors.mjs";
import { McpStdioServer } from "../src/mcp-server.mjs";
import {
  createRemoteHttpServer,
  negotiateProtocolVersion,
  requiredOAuthScope,
  validateOAuthScopeConfig,
} from "../src/remote-server.mjs";

const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
};

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function captureJsonLines(stream) {
  const messages = [];
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line) {
        messages.push(JSON.parse(line));
      }
    }
  });
  return messages;
}

async function waitForMessage(messages, predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const message = messages.find(predicate);
    if (message) {
      return message;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for an MCP test response");
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function postMcp(baseUrl, message, headers = {}) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(message),
  });
  return { response, body: await response.json() };
}

test("STDIO rejects duplicate active IDs, releases them, and sanitizes errors", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages = captureJsonLines(output);
  const started = deferred();
  const release = deferred();
  const sentinel = ["transport", "secret", "sentinel"].join("-");

  const toolRegistry = {
    definitions: [],
    has: (name) => name === "slow" || name === "fail",
    async call(name) {
      if (name === "slow") {
        started.resolve();
        await release.promise;
        return { completed: true };
      }
      const error = new Error(`Authorization: Bearer ${sentinel}`);
      Object.setPrototypeOf(error, AppServerError.prototype);
      error.code = "mock_error";
      error.method = "mock/method";
      error.data = {
        access_token: sentinel,
        nested: `{"client_secret":"${sentinel}"}`,
      };
      throw error;
    },
  };
  const server = new McpStdioServer({
    service: { close: async () => {} },
    toolRegistry,
    input,
    output,
  });
  const running = server.run();

  input.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: "version",
    method: "initialize",
    params: { protocolVersion: "2099-01-01" },
  })}\n`);
  const initialized = await waitForMessage(messages, (message) => message.id === "version");
  assert.equal(initialized.result.protocolVersion, "2025-11-25");

  input.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: "duplicate",
    method: "tools/call",
    params: { name: "slow", arguments: {}, _meta: MODERN_META },
  })}\n`);
  await started.promise;
  input.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: "duplicate",
    method: "ping",
    params: { _meta: MODERN_META },
  })}\n`);

  const duplicate = await waitForMessage(
    messages,
    (message) => message.id === "duplicate" && message.error,
  );
  assert.equal(duplicate.error.code, -32600);
  assert.match(duplicate.error.message, /Duplicate active/);

  release.resolve();
  await waitForMessage(
    messages,
    (message) => message.id === "duplicate" && message.result,
  );

  input.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: "duplicate",
    method: "ping",
    params: { _meta: MODERN_META },
  })}\n`);
  await waitForMessage(
    messages,
    (message, index) =>
      message.id === "duplicate" && message.result && messages.indexOf(message) > 2,
  );

  input.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: "sanitized",
    method: "tools/call",
    params: { name: "fail", arguments: {}, _meta: MODERN_META },
  })}\n`);
  const sanitized = await waitForMessage(messages, (message) => message.id === "sanitized");
  assert.equal(sanitized.result.isError, true);
  assert.doesNotMatch(JSON.stringify(sanitized), new RegExp(sentinel));
  assert.match(JSON.stringify(sanitized), /\[REDACTED\]/);

  input.end();
  await running;
});

test("direct remote server rejects duplicate active IDs and permits reuse after completion", async (t) => {
  const started = deferred();
  const release = deferred();
  const sentinel = ["remote", "error", "sentinel"].join("-");
  const tools = {
    definitions: [],
    has: (name) => name === "slow" || name === "fail",
    async call(name) {
      if (name === "fail") {
        const error = new Error(`api_key: ${sentinel}`);
        Object.setPrototypeOf(error, AppServerError.prototype);
        error.code = "mock_error";
        error.method = "mock/method";
        error.data = {
          refresh_token: sentinel,
          nested: `Authorization: Bearer ${sentinel}`,
        };
        throw error;
      }
      started.resolve();
      await release.promise;
      return { completed: true };
    },
  };
  const server = createRemoteHttpServer({
    tools,
    authMode: "none",
    authorizeRequest: async () => ({ subject: "test", scopes: new Set() }),
  });
  t.after(() => closeServer(server));
  const baseUrl = await listen(server);

  const first = postMcp(baseUrl, {
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "slow", arguments: {} },
  });
  await started.promise;
  const duplicate = await postMcp(baseUrl, {
    jsonrpc: "2.0",
    id: 7,
    method: "ping",
    params: {},
  });
  assert.equal(duplicate.response.status, 200);
  assert.equal(duplicate.body.error.code, -32600);

  release.resolve();
  assert.equal((await first).body.result.isError, false);
  const reused = await postMcp(baseUrl, {
    jsonrpc: "2.0",
    id: 7,
    method: "ping",
    params: {},
  });
  assert.deepEqual(reused.body.result, {});

  const sanitized = await postMcp(baseUrl, {
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: { name: "fail", arguments: {} },
  });
  assert.equal(sanitized.body.result.isError, true);
  assert.doesNotMatch(JSON.stringify(sanitized.body), new RegExp(sentinel));
  assert.match(JSON.stringify(sanitized.body), /\[REDACTED\]/);
});

test("direct remote OAuth enforces read/write scopes and advertises challenges", async (t) => {
  const calls = [];
  const sentinel = ["oauth", "header", "sentinel"].join("-");
  const tools = {
    definitions: [],
    has: (name) => ["codex_status", "codex_start"].includes(name),
    async call(name) {
      calls.push(name);
      return { name };
    },
  };
  const server = createRemoteHttpServer({
    tools,
    authMode: "oauth",
    publicUrl: "https://mcp.example",
    oauthIssuer: "https://issuer.example/",
    authorizeRequest: async (req) => {
      if (req.headers.authorization === "Bearer no-scopes") {
        return { subject: "zero-scope", scopes: new Set() };
      }
      if (req.headers.authorization !== "Bearer accepted") {
        throw new Error(`Authorization: Bearer ${sentinel}`);
      }
      return { subject: "test", scopes: new Set(["biotele.mcp.read"]) };
    },
  });
  t.after(() => closeServer(server));
  const baseUrl = await listen(server);

  const metadataResponse = await fetch(
    `${baseUrl}/.well-known/oauth-protected-resource`,
  );
  const metadata = await metadataResponse.json();
  assert.deepEqual(metadata.scopes_supported, [
    "biotele.mcp.read",
    "biotele.mcp.write",
  ]);

  const unauthorized = await postMcp(baseUrl, {
    jsonrpc: "2.0",
    id: 1,
    method: "ping",
    params: {},
  });
  assert.equal(unauthorized.response.status, 401);
  assert.match(unauthorized.response.headers.get("www-authenticate"), /error="invalid_token"/);
  assert.doesNotMatch(
    `${JSON.stringify(unauthorized.body)} ${unauthorized.response.headers.get("www-authenticate")}`,
    new RegExp(sentinel),
  );

  const initialized = await postMcp(
    baseUrl,
    {
      jsonrpc: "2.0",
      id: "initialize",
      method: "initialize",
      params: { protocolVersion: "2025-11-25" },
    },
    { authorization: "Bearer accepted" },
  );
  const sessionId = initialized.response.headers.get("mcp-session-id");
  assert.match(sessionId, /^[\x21-\x7e]{1,128}$/);

  const deniedList = await postMcp(
    baseUrl,
    {
      jsonrpc: "2.0",
      id: "list-without-scope",
      method: "tools/list",
      params: {},
    },
    { authorization: "Bearer no-scopes", "mcp-session-id": sessionId },
  );
  assert.equal(deniedList.response.status, 200);
  assert.equal(deniedList.body.error.code, -32001);
  assert.deepEqual(deniedList.body.error.data, { requiredScope: "biotele.mcp.read" });

  const listed = await postMcp(
    baseUrl,
    {
      jsonrpc: "2.0",
      id: "list-with-scope",
      method: "tools/list",
      params: {},
    },
    { authorization: "Bearer accepted", "mcp-session-id": sessionId },
  );
  assert.deepEqual(listed.body.result, { tools: [] });

  const read = await postMcp(
    baseUrl,
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "codex_status", arguments: {} },
    },
    { authorization: "Bearer accepted" },
  );
  assert.equal(read.body.result.isError, false);

  const write = await postMcp(
    baseUrl,
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "codex_start", arguments: {} },
    },
    { authorization: "Bearer accepted" },
  );
  assert.equal(write.response.status, 200);
  assert.equal(write.body.error.code, -32001);
  assert.deepEqual(write.body.error.data, { requiredScope: "biotele.mcp.write" });
  assert.deepEqual(calls, ["codex_status"]);
});

test("direct remote active IDs are isolated by OAuth subject and MCP session", async (t) => {
  const release = deferred();
  let started = 0;
  const tools = {
    definitions: [],
    has: (name) => name === "codex_start",
    async call() {
      started += 1;
      if (started === 3) {
        release.resolve();
      }
      await release.promise;
      return { started: true };
    },
  };
  const server = createRemoteHttpServer({
    tools,
    authMode: "oauth",
    publicUrl: "https://mcp.example",
    oauthIssuer: "https://issuer.example/",
    authorizeRequest: async (req) => {
      const token = req.headers.authorization;
      if (token !== "Bearer alpha" && token !== "Bearer beta") {
        throw new Error("Unauthorized test subject");
      }
      return {
        subject: token.slice("Bearer ".length),
        scopes: new Set(["biotele.mcp.write"]),
      };
    },
  });
  t.after(() => closeServer(server));
  const baseUrl = await listen(server);

  const firstInitialize = await postMcp(
    baseUrl,
    {
      jsonrpc: "2.0",
      id: "initialize-one",
      method: "initialize",
      params: { protocolVersion: "2025-11-25" },
    },
    { authorization: "Bearer alpha" },
  );
  const secondInitialize = await postMcp(
    baseUrl,
    {
      jsonrpc: "2.0",
      id: "initialize-two",
      method: "initialize",
      params: { protocolVersion: "2025-11-25" },
    },
    { authorization: "Bearer alpha" },
  );
  const firstSession = firstInitialize.response.headers.get("mcp-session-id");
  const secondSession = secondInitialize.response.headers.get("mcp-session-id");
  assert.match(firstSession, /^[\x21-\x7e]{1,128}$/);
  assert.match(secondSession, /^[\x21-\x7e]{1,128}$/);
  assert.notEqual(firstSession, secondSession);

  const request = {
    jsonrpc: "2.0",
    id: "shared-active-id",
    method: "tools/call",
    params: { name: "codex_start", arguments: {} },
  };
  const fallback = setTimeout(() => release.resolve(), 1_000);
  const results = await Promise.all([
    postMcp(baseUrl, request, {
      authorization: "Bearer alpha",
      "mcp-session-id": firstSession,
    }),
    postMcp(baseUrl, request, {
      authorization: "Bearer beta",
      "mcp-session-id": firstSession,
    }),
    postMcp(baseUrl, request, {
      authorization: "Bearer alpha",
      "mcp-session-id": secondSession,
    }),
  ]);
  clearTimeout(fallback);

  assert.equal(started, 3);
  assert.ok(results.every(({ body }) => body.result?.isError === false));
});

test("direct remote client disconnect aborts work and releases its active ID", async (t) => {
  const previousTimeout = process.env.CODEX_REMOTE_TOOL_TIMEOUT_MS;
  process.env.CODEX_REMOTE_TOOL_TIMEOUT_MS = "1000";

  const started = deferred();
  const observedAbort = deferred();
  const release = deferred();
  const tools = {
    definitions: [],
    has: (name) => name === "slow",
    async call(_name, _args, { signal }) {
      started.resolve();
      const onAbort = () => observedAbort.resolve(signal.reason);
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
      await release.promise;
      return { completed: true };
    },
  };
  const server = createRemoteHttpServer({
    tools,
    authMode: "none",
    authorizeRequest: async () => ({ subject: "disconnect-test", scopes: new Set() }),
  });
  t.after(async () => {
    release.resolve();
    await closeServer(server);
    if (previousTimeout === undefined) {
      delete process.env.CODEX_REMOTE_TOOL_TIMEOUT_MS;
    } else {
      process.env.CODEX_REMOTE_TOOL_TIMEOUT_MS = previousTimeout;
    }
  });
  const baseUrl = await listen(server);

  const initialized = await postMcp(baseUrl, {
    jsonrpc: "2.0",
    id: "disconnect-initialize",
    method: "initialize",
    params: { protocolVersion: "2025-11-25" },
  });
  const sessionId = initialized.response.headers.get("mcp-session-id");
  assert.match(sessionId, /^[\x21-\x7e]{1,128}$/);

  const controller = new AbortController();
  const pending = fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "disconnect-id",
      method: "tools/call",
      params: { name: "slow", arguments: {} },
    }),
    signal: controller.signal,
  });
  await started.promise;
  controller.abort();
  await assert.rejects(pending, /abort/i);

  const abortReason = await observedAbort.promise;
  assert.equal(abortReason?.name, "AbortError");
  assert.match(abortReason?.message ?? "", /disconnected/i);
  await new Promise((resolve) => setImmediate(resolve));

  const reused = await postMcp(
    baseUrl,
    {
      jsonrpc: "2.0",
      id: "disconnect-id",
      method: "ping",
      params: {},
    },
    { "mcp-session-id": sessionId },
  );
  assert.deepEqual(reused.body.result, {});
  release.resolve();
});

test("direct remote bearer mode remains scope-neutral", async (t) => {
  const tools = {
    definitions: [],
    has: (name) => name === "codex_start",
    async call() {
      return { started: true };
    },
  };
  const server = createRemoteHttpServer({
    tools,
    authMode: "bearer",
    authorizeRequest: async () => ({ subject: "test", scopes: new Set() }),
  });
  t.after(() => closeServer(server));
  const baseUrl = await listen(server);
  const result = await postMcp(baseUrl, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "codex_start", arguments: {} },
  });
  assert.equal(result.body.result.isError, false);
  assert.equal(result.body.result.structuredContent.started, true);

  const listed = await postMcp(baseUrl, {
    jsonrpc: "2.0",
    id: 5,
    method: "tools/list",
    params: {},
  });
  assert.deepEqual(listed.body.result, { tools: [] });
});

test("direct remote protocol and scope configuration accept only safe values", () => {
  assert.equal(negotiateProtocolVersion("2025-11-25"), "2025-11-25");
  assert.equal(negotiateProtocolVersion("2099-01-01"), "2025-11-25");
  assert.equal(requiredOAuthScope("codex_status"), "biotele.mcp.read");
  assert.equal(requiredOAuthScope("codex_start"), "biotele.mcp.write");
  assert.equal(requiredOAuthScope("future_tool"), null);
  assert.throws(() => validateOAuthScopeConfig("", "write"), /non-empty/);
  assert.throws(() => validateOAuthScopeConfig("same", "same"), /distinct/);
  assert.doesNotThrow(() => validateOAuthScopeConfig("read", "write"));
});

test("direct remote refreshes JWKS once when the requested kid is initially unknown", async () => {
  const issuer = "https://issuer.example";
  const audience = "https://resource.example/mcp";
  const previous = {
    authMode: process.env.CODEX_REMOTE_AUTH_MODE,
    issuer: process.env.CODEX_REMOTE_OAUTH_ISSUER,
    audience: process.env.CODEX_REMOTE_OAUTH_AUDIENCE,
  };
  process.env.CODEX_REMOTE_AUTH_MODE = "oauth";
  process.env.CODEX_REMOTE_OAUTH_ISSUER = issuer;
  process.env.CODEX_REMOTE_OAUTH_AUDIENCE = audience;

  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicJwk = publicKey.export({ format: "jwk" });
  publicJwk.kid = "rotated-key";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";

  let metadataCalls = 0;
  let jwksCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/.well-known/openid-configuration")) {
      metadataCalls += 1;
      return new Response(
        JSON.stringify({ issuer: `${issuer}/`, jwks_uri: `${issuer}/jwks.json` }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (String(url) === `${issuer}/jwks.json`) {
      jwksCalls += 1;
      return new Response(
        JSON.stringify({ keys: jwksCalls === 1 ? [] : [publicJwk] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`Unexpected URL: ${String(url)}`);
  };

  try {
    const encodedHeader = Buffer.from(
      JSON.stringify({ alg: "RS256", typ: "JWT", kid: "rotated-key" }),
    ).toString("base64url");
    const encodedPayload = Buffer.from(
      JSON.stringify({
        iss: `${issuer}/`,
        aud: audience,
        sub: "test-subject",
        exp: Math.floor(Date.now() / 1_000) + 300,
        scope: "biotele.mcp.read",
      }),
    ).toString("base64url");
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const signature = sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString(
      "base64url",
    );
    const module = await import(
      `../src/remote-server.mjs?jwks-rotation=${Date.now()}`
    );
    const verified = await module.verifyOAuthToken(`${signingInput}.${signature}`);
    assert.equal(verified.subject, "test-subject");
    assert.equal(verified.scopes.has("biotele.mcp.read"), true);
    assert.equal(metadataCalls, 1);
    assert.equal(jwksCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of [
      ["CODEX_REMOTE_AUTH_MODE", previous.authMode],
      ["CODEX_REMOTE_OAUTH_ISSUER", previous.issuer],
      ["CODEX_REMOTE_OAUTH_AUDIENCE", previous.audience],
    ]) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});
