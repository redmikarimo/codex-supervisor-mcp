#!/usr/bin/env node

import { createHash, createPublicKey, randomUUID, verify as verifySignature } from "node:crypto";
import http from "node:http";

import { AppServerError } from "./errors.mjs";
import { CodexSupervisorService } from "./supervisor-service.mjs";
import { createToolRegistry } from "./tool-registry.mjs";

const VERSION = "1.1.0";
const DEFAULT_PROTOCOL_VERSION = "2025-11-25";
const MAX_BODY_BYTES = Number.parseInt(process.env.CODEX_REMOTE_MAX_BODY_BYTES ?? "1048576", 10);
const HOST = process.env.CODEX_REMOTE_HOST ?? "127.0.0.1";
const PORT = Number.parseInt(process.env.CODEX_REMOTE_PORT ?? "8787", 10);
const PATHNAME = process.env.CODEX_REMOTE_PATH ?? "/mcp";
const AUTH_MODE = (process.env.CODEX_REMOTE_AUTH_MODE ?? "bearer").toLowerCase();
const BEARER_TOKEN = process.env.CODEX_REMOTE_BEARER_TOKEN ?? "";
const OAUTH_ISSUER = (process.env.CODEX_REMOTE_OAUTH_ISSUER ?? "").replace(/\/+$/, "");
const OAUTH_AUDIENCE = process.env.CODEX_REMOTE_OAUTH_AUDIENCE ?? "";
const PUBLIC_URL = (process.env.CODEX_REMOTE_PUBLIC_URL ?? "").replace(/\/+$/, "");
const RATE_LIMIT = Number.parseInt(process.env.CODEX_REMOTE_RATE_LIMIT_PER_MINUTE ?? "60", 10);

const rateBuckets = new Map();
let jwksCache = { expiresAt: 0, keys: new Map() };

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
      message,
      ...(data === undefined ? {} : { data }),
    },
  };
}

function clientAddress(req) {
  return req.socket.remoteAddress ?? "unknown";
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
  const response = await fetch(`${OAUTH_ISSUER}/.well-known/openid-configuration`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`OAuth metadata request failed with HTTP ${response.status}`);
  }
  return await response.json();
}

async function getJwks() {
  if (Date.now() < jwksCache.expiresAt && jwksCache.keys.size > 0) {
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

async function verifyOAuthToken(token) {
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

  const keys = await getJwks();
  const jwk = keys.get(header.kid);
  if (!jwk) {
    jwksCache.expiresAt = 0;
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

  return payload;
}

async function authorize(req) {
  if (AUTH_MODE === "none") {
    return { subject: "anonymous" };
  }

  const token = bearer(req);
  if (!token) {
    throw new Error("Missing bearer token");
  }

  if (AUTH_MODE === "bearer") {
    if (!BEARER_TOKEN || !timingSafeStringEqual(token, BEARER_TOKEN)) {
      throw new Error("Invalid bearer token");
    }
    return { subject: "bearer-user" };
  }

  if (AUTH_MODE === "oauth") {
    return await verifyOAuthToken(token);
  }

  throw new Error(`Unsupported CODEX_REMOTE_AUTH_MODE: ${AUTH_MODE}`);
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
        type: error?.name ?? "Error",
        message: error?.message ?? String(error),
        ...(error instanceof AppServerError
          ? {
              code: error.code ?? null,
              method: error.method ?? null,
              data: error.data ?? null,
            }
          : {}),
      },
    },
    true,
  );
}

async function main() {
  validateStartupConfig();
  if (HOST !== "127.0.0.1" && HOST !== "::1" && AUTH_MODE === "none") {
    throw new Error("Unauthenticated mode may bind only to loopback");
  }

  const service = await CodexSupervisorService.create();
  const tools = createToolRegistry(service);

  const server = http.createServer(async (req, res) => {
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

      if (url.pathname === "/.well-known/oauth-protected-resource" && AUTH_MODE === "oauth") {
        json(res, 200, {
          resource: PUBLIC_URL ? `${PUBLIC_URL}${PATHNAME}` : PATHNAME,
          authorization_servers: [OAUTH_ISSUER],
          bearer_methods_supported: ["header"],
        });
        return;
      }

      if (url.pathname !== PATHNAME) {
        json(res, 404, { error: "not_found" });
        return;
      }

      try {
        await authorize(req);
      } catch (error) {
        const metadataUrl = PUBLIC_URL
          ? `${PUBLIC_URL}/.well-known/oauth-protected-resource`
          : "/.well-known/oauth-protected-resource";
        json(
          res,
          401,
          { error: "unauthorized", message: error.message },
          {
            "www-authenticate":
              AUTH_MODE === "oauth"
                ? `Bearer resource_metadata="${metadataUrl}"`
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

      let result;
      switch (message.method) {
        case "initialize":
          result = {
            protocolVersion:
              message.params?.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
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
          result = { tools: tools.definitions };
          break;

        case "tools/call": {
          const name = message.params?.name;
          const args = message.params?.arguments ?? {};
          if (!tools.has(name)) {
            json(res, 200, rpcError(message.id, -32602, `Unknown tool: ${name}`));
            return;
          }

          try {
            const output = await tools.call(name, args, {
              signal: AbortSignal.timeout(
                Number.parseInt(process.env.CODEX_REMOTE_TOOL_TIMEOUT_MS ?? "900000", 10),
              ),
            });
            result = completeToolResult(output);
          } catch (error) {
            result = errorToolResult(error);
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
    } catch (error) {
      json(res, 500, {
        error: "internal_error",
        requestId,
        message: error?.message ?? String(error),
      });
    }
  });

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

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
