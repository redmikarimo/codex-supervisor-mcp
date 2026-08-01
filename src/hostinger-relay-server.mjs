import http from "node:http";
import { randomUUID } from "node:crypto";

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
const DEFAULT_PUBLIC_URL = "https://mcp.biotele.mx";
const DEFAULT_READ_SCOPE = "biotele.mcp.read";
const DEFAULT_WRITE_SCOPE = "biotele.mcp.write";

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

function positiveIntegerFromEnv(env, name, defaultValue) {
  const raw = env[name] ?? String(defaultValue);
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

export function requiredPort(env = process.env) {
  if (env.PORT === undefined || String(env.PORT).trim() === "") {
    return 3000;
  }
  const value = Number(env.PORT);
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new Error("PORT must be an integer from 0 to 65535 when provided.");
  }
  return value;
}

function buildRuntimeConfig({
  env = process.env,
  agentCredentials,
  oauthResourceServer,
  publicUrl = undefined,
  queue,
} = {}) {
  const resolvedPublicUrl = (publicUrl ?? env.BIOTELE_RELAY_PUBLIC_URL ?? DEFAULT_PUBLIC_URL).replace(/\/+$/, "");
  const oauthRequired = (env.BIOTELE_RELAY_OAUTH_REQUIRED ?? "true").toLowerCase() !== "false";
  const maxBodyBytes = positiveIntegerFromEnv(env, "BIOTELE_RELAY_MAX_BODY_BYTES", 262_144);
  const rateLimitPerMinute = positiveIntegerFromEnv(env, "BIOTELE_RELAY_RATE_LIMIT_PER_MINUTE", 120);
  const mcpWaitMs = positiveIntegerFromEnv(env, "BIOTELE_RELAY_MCP_WAIT_MS", 55_000);
  const agentPollMs = positiveIntegerFromEnv(env, "BIOTELE_RELAY_AGENT_POLL_MS", 25_000);
  const jobTtlMs = positiveIntegerFromEnv(env, "BIOTELE_RELAY_JOB_TTL_MS", 120_000);
  const jobLeaseMs = positiveIntegerFromEnv(env, "BIOTELE_RELAY_JOB_LEASE_MS", 60_000);
  const maxQueuedJobs = positiveIntegerFromEnv(env, "BIOTELE_RELAY_MAX_QUEUED_JOBS", 200);
  const oauthJwksCacheMs = positiveIntegerFromEnv(env, "BIOTELE_RELAY_OAUTH_JWKS_CACHE_MS", 600_000);
  const oauthClockSkewSeconds = positiveIntegerFromEnv(env, "BIOTELE_RELAY_OAUTH_CLOCK_SKEW_SECONDS", 60);

  const agents =
    agentCredentials ?? parseCredentialMap(env.BIOTELE_RELAY_AGENT_KEYS, "BIOTELE_RELAY_AGENT_KEYS");
  const oauth =
    oauthResourceServer ??
    (oauthRequired
      ? new OAuthResourceServer({
          issuer: env.BIOTELE_RELAY_OAUTH_ISSUER,
          audience: env.BIOTELE_RELAY_OAUTH_AUDIENCE,
          jwksCacheMs: oauthJwksCacheMs,
          clockSkewSeconds: oauthClockSkewSeconds,
        })
      : null);

  return {
    publicUrl: resolvedPublicUrl,
    maxBodyBytes,
    rateLimiter: new RateLimiter({ limit: rateLimitPerMinute }),
    mcpWaitMs,
    agentPollMs,
    readScope: env.BIOTELE_RELAY_OAUTH_READ_SCOPE ?? DEFAULT_READ_SCOPE,
    writeScope: env.BIOTELE_RELAY_OAUTH_WRITE_SCOPE ?? DEFAULT_WRITE_SCOPE,
    queue:
      queue ??
      new RelayQueue({
        jobTtlMs,
        leaseMs: jobLeaseMs,
        maxQueuedJobs,
      }),
    agents,
    oauth,
  };
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

async function readBody(req, maxBodyBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      throw Object.assign(new Error(`Request body exceeds ${maxBodyBytes} bytes.`), {
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

function authorizeAgent({ req, url, rawBody, credentials, nonceStore }) {
  return verifySignedRequest({
    req,
    url,
    body: rawBody,
    credentials,
    nonceStore,
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

function sanitizedError(error) {
  return {
    type: error?.name ?? "Error",
    message: String(error?.message ?? error),
  };
}

export function createHostingerRelayServer({
  env = process.env,
  logger = process.stderr,
  agentCredentials,
  oauthResourceServer,
  publicUrl,
  queue,
  autoInitialize = true,
  initializeDelayMs = 0,
} = {}) {
  const state = {
    status: "initializing",
    error: null,
    config: null,
    nonceStore: new NonceStore(),
    initialized: false,
  };

  const server = http.createServer(async (req, res) => {
    const requestId = req.headers["x-request-id"] ?? randomUUID();
    res.setHeader("x-request-id", requestId);

    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (url.pathname === "/healthz") {
        json(res, 200, {
          status: "ok",
          version: VERSION,
          readiness: state.status,
          queue: {
            pending: state.config?.queue?.size ?? 0,
          },
        });
        return;
      }

      if (url.pathname === "/readyz") {
        if (state.status !== "ready") {
          json(res, 503, {
            status: state.status,
            ...(state.error ? { error: state.error } : {}),
          });
          return;
        }
        json(res, 200, { status: "ready" });
        return;
      }

      if (state.status !== "ready") {
        json(res, 503, {
          error: "not_ready",
          status: state.status,
          ...(state.error ? { details: state.error } : {}),
        });
        return;
      }

      const config = state.config;

      if (url.pathname === "/.well-known/oauth-protected-resource") {
        if (!config.oauth) {
          json(res, 404, { error: "oauth_not_configured" });
          return;
        }
        if (req.method !== "GET") {
          res.writeHead(405, { allow: "GET" });
          res.end();
          return;
        }
        json(res, 200, await config.oauth.protectedResourceMetadata({ publicUrl: config.publicUrl }));
        return;
      }

      if (!config.rateLimiter.accept(remoteAddress(req))) {
        json(res, 429, { error: "rate_limit_exceeded" });
        return;
      }

      if (url.pathname === "/mcp") {
        let auth;
        try {
          if (!config.oauth) {
            throw new Error("OAuth is required for the public MCP endpoint.");
          }
          auth = await config.oauth.verifyRequest(req);
        } catch (error) {
          json(
            res,
            401,
            { error: "unauthorized", message: error.message },
            {
              "www-authenticate": bearerChallenge({
                publicUrl: config.publicUrl,
                error: error.code ?? "invalid_token",
                errorDescription: error.message,
              }),
            },
          );
          return;
        }
        if (!config.rateLimiter.accept(`oauth:${auth.subject ?? "unknown"}`)) {
          json(res, 429, { error: "rate_limit_exceeded" });
          return;
        }
        const { parsed } = await readBody(req, config.maxBodyBytes);
        await handleMcp({ req, res, parsed, config, auth });
        return;
      }

      if (
        url.pathname === "/agent/jobs/claim" ||
        url.pathname === "/agent/jobs/result" ||
        url.pathname === "/agent/status"
      ) {
        const { raw, parsed } = await readBody(req, config.maxBodyBytes);
        let auth;
        try {
          auth = authorizeAgent({
            req,
            url,
            rawBody: raw,
            credentials: config.agents,
            nonceStore: state.nonceStore,
          });
        } catch (error) {
          json(res, 401, { error: "unauthorized", message: error.message });
          return;
        }
        if (!config.rateLimiter.accept(`agent:${auth.keyId}`)) {
          json(res, 429, { error: "rate_limit_exceeded" });
          return;
        }
        await handleAgent({ req, res, url, parsed, config });
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

  server.queue = {
    shutdown(message) {
      state.config?.queue?.shutdown(message);
    },
  };
  server.readiness = state;
  server.initialize = async () => {
    if (state.initialized) {
      return state;
    }
    state.initialized = true;
    try {
      if (initializeDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, initializeDelayMs));
      }
      state.config = buildRuntimeConfig({
        env,
        agentCredentials,
        oauthResourceServer,
        publicUrl,
        queue,
      });
      state.status = "ready";
      state.error = null;
      logger.write?.("Hostinger relay ready\n");
    } catch (error) {
      state.status = "failed";
      state.error = sanitizedError(error);
      logger.write?.(`Hostinger relay initialization failed: ${state.error.type}: ${state.error.message}\n`);
    }
    return state;
  };

  if (autoInitialize) {
    setImmediate(() => {
      void server.initialize();
    });
  }

  return server;
}

async function handleMcp({ req, res, parsed, config, auth }) {
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
        requireScope(auth, config.readScope);
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

      const requiredScope = WRITE_TOOLS.has(name)
        ? config.writeScope
        : READ_TOOLS.has(name)
          ? config.readScope
          : null;
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
        const job = config.queue.enqueue({
          toolName: name,
          arguments: args,
          requestId: String(message.id),
        });
        const outcome = await config.queue.waitForResult(job, {
          timeoutMs: Math.min(config.mcpWaitMs, config.queue.jobTtlMs),
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

async function handleAgent({ req, res, url, parsed, config }) {
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
        pending: config.queue.size,
      },
    });
    return;
  }

  if (url.pathname === "/agent/jobs/claim") {
    const waitMs = Math.max(
      0,
      Math.min(Number.parseInt(parsed?.maxWaitMs ?? String(config.agentPollMs), 10), config.agentPollMs),
    );
    const job = await config.queue.waitForClaimable({ timeoutMs: waitMs });
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
    config.queue.complete({
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

export function startHostingerRelay({
  env = process.env,
  logger = process.stderr,
  hostname = "0.0.0.0",
} = {}) {
  const port = requiredPort(env);
  const server = createHostingerRelayServer({ env, logger, autoInitialize: false });
  server.listen(port, hostname, () => {
    logger.write?.(`Hostinger relay listening on port ${port}\n`);
    void server.initialize();
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
  return server;
}
