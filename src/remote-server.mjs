#!/usr/bin/env node

import { createHash, createPublicKey, randomUUID, verify as verifySignature } from "node:crypto";
import http from "node:http";
import { fileURLToPath } from "node:url";

import { sanitizeErrorData, sanitizeErrorText } from "./error-sanitization.mjs";
import { AppServerError } from "./errors.mjs";
import { CodexSupervisorService } from "./supervisor-service.mjs";
import { createToolRegistry } from "./tool-registry.mjs";

const VERSION = "1.2.5";
const DEFAULT_PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([DEFAULT_PROTOCOL_VERSION]);
const MAX_BODY_BYTES = Number.parseInt(process.env.CODEX_REMOTE_MAX_BODY_BYTES ?? "1048576", 10);
const HOST = process.env.CODEX_REMOTE_HOST ?? "127.0.0.1";
const PORT = Number.parseInt(process.env.CODEX_REMOTE_PORT ?? "8787", 10);
const PATHNAME = process.env.CODEX_REMOTE_PATH ?? "/mcp";
const AUTH_MODE = (process.env.CODEX_REMOTE_AUTH_MODE ?? "bearer").toLowerCase();
const BEARER_TOKEN = process.env.CODEX_REMOTE_BEARER_TOKEN ?? "";
const OAUTH_ISSUER = (process.env.CODEX_REMOTE_OAUTH_ISSUER ?? "").replace(/\/+$/, "");
const OAUTH_AUDIENCE = process.env.CODEX_REMOTE_OAUTH_AUDIENCE ?? "";
const OAUTH_READ_SCOPE = (
  process.env.CODEX_REMOTE_OAUTH_READ_SCOPE ?? "biotele.mcp.read"
).trim();
const OAUTH_WRITE_SCOPE = (
  process.env.CODEX_REMOTE_OAUTH_WRITE_SCOPE ?? "biotele.mcp.write"
).trim();
const PUBLIC_URL = (process.env.CODEX_REMOTE_PUBLIC_URL ?? "").replace(/\/+$/, "");
const RATE_LIMIT = Number.parseInt(process.env.CODEX_REMOTE_RATE_LIMIT_PER_MINUTE ?? "60", 10);
const MCP_SESSION_PATTERN = /^[\x21-\x7e]{1,128}$/;

const rateBuckets = new Map();
let jwksCache = { expiresAt: 0, keys: new Map() };
let oauthMetadataCache = null;

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

function requestKey(id) {
  return `${typeof id}:${JSON.stringify(id)}`;
}

function requestSessionNamespace(req) {
  const header = req.headers["mcp-session-id"];
  if (header === undefined) {
    return "no-session";
  }
  if (Array.isArray(header) || !MCP_SESSION_PATTERN.test(header)) {
    throw new Error(
      "Mcp-Session-Id must be one visible ASCII value of at most 128 characters.",
    );
  }
  return header;
}

function activeRequestKey(auth, sessionNamespace, id) {
  const subject = String(auth?.subject ?? auth?.claims?.sub ?? "unknown");
  return JSON.stringify([subject, sessionNamespace, requestKey(id)]);
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

function rpcError(id, code, message, data) {
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

function clientAddress(req) {
  return req.socket.remoteAddress ?? "unknown";
}

function remoteToolSignal(req, res, timeoutMs) {
  const controller = new AbortController();
  let disconnected = false;
  const disconnectReason = Object.assign(new Error("Remote MCP client disconnected."), {
    name: "AbortError",
  });
  const abortForDisconnect = () => {
    disconnected = true;
    if (!controller.signal.aborted) {
      controller.abort(disconnectReason);
    }
  };
  const onResponseClose = () => {
    if (!res.writableEnded) {
      abortForDisconnect();
    }
  };
  req.once("aborted", abortForDisconnect);
  res.once("close", onResponseClose);
  if (req.aborted || (res.destroyed && !res.writableEnded)) {
    abortForDisconnect();
  }

  const timer = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(
        Object.assign(new Error("Remote MCP tool call timed out."), {
          name: "TimeoutError",
        }),
      );
    }
  }, timeoutMs);
  timer.unref?.();

  return {
    signal: controller.signal,
    get disconnected() {
      return disconnected;
    },
    cleanup() {
      clearTimeout(timer);
      req.removeListener("aborted", abortForDisconnect);
      res.removeListener("close", onResponseClose);
    },
  };
}

async function raceWithAbort(promise, signal) {
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => {
      reject(
        signal.reason ??
          Object.assign(new Error("Operation aborted."), { name: "AbortError" }),
      );
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });

  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function checkRateLimit(req) {
  const now = Date.now();
  const minute = Math.floor(now / 60_000);
  const key = `${clientAddress(req)}:${minute}`;
  const count = (rateBuckets.get(key) ?? 0) + 1;
  rateBuckets.set(key, count);

  if (rateBuckets.size > 2_000) {
    for (const bucketKey of rateBuckets.keys()) {
      if (!bucketKey.endsWith(`:${minute}`)) {
        rateBuckets.delete(bucketKey);
      }
    }
  }

  return count <= RATE_LIMIT;
}

function bearer(req) {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] ?? "";
}

function timingSafeStringEqual(left, right) {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return leftHash.length === rightHash.length && leftHash.equals(rightHash);
}

function decodeBase64Url(value) {
  return Buffer.from(value, "base64url");
}

function decodeJwtPart(value) {
  return JSON.parse(decodeBase64Url(value).toString("utf8"));
}

async function oauthMetadata() {
  if (oauthMetadataCache) {
    return oauthMetadataCache;
  }
  const response = await fetch(`${OAUTH_ISSUER}/.well-known/openid-configuration`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`OAuth metadata request failed with HTTP ${response.status}`);
  }
  oauthMetadataCache = await response.json();
  return oauthMetadataCache;
}

async function getJwks({ forceRefresh = false } = {}) {
  if (!forceRefresh && Date.now() < jwksCache.expiresAt && jwksCache.keys.size > 0) {
    return jwksCache.keys;
  }

  const metadata = await oauthMetadata();
  const response = await fetch(metadata.jwks_uri, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`JWKS request failed with HTTP ${response.status}`);
  }

  const document = await response.json();
  const keys = new Map(
    (document.keys ?? []).filter((key) => key.kid).map((key) => [key.kid, key]),
  );
  jwksCache = {
    expiresAt: Date.now() + 10 * 60_000,
    keys,
  };
  return keys;
}

function extractScopes(payload) {
  const values = [];
  if (typeof payload?.scope === "string") {
    values.push(...payload.scope.split(/\s+/));
  }
  if (typeof payload?.scp === "string") {
    values.push(...payload.scp.split(/\s+/));
  } else if (Array.isArray(payload?.scp)) {
    values.push(...payload.scp);
  }
  return new Set(values.map((value) => String(value).trim()).filter(Boolean));
}

export async function verifyOAuthToken(token) {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed JWT");
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJwtPart(encodedHeader);
  const payload = decodeJwtPart(encodedPayload);

  if (header.alg !== "RS256" || !header.kid) {
    throw new Error("Only RS256 JWTs with a kid are accepted");
  }

  let keys = await getJwks();
  let jwk = keys.get(header.kid);
  if (!jwk) {
    keys = await getJwks({ forceRefresh: true });
    jwk = keys.get(header.kid);
  }
  if (!jwk) {
    throw new Error("JWT signing key was not found");
  }

  const valid = verifySignature(
    "RSA-SHA256",
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    createPublicKey({ key: jwk, format: "jwk" }),
    decodeBase64Url(encodedSignature),
  );
  if (!valid) {
    throw new Error("Invalid JWT signature");
  }

  const now = Math.floor(Date.now() / 1_000);
  if (payload.iss !== `${OAUTH_ISSUER}/` && payload.iss !== OAUTH_ISSUER) {
    throw new Error("Invalid JWT issuer");
  }
  if (typeof payload.exp !== "number" || payload.exp <= now) {
    throw new Error("Expired JWT");
  }

  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (OAUTH_AUDIENCE && !audiences.includes(OAUTH_AUDIENCE)) {
    throw new Error("Invalid JWT audience");
  }

  return {
    subject: payload.sub ?? null,
    claims: payload,
    scopes: extractScopes(payload),
  };
}

async function authorize(req) {
  if (AUTH_MODE === "none") {
    return { subject: "anonymous", scopes: new Set() };
  }

  const token = bearer(req);
  if (!token) {
    throw new Error("Missing bearer token");
  }

  if (AUTH_MODE === "bearer") {
    if (!BEARER_TOKEN || !timingSafeStringEqual(token, BEARER_TOKEN)) {
      throw new Error("Invalid bearer token");
    }
    return { subject: "bearer-user", scopes: new Set() };
  }

  if (AUTH_MODE === "oauth") {
    return await verifyOAuthToken(token);
  }

  throw new Error(`Unsupported CODEX_REMOTE_AUTH_MODE: ${AUTH_MODE}`);
}

export function negotiateProtocolVersion(requestedVersion) {
  return SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion)
    ? requestedVersion
    : DEFAULT_PROTOCOL_VERSION;
}

export function validateOAuthScopeConfig(readScope, writeScope) {
  if (!readScope || !writeScope) {
    throw new Error("OAuth read and write scopes must both be non-empty");
  }
  if (readScope === writeScope) {
    throw new Error("OAuth read and write scopes must be distinct");
  }
}

export function requiredOAuthScope(
  toolName,
  { readScope = OAUTH_READ_SCOPE, writeScope = OAUTH_WRITE_SCOPE } = {},
) {
  if (READ_TOOLS.has(toolName)) {
    return readScope;
  }
  if (WRITE_TOOLS.has(toolName)) {
    return writeScope;
  }
  return null;
}

function requireOAuthScope(auth, requiredScope) {
  if (auth?.scopes?.has?.(requiredScope)) {
    return;
  }
  const error = new Error(`Missing required OAuth scope: ${requiredScope}`);
  error.scope = requiredScope;
  throw error;
}

function challengeValue(value) {
  return sanitizeErrorText(value, 512).replace(/["\r\n]/g, "");
}

function oauthBearerChallenge({ publicUrl, error, errorDescription } = {}) {
  const metadataUrl = publicUrl
    ? `${publicUrl}/.well-known/oauth-protected-resource`
    : "/.well-known/oauth-protected-resource";
  const details = errorDescription
    ? `, error_description="${challengeValue(errorDescription)}"`
    : "";
  return `Bearer resource_metadata="${challengeValue(metadataUrl)}", error="${challengeValue(error ?? "invalid_token")}"${details}`;
}

function assertPositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function validateStartupConfig() {
  assertPositiveInteger(MAX_BODY_BYTES, "CODEX_REMOTE_MAX_BODY_BYTES");
  assertPositiveInteger(PORT, "CODEX_REMOTE_PORT");
  assertPositiveInteger(RATE_LIMIT, "CODEX_REMOTE_RATE_LIMIT_PER_MINUTE");

  if (!PATHNAME.startsWith("/")) {
    throw new Error("CODEX_REMOTE_PATH must start with /");
  }

  if (AUTH_MODE === "bearer") {
    if (!BEARER_TOKEN) {
      throw new Error("CODEX_REMOTE_BEARER_TOKEN is required in bearer mode");
    }
    if (Buffer.byteLength(BEARER_TOKEN, "utf8") < 32) {
      throw new Error("CODEX_REMOTE_BEARER_TOKEN must contain at least 32 bytes");
    }
    return;
  }

  if (AUTH_MODE === "oauth") {
    if (!OAUTH_ISSUER || !OAUTH_AUDIENCE) {
      throw new Error("CODEX_REMOTE_OAUTH_ISSUER and CODEX_REMOTE_OAUTH_AUDIENCE are required in OAuth mode");
    }
    validateOAuthScopeConfig(OAUTH_READ_SCOPE, OAUTH_WRITE_SCOPE);
    return;
  }

  if (AUTH_MODE !== "none") {
    throw new Error(`Unsupported CODEX_REMOTE_AUTH_MODE: ${AUTH_MODE}`);
  }
}

async function readBody(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return null;
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function completeToolResult(output, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
    structuredContent: output,
    isError,
  };
}

function errorToolResult(error) {
  return completeToolResult(
    {
      error: {
        type: sanitizeErrorText(error?.name ?? "Error", 128),
        message: sanitizeErrorText(error?.message ?? String(error)),
        ...(error instanceof AppServerError
          ? {
              code: sanitizeErrorData(error.code ?? null),
              method: sanitizeErrorText(error.method ?? "", 256) || null,
              data: sanitizeErrorData(error.data ?? null),
            }
          : {}),
      },
    },
    true,
  );
}

export function createRemoteHttpServer({
  tools,
  authorizeRequest = authorize,
  authMode = AUTH_MODE,
  pathname = PATHNAME,
  publicUrl = PUBLIC_URL,
  oauthIssuer = OAUTH_ISSUER,
  readScope = OAUTH_READ_SCOPE,
  writeScope = OAUTH_WRITE_SCOPE,
} = {}) {
  if (!tools) {
    throw new Error("A tool registry is required");
  }
  const activeRequestIds = new Set();

  return http.createServer(async (req, res) => {
    const requestId = req.headers["x-request-id"] ?? randomUUID();
    res.setHeader("x-request-id", requestId);

    try {
      if (!checkRateLimit(req)) {
        json(res, 429, { error: "rate_limit_exceeded" });
        return;
      }

      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (url.pathname === "/healthz") {
        json(res, 200, { status: "ok", version: VERSION });
        return;
      }

      if (url.pathname === "/.well-known/oauth-protected-resource" && authMode === "oauth") {
        json(res, 200, {
          resource: publicUrl ? `${publicUrl}${pathname}` : pathname,
          authorization_servers: [oauthIssuer],
          bearer_methods_supported: ["header"],
          scopes_supported: [readScope, writeScope],
        });
        return;
      }

      if (url.pathname !== pathname) {
        json(res, 404, { error: "not_found" });
        return;
      }

      let auth;
      try {
        auth = await authorizeRequest(req);
      } catch (error) {
        json(
          res,
          401,
          { error: "unauthorized", message: sanitizeErrorText(error?.message ?? String(error)) },
          {
            "www-authenticate":
              authMode === "oauth"
                ? oauthBearerChallenge({
                    publicUrl,
                    error: "invalid_token",
                    errorDescription: error?.message ?? String(error),
                  })
                : 'Bearer realm="codex-supervisor"',
          },
        );
        return;
      }

      if (req.method === "GET") {
        res.writeHead(405, { allow: "POST, DELETE" });
        res.end();
        return;
      }

      if (req.method === "DELETE") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method !== "POST") {
        res.writeHead(405, { allow: "POST, DELETE" });
        res.end();
        return;
      }

      const message = await readBody(req);
      if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
        json(res, 400, rpcError(message?.id, -32600, "Invalid JSON-RPC request"));
        return;
      }

      if (message.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }

      let sessionNamespace;
      try {
        sessionNamespace = requestSessionNamespace(req);
      } catch (error) {
        json(res, 400, rpcError(message.id, -32600, error.message));
        return;
      }

      const activeKey = activeRequestKey(auth, sessionNamespace, message.id);
      if (activeRequestIds.has(activeKey)) {
        json(
          res,
          200,
          rpcError(message.id, -32600, "Duplicate active JSON-RPC request id."),
        );
        return;
      }

      activeRequestIds.add(activeKey);
      try {
        let result;
        switch (message.method) {
        case "initialize":
          res.setHeader("mcp-session-id", randomUUID());
          result = {
            protocolVersion: negotiateProtocolVersion(message.params?.protocolVersion),
            capabilities: { tools: { listChanged: false } },
            serverInfo: {
              name: "codex-supervisor-remote",
              title: "Codex Supervisor Remote",
              version: VERSION,
            },
            instructions:
              "Start tasks only in CODEX_ALLOWED_ROOTS. Prefer read-only and networkAccess=false. Review approval requests before resolving them.",
          };
          break;

        case "ping":
          result = {};
          break;

        case "tools/list":
          if (authMode === "oauth") {
            try {
              requireOAuthScope(auth, readScope);
            } catch (error) {
              json(
                res,
                200,
                rpcError(message.id, -32001, error.message, {
                  requiredScope: error.scope,
                }),
              );
              return;
            }
          }
          result = { tools: tools.definitions };
          break;

        case "tools/call": {
          const name = message.params?.name;
          const args = message.params?.arguments ?? {};
          if (!tools.has(name)) {
            json(res, 200, rpcError(message.id, -32602, `Unknown tool: ${name}`));
            return;
          }

          if (authMode === "oauth") {
            const requiredScope = requiredOAuthScope(name, { readScope, writeScope });
            if (!requiredScope) {
              json(
                res,
                200,
                rpcError(
                  message.id,
                  -32602,
                  `Unknown authorization category for tool: ${String(name)}`,
                ),
              );
              return;
            }
            try {
              requireOAuthScope(auth, requiredScope);
            } catch (error) {
              json(
                res,
                200,
                rpcError(message.id, -32001, error.message, {
                  requiredScope: error.scope,
                }),
              );
              return;
            }
          }

          const execution = remoteToolSignal(
            req,
            res,
            Number.parseInt(process.env.CODEX_REMOTE_TOOL_TIMEOUT_MS ?? "900000", 10),
          );
          try {
            const output = await raceWithAbort(
              tools.call(name, args, {
                signal: execution.signal,
              }),
              execution.signal,
            );
            if (execution.disconnected) {
              return;
            }
            result = completeToolResult(output);
          } catch (error) {
            if (execution.disconnected) {
              return;
            }
            result = errorToolResult(error);
          } finally {
            execution.cleanup();
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
      } finally {
        activeRequestIds.delete(activeKey);
      }
    } catch (error) {
      json(res, 500, {
        error: "internal_error",
        requestId,
        message: sanitizeErrorText(error?.message ?? String(error)),
      });
    }
  });
}

async function main() {
  validateStartupConfig();
  if (HOST !== "127.0.0.1" && HOST !== "::1" && AUTH_MODE === "none") {
    throw new Error("Unauthenticated mode may bind only to loopback");
  }

  const service = await CodexSupervisorService.create();
  const tools = createToolRegistry(service);
  const server = createRemoteHttpServer({ tools });

  const shutdown = async () => {
    server.close();
    await service.close?.();
  };

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  server.listen(PORT, HOST, () => {
    process.stderr.write(
      `Codex Supervisor Remote v${VERSION} listening on http://${HOST}:${PORT}${PATHNAME}\n`,
    );
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${sanitizeErrorText(error?.stack ?? error)}\n`);
    process.exitCode = 1;
  });
}
