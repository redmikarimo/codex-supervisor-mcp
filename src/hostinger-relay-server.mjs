import http from "node:http";
import { createHash, randomUUID } from "node:crypto";

import {
  REEVES_AGENT_KEY_ID,
  REEVES_TOOL_DEFINITIONS,
  routeForAgentKeyId,
} from "./agent-routing.mjs";
import { sanitizeErrorData, sanitizeErrorText } from "./error-sanitization.mjs";
import { TOOL_DEFINITIONS } from "./tool-registry.mjs";
import {
  NonceStore,
  parseCredentialMap,
  verifySignedRequest,
} from "./relay-auth.mjs";
import { OAuthResourceServer, bearerChallenge } from "./oauth-resource-server.mjs";
import { RelayQueue } from "./relay-queue.mjs";
import { RelayMonitor, monitorConfigFromEnv } from "./relay-monitor.mjs";
import {
  DEFAULT_MAX_RESULT_BYTES,
  DEFAULT_RESULT_CHUNK_BYTES,
  MIN_RESULT_BYTES,
  ResultSubmissionAssembler,
  resultSubmissionCapabilities,
} from "./relay-result-protocol.mjs";

const VERSION = "1.2.5";
const DEFAULT_PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([DEFAULT_PROTOCOL_VERSION]);
const DEFAULT_PUBLIC_URL = "https://mcp.biotele.mx";
const DEFAULT_READ_SCOPE = "biotele.mcp.read";
const DEFAULT_WRITE_SCOPE = "biotele.mcp.write";
const DEFAULT_AGENT_KEY_ID = "windows-agent-1";
const DEFAULT_MCP_SESSION_TTL_MS = 24 * 60 * 60_000;
const BASE64_SECRET_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const MCP_SESSION_PATTERN = /^[\x21-\x7e]{1,128}$/;

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
  "reeves_tap",
  "reeves_swipe",
  "reeves_type",
  "reeves_back",
  "reeves_home",
  "reeves_recents",
  "reeves_sequence",
]);
READ_TOOLS.add("reeves_status");
READ_TOOLS.add("reeves_screenshot");
const HOSTED_TOOL_DEFINITIONS = Object.freeze([
  ...TOOL_DEFINITIONS,
  ...REEVES_TOOL_DEFINITIONS,
]);

function positiveIntegerFromEnv(env, name, defaultValue) {
  const raw = env[name] ?? String(defaultValue);
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function booleanFromEnv(env, name, defaultValue = false) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === "") {
    return defaultValue;
  }
  if (/^(?:1|true)$/i.test(String(raw).trim())) {
    return true;
  }
  if (/^(?:0|false)$/i.test(String(raw).trim())) {
    return false;
  }
  throw new Error(`${name} must be true, false, 1, or 0.`);
}

function standaloneBase64Secret(value) {
  const secret = String(value ?? "").trim();
  if (!BASE64_SECRET_PATTERN.test(secret) || secret.length % 4 !== 0) {
    return null;
  }
  const decoded = Buffer.from(secret, "base64");
  if (decoded.length < 32 || decoded.toString("base64") !== secret) {
    return null;
  }
  return secret;
}

function agentCredentialsFromEnv(env) {
  const keyId = env.BIOTELE_RELAY_AGENT_KEY_ID;
  const secret = env.BIOTELE_RELAY_AGENT_SECRET;
  let credentials;
  if (secret !== undefined && String(secret).trim() !== "") {
    const resolvedKeyId = keyId && String(keyId).trim() ? keyId : DEFAULT_AGENT_KEY_ID;
    credentials = parseCredentialMap(
      `${resolvedKeyId}:${secret}`,
      "BIOTELE_RELAY_AGENT_KEY_ID",
    );
  } else if (keyId !== undefined && String(keyId).trim() !== "") {
    throw new Error("BIOTELE_RELAY_AGENT_SECRET is required when BIOTELE_RELAY_AGENT_KEY_ID is set.");
  } else {
    const legacy = env.BIOTELE_RELAY_AGENT_KEYS;
    const standaloneSecret = standaloneBase64Secret(legacy);
    credentials = parseCredentialMap(
      standaloneSecret ? `${DEFAULT_AGENT_KEY_ID}:${standaloneSecret}` : legacy,
      "BIOTELE_RELAY_AGENT_KEYS",
    );
  }

  const reevesKeyId = env.BIOTELE_RELAY_REEVES_AGENT_KEY_ID;
  const reevesSecret = env.BIOTELE_RELAY_REEVES_AGENT_SECRET;
  const hasReevesKeyId = reevesKeyId !== undefined && String(reevesKeyId).trim() !== "";
  const hasReevesSecret = reevesSecret !== undefined && String(reevesSecret).trim() !== "";
  if (hasReevesKeyId && !hasReevesSecret) {
    throw new Error(
      "BIOTELE_RELAY_REEVES_AGENT_SECRET is required when BIOTELE_RELAY_REEVES_AGENT_KEY_ID is set.",
    );
  }
  if (hasReevesSecret) {
    const resolvedReevesKeyId = hasReevesKeyId ? String(reevesKeyId).trim() : REEVES_AGENT_KEY_ID;
    if (resolvedReevesKeyId !== REEVES_AGENT_KEY_ID) {
      throw new Error(
        `BIOTELE_RELAY_REEVES_AGENT_KEY_ID must be ${REEVES_AGENT_KEY_ID}.`,
      );
    }
    const reevesCredentials = parseCredentialMap(
      `${resolvedReevesKeyId}:${reevesSecret}`,
      "BIOTELE_RELAY_REEVES_AGENT_KEY_ID",
    );
    credentials.set(REEVES_AGENT_KEY_ID, reevesCredentials.get(REEVES_AGENT_KEY_ID));
  }
  return credentials;
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
  const trustProxy = booleanFromEnv(env, "BIOTELE_RELAY_TRUST_PROXY", false);
  const maxBodyBytes = positiveIntegerFromEnv(env, "BIOTELE_RELAY_MAX_BODY_BYTES", 262_144);
  const rateLimitPerMinute = positiveIntegerFromEnv(env, "BIOTELE_RELAY_RATE_LIMIT_PER_MINUTE", 120);
  const resultRateLimitPerMinute = positiveIntegerFromEnv(
    env,
    "BIOTELE_RELAY_RESULT_RATE_LIMIT_PER_MINUTE",
    600,
  );
  const mcpWaitMs = positiveIntegerFromEnv(env, "BIOTELE_RELAY_MCP_WAIT_MS", 55_000);
  const agentPollMs = positiveIntegerFromEnv(env, "BIOTELE_RELAY_AGENT_POLL_MS", 25_000);
  const jobTtlMs = positiveIntegerFromEnv(env, "BIOTELE_RELAY_JOB_TTL_MS", 120_000);
  const jobLeaseMs = positiveIntegerFromEnv(env, "BIOTELE_RELAY_JOB_LEASE_MS", 60_000);
  const maxQueuedJobs = positiveIntegerFromEnv(env, "BIOTELE_RELAY_MAX_QUEUED_JOBS", 200);
  const maxResultBytes = positiveIntegerFromEnv(
    env,
    "BIOTELE_RELAY_MAX_RESULT_BYTES",
    DEFAULT_MAX_RESULT_BYTES,
  );
  if (maxResultBytes > DEFAULT_MAX_RESULT_BYTES) {
    throw new Error(
      `BIOTELE_RELAY_MAX_RESULT_BYTES may not exceed ${DEFAULT_MAX_RESULT_BYTES}.`,
    );
  }
  if (maxResultBytes < MIN_RESULT_BYTES) {
    throw new Error(`BIOTELE_RELAY_MAX_RESULT_BYTES must be at least ${MIN_RESULT_BYTES}.`);
  }
  if (jobLeaseMs < mcpWaitMs) {
    throw new Error("BIOTELE_RELAY_JOB_LEASE_MS must be at least BIOTELE_RELAY_MCP_WAIT_MS.");
  }
  const safeChunkBytes = Math.floor(Math.max(0, maxBodyBytes - 4_096) * 3 / 4);
  const resultChunkBytes = Math.min(DEFAULT_RESULT_CHUNK_BYTES, safeChunkBytes);
  if (resultChunkBytes < 1_024) {
    throw new Error("BIOTELE_RELAY_MAX_BODY_BYTES is too small for bounded result submissions.");
  }
  const oauthJwksCacheMs = positiveIntegerFromEnv(env, "BIOTELE_RELAY_OAUTH_JWKS_CACHE_MS", 600_000);
  const oauthClockSkewSeconds = positiveIntegerFromEnv(env, "BIOTELE_RELAY_OAUTH_CLOCK_SKEW_SECONDS", 60);

  const agents = agentCredentials ?? agentCredentialsFromEnv(env);
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
  const resolvedQueue =
    queue ??
    new RelayQueue({
      jobTtlMs,
      leaseMs: jobLeaseMs,
      maxQueuedJobs,
    });
  const resultSubmission = resultSubmissionCapabilities({
    maxResultBytes,
    chunkBytes: resultChunkBytes,
  });
  const idempotency = new ToolCallIdempotency({
    ttlMs: jobTtlMs,
    maxEntries: maxQueuedJobs,
  });
  const sessions = new McpSessionRegistry({
    ttlMs: DEFAULT_MCP_SESSION_TTL_MS,
    maxEntries: Math.min(10_000, Math.max(100, maxQueuedJobs * 10)),
    onInvalidate: ({ subject, sessionId, message }) => {
      idempotency.invalidateSession({ subject, sessionId, message });
    },
  });

  return {
    publicUrl: resolvedPublicUrl,
    trustProxy,
    maxBodyBytes,
    rateLimiter: new RateLimiter({ limit: rateLimitPerMinute }),
    agentAuthFailureLimiter: new RateLimiter({ limit: rateLimitPerMinute }),
    resultRateLimiter: new RateLimiter({ limit: resultRateLimitPerMinute }),
    mcpWaitMs,
    agentPollMs,
    readScope: env.BIOTELE_RELAY_OAUTH_READ_SCOPE ?? DEFAULT_READ_SCOPE,
    writeScope: env.BIOTELE_RELAY_OAUTH_WRITE_SCOPE ?? DEFAULT_WRITE_SCOPE,
    queue: resolvedQueue,
    idempotency,
    sessions,
    resultSubmission,
    resultAssembler: new ResultSubmissionAssembler({
      maxResultBytes,
      chunkBytes: resultChunkBytes,
      ttlMs: jobTtlMs,
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
      message: sanitizeErrorText(message),
      ...(data === undefined ? {} : { data: sanitizeErrorData(data) }),
    },
  };
}

function toolErrorResult(error) {
  const safeError = sanitizeErrorData(error);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: safeError }, null, 2),
      },
    ],
    structuredContent: { error: safeError },
    isError: true,
  };
}

function withRelayTiming(result, relayTiming, mcpReturnedAt) {
  if (
    !relayTiming ||
    !result ||
    typeof result !== "object" ||
    Array.isArray(result)
  ) {
    return result;
  }
  const structuredContent =
    result.structuredContent &&
    typeof result.structuredContent === "object" &&
    !Array.isArray(result.structuredContent)
      ? result.structuredContent
      : {};
  const relay = {
    ...relayTiming,
    mcpReturnedAt,
    requestToQueueMs: relayTiming.queuedAt - relayTiming.mcpReceivedAt,
    queueToClaimMs: relayTiming.claimedAt - relayTiming.queuedAt,
    claimToResultMs: relayTiming.resultReceivedAt - relayTiming.claimedAt,
    resultToMcpReturnMs: mcpReturnedAt - relayTiming.resultReceivedAt,
    totalServerMs: mcpReturnedAt - relayTiming.mcpReceivedAt,
  };
  return {
    ...result,
    structuredContent: {
      ...structuredContent,
      timing: {
        ...(structuredContent.timing &&
        typeof structuredContent.timing === "object" &&
        !Array.isArray(structuredContent.timing)
          ? structuredContent.timing
          : {}),
        relay,
      },
    },
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
    return this.record(key) <= this.limit;
  }

  isBlocked(key) {
    const minute = Math.floor(Date.now() / 60_000);
    return (this.buckets.get(`${key}:${minute}`) ?? 0) >= this.limit;
  }

  record(key) {
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
    return count;
  }
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function toolCallHash(message) {
  return createHash("sha256")
    .update(canonicalJson({
      jsonrpc: message.jsonrpc,
      method: message.method,
      params: message.params ?? null,
    }))
    .digest("base64url");
}

function typedRpcId(id) {
  return canonicalJson([id === null ? "null" : typeof id, id]);
}

function negotiateProtocolVersion(requested) {
  return SUPPORTED_PROTOCOL_VERSIONS.has(requested)
    ? requested
    : DEFAULT_PROTOCOL_VERSION;
}

function sessionError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}

function requestSessionId(req) {
  const header = req.headers["mcp-session-id"];
  if (header === undefined) {
    throw sessionError(
      400,
      "mcp_session_required",
      "Mcp-Session-Id is required after initialize.",
    );
  }
  if (Array.isArray(header) || !MCP_SESSION_PATTERN.test(header)) {
    throw sessionError(
      400,
      "invalid_mcp_session",
      "Mcp-Session-Id must be one visible ASCII value of at most 128 characters.",
    );
  }
  return header;
}

class McpSessionRegistry {
  constructor({ ttlMs, maxEntries, now = () => Date.now(), onInvalidate = () => {} }) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.onInvalidate = onInvalidate;
    this.entries = new Map();
  }

  issue(subject) {
    this.#reap();
    if (this.entries.size >= this.maxEntries) {
      throw sessionError(503, "mcp_session_capacity", "MCP session capacity is exhausted.");
    }
    let sessionId;
    do {
      sessionId = randomUUID();
    } while (this.entries.has(sessionId));
    this.entries.set(sessionId, {
      subject,
      expiresAt: this.now() + this.ttlMs,
    });
    return sessionId;
  }

  require(req, subject) {
    this.#reap();
    const sessionId = requestSessionId(req);
    const entry = this.entries.get(sessionId);
    if (!entry || entry.subject !== subject) {
      throw sessionError(404, "mcp_session_not_found", "MCP session was not found.");
    }
    entry.expiresAt = this.now() + this.ttlMs;
    return sessionId;
  }

  terminate(req, subject, message = "MCP session terminated by the client.") {
    const sessionId = this.require(req, subject);
    this.#remove(sessionId, message);
    return sessionId;
  }

  shutdown(message = "Relay is shutting down.") {
    for (const sessionId of [...this.entries.keys()]) {
      this.#remove(sessionId, message);
    }
  }

  #remove(sessionId, message) {
    const entry = this.entries.get(sessionId);
    if (!entry) {
      return false;
    }
    this.entries.delete(sessionId);
    this.onInvalidate({ subject: entry.subject, sessionId, message });
    return true;
  }

  #reap() {
    const now = this.now();
    for (const [sessionId, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.#remove(sessionId, "MCP session expired.");
      }
    }
  }
}

function disconnectSignal(req, res) {
  const controller = new AbortController();
  const reason = Object.assign(new Error("MCP client disconnected."), {
    name: "AbortError",
  });
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  };
  const onResponseClose = () => {
    if (!res.writableEnded) {
      abort();
    }
  };
  req.once("aborted", abort);
  res.once("close", onResponseClose);
  if (req.aborted || (res.destroyed && !res.writableEnded)) {
    abort();
  }
  return {
    signal: controller.signal,
    cleanup() {
      req.removeListener("aborted", abort);
      res.removeListener("close", onResponseClose);
    },
  };
}

class ToolCallIdempotency {
  constructor({ ttlMs, maxEntries, now = () => Date.now() }) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
  }

  async execute({ key, hash, subject, sessionId, signal, start }) {
    this.#reap();
    if (signal?.aborted) {
      throw signal.reason;
    }

    let entry = this.entries.get(key);
    if (entry) {
      if (entry.hash !== hash) {
        throw Object.assign(
          new Error("The JSON-RPC id was already used for a different tools/call payload in this MCP session."),
          { name: "IdempotencyConflict", code: "idempotency_conflict" },
        );
      }
    } else {
      this.#makeRoom();
      const controller = new AbortController();
      entry = {
        hash,
        subject,
        sessionId,
        controller,
        state: "pending",
        subscribers: 0,
        expiresAt: Number.POSITIVE_INFINITY,
        promise: null,
      };
      this.entries.set(key, entry);
      entry.promise = Promise.resolve()
        .then(() => start(controller.signal))
        .then(
          (value) => {
            this.#settle(key, entry);
            return value;
          },
          (error) => {
            this.#settle(key, entry);
            throw error;
          },
        );
      // A disconnected sole subscriber can leave the shared operation settling
      // asynchronously. Keep its rejection observed while retaining it for retry.
      void entry.promise.catch(() => {});
    }

    return await this.#subscribe(entry, signal);
  }

  invalidateSession({ subject, sessionId, message = "MCP session terminated." }) {
    const reason = Object.assign(new Error(message), { name: "AbortError" });
    for (const [key, entry] of this.entries) {
      if (entry.subject !== subject || entry.sessionId !== sessionId) {
        continue;
      }
      this.entries.delete(key);
      if (entry.state === "pending" && !entry.controller.signal.aborted) {
        entry.controller.abort(reason);
      }
    }
  }

  shutdown(message = "Relay is shutting down.") {
    const reason = Object.assign(new Error(message), { name: "AbortError" });
    for (const entry of this.entries.values()) {
      if (entry.state === "pending" && !entry.controller.signal.aborted) {
        entry.controller.abort(reason);
      }
    }
    this.entries.clear();
  }

  async #subscribe(entry, signal) {
    entry.subscribers += 1;
    return await new Promise((resolve, reject) => {
      let finished = false;
      const release = () => {
        if (finished) {
          return false;
        }
        finished = true;
        signal?.removeEventListener("abort", onAbort);
        entry.subscribers -= 1;
        return true;
      };
      const onAbort = () => {
        if (!release()) {
          return;
        }
        const reason = signal.reason ?? Object.assign(new Error("MCP client disconnected."), {
          name: "AbortError",
        });
        if (
          entry.state === "pending" &&
          entry.subscribers === 0 &&
          !entry.controller.signal.aborted
        ) {
          entry.controller.abort(reason);
        }
        reject(reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      entry.promise.then(
        (value) => {
          if (release()) {
            resolve(value);
          }
        },
        (error) => {
          if (release()) {
            reject(error);
          }
        },
      );
    });
  }

  #settle(key, entry) {
    if (this.entries.get(key) !== entry) {
      return;
    }
    entry.state = "settled";
    entry.expiresAt = this.now() + this.ttlMs;
  }

  #makeRoom() {
    while (this.entries.size >= this.maxEntries) {
      const settled = [...this.entries].find(([, entry]) => entry.state === "settled");
      if (!settled) {
        throw new Error("Relay idempotency registry is full.");
      }
      this.entries.delete(settled[0]);
    }
  }

  #reap() {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.state === "settled" && entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }
}

function remoteAddress(req, trustProxy = false) {
  const forwarded = req.headers["x-forwarded-for"];
  if (trustProxy && typeof forwarded === "string" && forwarded.trim()) {
    const chain = forwarded
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    const nearestForwardedAddress = chain.at(-1);
    if (nearestForwardedAddress && nearestForwardedAddress.length <= 256) {
      return nearestForwardedAddress;
    }
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
    type: sanitizeErrorText(error?.name ?? "Error", 128).replace(
      /[\u0000-\u001f\u007f]/g,
      " ",
    ),
    message: sanitizeErrorText(error?.message ?? error).replace(
      /[\u0000-\u001f\u007f]/g,
      " ",
    ),
  };
}

function agentLogField(value, fallback = "unknown") {
  const sanitized = sanitizeErrorText(value ?? fallback, 160)
    .replace(/[\u0000-\u0020\u007f]+/g, "_")
    .replace(/[^A-Za-z0-9_.:/-]/g, "_");
  return sanitized || fallback;
}

function observeAgentRequest({ req, res, url, requestId, logger, errorLogger }) {
  if (!url.pathname.startsWith("/agent/")) {
    return null;
  }
  const context = {
    keyId: "unverified",
    rejectionReason: "",
  };
  res.once("finish", () => {
    const status = res.statusCode;
    const sink = status >= 400 ? errorLogger : logger;
    const reason = context.rejectionReason
      ? ` reason=${agentLogField(context.rejectionReason)}`
      : "";
    sink.write?.(
      `Hostinger relay agent request: requestId=${agentLogField(requestId)} ` +
        `method=${agentLogField(req.method)} path=${agentLogField(url.pathname)} ` +
        `status=${status} agent=${agentLogField(context.keyId)}${reason}\n`,
    );
  });
  return context;
}

export function createHostingerRelayServer({
  env = process.env,
  logger = process.stdout,
  errorLogger = logger === process.stdout ? process.stderr : logger,
  agentCredentials,
  oauthResourceServer,
  publicUrl,
  queue,
  monitorFetch,
  monitorNow,
  autoInitialize = true,
  initializeDelayMs = 0,
  initializeBlocker = undefined,
} = {}) {
  const state = {
    status: "initializing",
    error: null,
    config: null,
    nonceStore: new NonceStore(),
    initialized: false,
    lastAgentSeenAt: null,
  };
  const monitor = new RelayMonitor({
    state,
    config: monitorConfigFromEnv(env),
    logger,
    errorLogger,
    fetchImpl: monitorFetch,
    now: monitorNow,
  });

  const server = http.createServer(async (req, res) => {
    const requestReceivedAt = Date.now();
    const requestId = req.headers["x-request-id"] ?? randomUUID();
    res.setHeader("x-request-id", requestId);

    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const agentLog = observeAgentRequest({
        req,
        res,
        url,
        requestId,
        logger,
        errorLogger,
      });

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

      if (url.pathname === "/monitorz") {
        const snapshot = monitor.toJSON();
        json(res, snapshot.status === "ok" ? 200 : 503, snapshot);
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

      const isAgentResult = url.pathname === "/agent/jobs/result";
      const preAuthAddress = remoteAddress(req, config.trustProxy);
      if (
        (isAgentResult && config.agentAuthFailureLimiter.isBlocked(preAuthAddress)) ||
        (!isAgentResult && !config.rateLimiter.accept(preAuthAddress))
      ) {
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
          if (typeof auth.subject !== "string" || !auth.subject.trim()) {
            throw Object.assign(new Error("OAuth access token must contain a nonempty subject."), {
              code: "invalid_token",
            });
          }
        } catch (error) {
          const safeMessage = sanitizeErrorText(error?.message ?? error);
          json(
            res,
            401,
            { error: "unauthorized", message: safeMessage },
            {
              "www-authenticate": bearerChallenge({
                publicUrl: config.publicUrl,
                error: error.code ?? "invalid_token",
                errorDescription: safeMessage.replace(/[\u0000-\u001f\u007f]/g, " "),
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
        await handleMcp({ req, res, parsed, config, auth, mcpReceivedAt: requestReceivedAt });
        return;
      }

      if (
        url.pathname === "/agent/jobs/claim" ||
        url.pathname === "/agent/jobs/result" ||
        url.pathname === "/agent/status" ||
        url.pathname === "/agent/monitor/test-alert"
      ) {
        let raw;
        let parsed;
        try {
          ({ raw, parsed } = await readBody(req, config.maxBodyBytes));
        } catch (error) {
          if (isAgentResult) {
            config.agentAuthFailureLimiter.record(preAuthAddress);
          }
          throw error;
        }
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
          if (isAgentResult) {
            config.agentAuthFailureLimiter.record(preAuthAddress);
          }
          if (agentLog) {
            agentLog.rejectionReason = error?.message ?? error;
          }
          json(res, 401, {
            error: "unauthorized",
            message: sanitizeErrorText(error?.message ?? error),
          });
          return;
        }
        const agentRateLimiter = isAgentResult
          ? config.resultRateLimiter
          : config.rateLimiter;
        if (!agentRateLimiter.accept(`agent:${auth.keyId}`)) {
          json(res, 429, { error: "rate_limit_exceeded" });
          return;
        }
        if (agentLog) {
          agentLog.keyId = auth.keyId;
        }
        monitor.recordAgentSeen();
        await handleAgent({ req, res, url, parsed, config, monitor, auth });
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
        message: sanitizeErrorText(error?.message ?? error),
      });
    }
  });

  server.queue = {
    shutdown(message) {
      state.config?.sessions?.shutdown(message);
      state.config?.idempotency?.shutdown(message);
      state.config?.queue?.shutdown(message);
    },
  };
  server.readiness = state;
  server.monitor = monitor;
  server.initialize = async () => {
    if (state.initialized) {
      return state;
    }
    state.initialized = true;
    try {
      if (initializeDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, initializeDelayMs));
      }
      if (initializeBlocker) {
        await initializeBlocker();
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
      errorLogger.write?.(
        `Hostinger relay initialization failed: ${state.error.type}: ${state.error.message}\n`,
      );
    }
    await monitor.check({ forceAlert: state.status !== "ready" });
    return state;
  };

  if (autoInitialize) {
    setImmediate(() => {
      void server.initialize();
      monitor.start();
    });
  }

  server.on("close", () => {
    monitor.stop();
    state.config?.sessions?.shutdown("Relay server closed.");
    state.config?.idempotency?.shutdown("Relay server closed.");
    state.config?.queue?.shutdown("Relay server closed.");
  });

  return server;
}

async function handleMcp({ req, res, parsed, config, auth, mcpReceivedAt }) {
  const subject = auth.subject;
  if (req.method === "DELETE") {
    try {
      config.sessions.terminate(req, subject);
    } catch (error) {
      json(res, error.statusCode ?? 400, {
        error: error.code ?? "invalid_mcp_session",
        message: sanitizeErrorText(error?.message ?? error),
      });
      return;
    }
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

  let sessionId;
  if (message.method !== "initialize") {
    try {
      sessionId = config.sessions.require(req, subject);
    } catch (error) {
      json(res, error.statusCode ?? 400, {
        error: error.code ?? "invalid_mcp_session",
        message: sanitizeErrorText(error?.message ?? error),
      });
      return;
    }
  }
  if (message.id === undefined) {
    res.writeHead(202, { "cache-control": "no-store" });
    res.end();
    return;
  }

  let result;
  switch (message.method) {
    case "initialize":
      sessionId = config.sessions.issue(subject);
      res.setHeader("mcp-session-id", sessionId);
      result = {
        protocolVersion: negotiateProtocolVersion(message.params?.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: "biotele-codex-supervisor",
          title: "Biotele Codex Supervisor",
          version: VERSION,
        },
        instructions:
          "This endpoint routes codex_* jobs to the outbound Windows agent and reeves_* jobs to the authenticated Reeves Android agent. Device-changing Reeves actions and Codex mutations require write scope.",
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
      result = { tools: HOSTED_TOOL_DEFINITIONS };
      break;

    case "tools/call": {
      const name = message.params?.name;
      const args = message.params?.arguments ?? {};
      if (!HOSTED_TOOL_DEFINITIONS.some((tool) => tool.name === name)) {
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

      const requestWait = disconnectSignal(req, res);
      try {
        const key = canonicalJson([
          subject,
          sessionId,
          typedRpcId(message.id),
        ]);
        const outcome = await config.idempotency.execute({
          key,
          hash: toolCallHash(message),
          subject,
          sessionId,
          signal: requestWait.signal,
          start: async (signal) => {
            const timeoutMs = Math.min(config.mcpWaitMs, config.queue.jobTtlMs);
            const job = config.queue.enqueue({
              toolName: name,
              arguments: args,
              requestId: String(message.id),
              resultTimeoutMs: timeoutMs,
              mcpReceivedAt,
            });
            return await config.queue.waitForResult(job, {
              timeoutMs,
              signal,
            });
          },
        });
        result = outcome.result ?? toolErrorResult(outcome.error);
        if (name.startsWith("reeves_")) {
          result = withRelayTiming(result, outcome.relayTiming, Date.now());
        }
      } catch (error) {
        if (requestWait.signal.aborted) {
          return;
        }
        json(
          res,
          200,
          rpcError(
            message.id,
            error?.code === "idempotency_conflict" ? -32009 : -32000,
            error.message,
            error?.code === "idempotency_conflict"
              ? { type: "IdempotencyConflict" }
              : undefined,
          ),
        );
        return;
      } finally {
        requestWait.cleanup();
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

async function handleAgent({ req, res, url, parsed, config, monitor, auth }) {
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST" });
    res.end();
    return;
  }

  if (url.pathname === "/agent/status") {
    json(res, 200, {
      status: "ok",
      version: VERSION,
      resultSubmission: config.resultSubmission,
      queue: {
        pending: config.queue.size,
      },
    });
    return;
  }

  if (url.pathname === "/agent/monitor/test-alert") {
    const delivery = await monitor.sendTestAlert();
    json(res, 202, { accepted: true, delivery });
    return;
  }

  if (url.pathname === "/agent/jobs/claim") {
    const waitMs = Math.max(
      0,
      Math.min(Number.parseInt(parsed?.maxWaitMs ?? String(config.agentPollMs), 10), config.agentPollMs),
    );
    const job = await config.queue.waitForClaimable({
      timeoutMs: waitMs,
      leaseOwner: auth.keyId,
      agentRoute: routeForAgentKeyId(auth.keyId),
    });
    if (!job) {
      res.writeHead(204, { "cache-control": "no-store" });
      res.end();
      return;
    }
    json(res, 200, { job, resultSubmission: config.resultSubmission });
    return;
  }

  const jobId = parsed?.jobId;
  const leaseId = parsed?.leaseId;
  if (typeof jobId !== "string" || typeof leaseId !== "string") {
    json(res, 400, { error: "invalid_result_submission" });
    return;
  }
  try {
    if (parsed?.submission !== undefined) {
      const assembled = config.resultAssembler.accept({
        jobId,
        leaseId,
        submission: parsed.submission,
        assertLease: () => config.queue.assertCurrentLease({
          jobId,
          leaseId,
          leaseOwner: auth.keyId,
        }),
      });
      if (assembled.complete && !assembled.committed) {
        config.queue.complete({
          jobId,
          leaseId,
          leaseOwner: auth.keyId,
          result: assembled.payload.result,
          error: assembled.payload.error,
        });
        config.resultAssembler.commit({
          jobId,
          leaseId,
          uploadId: parsed.submission.uploadId,
        });
      }
      json(res, 202, {
        accepted: true,
        complete: assembled.complete,
        duplicate: assembled.duplicate,
        committed: assembled.committed || assembled.complete,
      });
      return;
    }
    const legacyPayload = {};
    if (Object.prototype.hasOwnProperty.call(parsed, "result")) {
      legacyPayload.result = parsed.result;
    }
    if (Object.prototype.hasOwnProperty.call(parsed, "error")) {
      legacyPayload.error = parsed.error;
    }
    const hasResult = Object.prototype.hasOwnProperty.call(legacyPayload, "result");
    const hasError = Object.prototype.hasOwnProperty.call(legacyPayload, "error");
    if (hasResult === hasError) {
      throw new Error("Legacy result submission must contain exactly one of result or error.");
    }
    const legacyBytes = Buffer.byteLength(JSON.stringify(legacyPayload), "utf8");
    if (legacyBytes > config.resultSubmission.maxResultBytes) {
      throw new Error(
        `Legacy result submission is ${legacyBytes} bytes; the relay limit is ${config.resultSubmission.maxResultBytes} bytes.`,
      );
    }
    config.queue.complete({
      jobId,
      leaseId,
      leaseOwner: auth.keyId,
      result: legacyPayload.result,
      error: legacyPayload.error,
    });
  } catch (error) {
    json(res, 409, {
      error: "result_rejected",
      message: sanitizeErrorText(error?.message ?? error),
    });
    return;
  }
  json(res, 202, { accepted: true });
}

export function startHostingerRelay({
  env = process.env,
  logger = process.stdout,
  errorLogger = logger === process.stdout ? process.stderr : logger,
  hostname = "0.0.0.0",
} = {}) {
  const port = requiredPort(env);
  const server = createHostingerRelayServer({
    env,
    logger,
    errorLogger,
    autoInitialize: false,
  });
  server.listen(port, hostname, () => {
    logger.write?.(`Hostinger relay listening on port ${port}\n`);
    void server.initialize();
    server.monitor?.start?.();
  });

  const shutdown = () => {
    server.monitor?.stop?.();
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
