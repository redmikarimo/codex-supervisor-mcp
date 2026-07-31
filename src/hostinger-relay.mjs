#!/usr/bin/env node

import http from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { TOOL_DEFINITIONS } from "./tool-registry.mjs";
import {
  NonceStore,
  parseCredentialMap,
  verifySignedRequest,
} from "./relay-auth.mjs";
import { OAuthResourceServer, bearerChallenge } from "./oauth-resource-server.mjs";
import { RelayQueue } from "./relay-queue.mjs";

const VERSION = "1.2.0";
const DEFAULT_PROTOCOL_VERSION = "2025-11-25";
const HOST = process.env.BIOTELE_RELAY_HOST ?? "0.0.0.0";
const PORT = Number.parseInt(process.env.PORT ?? process.env.BIOTELE_RELAY_PORT ?? "3000", 10);
const MAX_BODY_BYTES = Number.parseInt(process.env.BIOTELE_RELAY_MAX_BODY_BYTES ?? "262144", 10);
const RATE_LIMIT_PER_MINUTE = Number.parseInt(process.env.BIOTELE_RELAY_RATE_LIMIT_PER_MINUTE ?? "120", 10);
const MCP_WAIT_MS = Number.parseInt(process.env.BIOTELE_RELAY_MCP_WAIT_MS ?? "55000", 10);
const AGENT_POLL_MS = Number.parseInt(process.env.BIOTELE_RELAY_AGENT_POLL_MS ?? "25000", 10);
const JOB_TTL_MS = Number.parseInt(process.env.BIOTELE_RELAY_JOB_TTL_MS ?? "120000", 10);
const JOB_LEASE_MS = Number.parseInt(process.env.BIOTELE_RELAY_JOB_LEASE_MS ?? "60000", 10);
const MAX_QUEUED_JOBS = Number.parseInt(process.env.BIOTELE_RELAY_MAX_QUEUED_JOBS ?? "200", 10);
const PUBLIC_URL = (process.env.BIOTELE_RELAY_PUBLIC_URL ?? "https://mcp.biotele.mx").replace(/\/+$/, "");
const OAUTH_REQUIRED = (process.env.BIOTELE_RELAY_OAUTH_REQUIRED ?? "true").toLowerCase() !== "false";
const OAUTH_JWKS_CACHE_MS = Number.parseInt(process.env.BIOTELE_RELAY_OAUTH_JWKS_CACHE_MS ?? "600000", 10);
const OAUTH_CLOCK_SKEW_SECONDS = Number.parseInt(process.env.BIOTELE_RELAY_OAUTH_CLOCK_SKEW_SECONDS ?? "60", 10);
const READ_SCOPE = process.env.BIOTELE_RELAY_OAUTH_READ_SCOPE ?? "biotele.mcp.read";
const WRITE_SCOPE = process.env.BIOTELE_RELAY_OAUTH_WRITE_SCOPE ?? "biotele.mcp.write";

const READ_TOOLS = new Set([
  "codex_status",
  "codex_wait",
  "codex_list_threads",
  "codex_read_thread",
  "codex_list_approvals",
]);
const WRITE_TOOLS = new Set([
  "codex_start",
  "codex_send",
  "codex_steer",
  "codex_interrupt",
  "codex_resolve_approval",
]);

const roleNonces = {
  agent: new NonceStore(),
};

function assertPositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
}

function validateStartupConfig() {
  for (const [value, name] of [
    [PORT, "PORT"],
    [MAX_BODY_BYTES, "BIOTELE_RELAY_MAX_BODY_BYTES"],
    [RATE_LIMIT_PER_MINUTE, "BIOTELE_RELAY_RATE_LIMIT_PER_MINUTE"],
    [MCP_WAIT_MS, "BIOTELE_RELAY_MCP_WAIT_MS"],
    [AGENT_POLL_MS, "BIOTELE_RELAY_AGENT_POLL_MS"],
    [JOB_TTL_MS, "BIOTELE_RELAY_JOB_TTL_MS"],
    [JOB_LEASE_MS, "BIOTELE_RELAY_JOB_LEASE_MS"],
    [MAX_QUEUED_JOBS, "BIOTELE_RELAY_MAX_QUEUED_JOBS"],
    [OAUTH_JWKS_CACHE_MS, "BIOTELE_RELAY_OAUTH_JWKS_CACHE_MS"],
    [OAUTH_CLOCK_SKEW_SECONDS, "BIOTELE_RELAY_OAUTH_CLOCK_SKEW_SECONDS"],
  ]) {
    assertPositiveInteger(value, name);
  }
}

function json(res, status, payload, headers = {}) {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(body);
}

function rpcError(id, code, message, data = undefined) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  };
}

function toolErrorResult(error) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ error }, null, 2),
      },
    ],
    structuredContent: { error },
    isError: true,
  };
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw Object.assign(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes.`), {
        statusCode: 413,
      });
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return { raw: "", parsed: null };
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return { raw, parsed: JSON.parse(raw) };
  } catch {
    throw Object.assign(new Error("Invalid JSON request body."), {
      statusCode: 400,
      code: "invalid_json",
    });
  }
}

class RateLimiter {
  constructor({ limit }) {
    this.limit = limit;
    this.buckets = new Map();
  }

  accept(key) {
    const minute = Math.floor(Date.now() / 60_000);
    const bucketKey = `${key}:${minute}`;
    const count = (this.buckets.get(bucketKey) ?? 0) + 1;
    this.buckets.set(bucketKey, count);
    if (this.buckets.size > 5_000) {
      for (const existing of this.buckets.keys()) {
        if (!existing.endsWith(`:${minute}`)) {
          this.buckets.delete(existing);
        }
      }
    }
    return count <= this.limit;
  }
}

function remoteAddress(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

function authorizeAgent({ req, url, rawBody, credentials }) {
  return verifySignedRequest({
    req,
    url,
    body: rawBody,
    credentials,
    nonceStore: roleNonces.agent,
  });
}

function requireScope(auth, scope) {
  if (!auth?.scopes?.has(scope)) {
    throw Object.assign(new Error(`Required OAuth scope is missing: ${scope}`), {
      code: "insufficient_scope",
      scope,
    });
  }
}

export function createHostingerRelayServer({
  agentCredentials,
  oauthResourceServer,
  oauthRequired = OAUTH_REQUIRED,
  publicUrl = PUBLIC_URL,
  queue = new RelayQueue({
    jobTtlMs: JOB_TTL_MS,
    leaseMs: JOB_LEASE_MS,
    maxQueuedJobs: MAX_QUEUED_JOBS,
  }),
} = {}) {
  const agents =
    agentCredentials ?? parseCredentialMap(process.env.BIOTELE_RELAY_AGENT_KEYS, "BIOTELE_RELAY_AGENT_KEYS");
  const oauth =
    oauthResourceServer ??
    (oauthRequired
      ? new OAuthResourceServer({
          issuer: process.env.BIOTELE_RELAY_OAUTH_ISSUER,
          audience: process.env.BIOTELE_RELAY_OAUTH_AUDIENCE,
          jwksCacheMs: OAUTH_JWKS_CACHE_MS,
          clockSkewSeconds: OAUTH_CLOCK_SKEW_SECONDS,
        })
      : null);
  const rateLimiter = new RateLimiter({ limit: RATE_LIMIT_PER_MINUTE });

  const server = http.createServer(async (req, res) => {
    const requestId = req.headers["x-request-id"] ?? randomUUID();
    res.setHeader("x-request-id", requestId);

    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (url.pathname === "/healthz") {
        json(res, 200, {
          status: "ok",
          version: VERSION,
          queue: {
            pending: queue.size,
          },
        });
        return;
      }

      if (url.pathname === "/.well-known/oauth-protected-resource") {
        if (!oauth) {
          json(res, 404, { error: "oauth_not_configured" });
          return;
        }
        if (req.method !== "GET") {
          res.writeHead(405, { allow: "GET" });
          res.end();
          return;
        }
        json(res, 200, await oauth.protectedResourceMetadata({ publicUrl }));
        return;
      }

      if (!rateLimiter.accept(remoteAddress(req))) {
        json(res, 429, { error: "rate_limit_exceeded" });
        return;
      }

      if (url.pathname === "/mcp") {
        let auth;
        try {
          if (!oauth) {
            throw new Error("OAuth is required for the public MCP endpoint.");
          }
          auth = await oauth.verifyRequest(req);
        } catch (error) {
          json(
            res,
            401,
            { error: "unauthorized", message: error.message },
            {
              "www-authenticate": bearerChallenge({
                publicUrl,
                error: error.code ?? "invalid_token",
                errorDescription: error.message,
              }),
            },
          );
          return;
        }
        if (!rateLimiter.accept(`oauth:${auth.subject ?? "unknown"}`)) {
          json(res, 429, { error: "rate_limit_exceeded" });
          return;
        }
        const { parsed } = await readBody(req);
        await handleMcp({ req, res, parsed, queue, auth });
        return;
      }

      if (
        url.pathname === "/agent/jobs/claim" ||
        url.pathname === "/agent/jobs/result" ||
        url.pathname === "/agent/status"
      ) {
        const { raw, parsed } = await readBody(req);
        let auth;
        try {
          auth = authorizeAgent({ req, url, rawBody: raw, credentials: agents });
        } catch (error) {
          json(res, 401, { error: "unauthorized", message: error.message });
          return;
        }
        if (!rateLimiter.accept(`agent:${auth.keyId}`)) {
          json(res, 429, { error: "rate_limit_exceeded" });
          return;
        }
        await handleAgent({ req, res, url, parsed, queue });
        return;
      }

      json(res, 404, { error: "not_found" });
    } catch (error) {
      json(res, error.statusCode ?? 500, {
        error:
          error.statusCode === 413
            ? "request_too_large"
            : error.code === "invalid_json"
              ? "invalid_json"
              : "internal_error",
        requestId,
        message: error.message,
      });
    }
  });
  server.queue = queue;
  return server;
}

async function handleMcp({ req, res, parsed, queue, auth }) {
  if (req.method === "DELETE") {
    res.writeHead(204, { "cache-control": "no-store" });
    res.end();
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST, DELETE" });
    res.end();
    return;
  }

  const message = parsed;
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    json(res, 400, rpcError(message?.id, -32600, "Invalid JSON-RPC request."));
    return;
  }
  if (message.id === undefined) {
    res.writeHead(202, { "cache-control": "no-store" });
    res.end();
    return;
  }

  let result;
  switch (message.method) {
    case "initialize":
      result = {
        protocolVersion: message.params?.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: "biotele-hostinger-relay",
          title: "Biotele Hostinger MCP Relay",
          version: VERSION,
        },
        instructions:
          "This endpoint queues Codex supervisor jobs for an outbound-only local Windows agent. Use allowed roots only; network access remains disabled unless the local agent is explicitly configured otherwise.",
      };
      break;

    case "ping":
      result = {};
      break;

    case "tools/list":
      try {
        requireScope(auth, READ_SCOPE);
      } catch (error) {
        json(res, 200, rpcError(message.id, -32001, error.message, { requiredScope: error.scope }));
        return;
      }
      result = { tools: TOOL_DEFINITIONS };
      break;

    case "tools/call": {
      const name = message.params?.name;
      const args = message.params?.arguments ?? {};
      if (!TOOL_DEFINITIONS.some((tool) => tool.name === name)) {
        json(res, 200, rpcError(message.id, -32602, `Unknown tool: ${String(name)}`));
        return;
      }

      const requiredScope = WRITE_TOOLS.has(name) ? WRITE_SCOPE : READ_TOOLS.has(name) ? READ_SCOPE : null;
      if (!requiredScope) {
        json(res, 200, rpcError(message.id, -32602, `Unknown authorization category for tool: ${String(name)}`));
        return;
      }
      try {
        requireScope(auth, requiredScope);
      } catch (error) {
        json(res, 200, rpcError(message.id, -32001, error.message, { requiredScope: error.scope }));
        return;
      }

      try {
        const job = queue.enqueue({
          toolName: name,
          arguments: args,
          requestId: String(message.id),
        });
        const outcome = await queue.waitForResult(job, {
          timeoutMs: Math.min(MCP_WAIT_MS, JOB_TTL_MS),
        });
        result = outcome.result ?? toolErrorResult(outcome.error);
      } catch (error) {
        json(res, 200, rpcError(message.id, -32000, error.message));
        return;
      }
      break;
    }

    default:
      json(res, 200, rpcError(message.id, -32601, `Method not found: ${message.method}`));
      return;
  }

  json(res, 200, {
    jsonrpc: "2.0",
    id: message.id,
    result,
  });
}

async function handleAgent({ req, res, url, parsed, queue }) {
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST" });
    res.end();
    return;
  }

  if (url.pathname === "/agent/status") {
    json(res, 200, {
      status: "ok",
      version: VERSION,
      queue: {
        pending: queue.size,
      },
    });
    return;
  }

  if (url.pathname === "/agent/jobs/claim") {
    const waitMs = Math.max(
      0,
      Math.min(Number.parseInt(parsed?.maxWaitMs ?? String(AGENT_POLL_MS), 10), AGENT_POLL_MS),
    );
    const job = await queue.waitForClaimable({ timeoutMs: waitMs });
    if (!job) {
      res.writeHead(204, { "cache-control": "no-store" });
      res.end();
      return;
    }
    json(res, 200, { job });
    return;
  }

  const jobId = parsed?.jobId;
  const leaseId = parsed?.leaseId;
  if (typeof jobId !== "string" || typeof leaseId !== "string") {
    json(res, 400, { error: "invalid_result_submission" });
    return;
  }
  try {
    queue.complete({
      jobId,
      leaseId,
      result: parsed.result,
      error: parsed.error,
    });
  } catch (error) {
    json(res, 409, { error: "result_rejected", message: error.message });
    return;
  }
  json(res, 202, { accepted: true });
}

export async function main() {
  validateStartupConfig();
  const server = createHostingerRelayServer();
  server.listen(PORT, HOST, () => {
    process.stderr.write(`Biotele Hostinger relay v${VERSION} listening on ${HOST}:${PORT}\n`);
    process.stderr.write(`MCP endpoint: /mcp; health: /healthz\n`);
  });

  const shutdown = () => {
    server.queue?.shutdown?.("Relay is shutting down.");
    server.closeIdleConnections?.();
    server.close(() => {
      process.exitCode = 0;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
