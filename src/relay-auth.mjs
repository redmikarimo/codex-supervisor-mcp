import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const DEFAULT_MAX_SKEW_MS = 5 * 60_000;
const DEFAULT_MAX_EXPIRY_MS = 10 * 60_000;
const HEADER_PREFIX = "x-biotele-relay";

function header(req, name) {
  return req.headers[`${HEADER_PREFIX}-${name}`] ?? "";
}

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function sha256(value) {
  return base64url(createHash("sha256").update(value ?? "").digest());
}

function timingSafeStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function parseCredentialMap(raw, envName) {
  if (!raw) {
    throw new Error(`${envName} is required.`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }

  const entries =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.entries(parsed)
      : String(raw)
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)
          .map((entry) => {
            const separator = entry.indexOf(":");
            if (separator <= 0) {
              throw new Error(`${envName} entries must be keyId:secret pairs.`);
            }
            return [entry.slice(0, separator), entry.slice(separator + 1)];
          });

  const credentials = new Map();
  for (const [keyId, secret] of entries) {
    if (typeof keyId !== "string" || !/^[A-Za-z0-9_.-]{3,128}$/.test(keyId)) {
      throw new Error(`${envName} contains an invalid key id.`);
    }
    if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) {
      throw new Error(`${envName} secret for ${keyId} must contain at least 32 bytes.`);
    }
    credentials.set(keyId, secret);
  }

  if (credentials.size === 0) {
    throw new Error(`${envName} must contain at least one credential.`);
  }
  return credentials;
}

export class NonceStore {
  constructor({ ttlMs = DEFAULT_MAX_EXPIRY_MS, maxEntries = 10_000 } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  accept(keyId, nonce, now = Date.now()) {
    this.#reap(now);
    const entryKey = `${keyId}:${nonce}`;
    if (this.entries.has(entryKey)) {
      return false;
    }
    this.entries.set(entryKey, now + this.ttlMs);
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
    return true;
  }

  #reap(now) {
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }
}

export function canonicalPath(url) {
  const search = new URLSearchParams(url.searchParams);
  search.sort();
  const query = search.toString();
  return `${url.pathname}${query ? `?${query}` : ""}`;
}

export function signRequest({
  method,
  path,
  body = "",
  keyId,
  secret,
  timestamp = Date.now(),
  expiresAt = timestamp + DEFAULT_MAX_SKEW_MS,
  nonce = base64url(randomBytes(16)),
}) {
  const bodyHash = sha256(body);
  const canonical = [
    method.toUpperCase(),
    path,
    String(timestamp),
    nonce,
    String(expiresAt),
    bodyHash,
  ].join("\n");
  const signature = base64url(createHmac("sha256", secret).update(canonical).digest());
  return {
    headers: {
      [`${HEADER_PREFIX}-key-id`]: keyId,
      [`${HEADER_PREFIX}-timestamp`]: String(timestamp),
      [`${HEADER_PREFIX}-nonce`]: nonce,
      [`${HEADER_PREFIX}-expires-at`]: String(expiresAt),
      [`${HEADER_PREFIX}-signature`]: signature,
    },
    signature,
    nonce,
    timestamp,
    expiresAt,
  };
}

export function verifySignedRequest({
  req,
  url,
  body = "",
  credentials,
  nonceStore,
  now = Date.now(),
  maxClockSkewMs = DEFAULT_MAX_SKEW_MS,
  maxExpiryMs = DEFAULT_MAX_EXPIRY_MS,
}) {
  const keyId = String(header(req, "key-id"));
  const timestamp = Number.parseInt(String(header(req, "timestamp")), 10);
  const nonce = String(header(req, "nonce"));
  const expiresAt = Number.parseInt(String(header(req, "expires-at")), 10);
  const signature = String(header(req, "signature"));

  if (!keyId || !nonce || !signature || !Number.isSafeInteger(timestamp) || !Number.isSafeInteger(expiresAt)) {
    throw new Error("Missing or malformed signed request headers.");
  }
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) {
    throw new Error("Invalid nonce format.");
  }
  if (Math.abs(now - timestamp) > maxClockSkewMs) {
    throw new Error("Signed request timestamp is outside the allowed clock skew.");
  }
  if (expiresAt <= now || expiresAt - timestamp > maxExpiryMs) {
    throw new Error("Signed request is expired or has an excessive expiry window.");
  }

  const secret = credentials.get(keyId);
  if (!secret) {
    throw new Error("Unknown signing key id.");
  }

  const expected = signRequest({
    method: req.method ?? "GET",
    path: canonicalPath(url),
    body,
    keyId,
    secret,
    timestamp,
    expiresAt,
    nonce,
  }).signature;
  if (!timingSafeStringEqual(signature, expected)) {
    throw new Error("Invalid request signature.");
  }

  if (!nonceStore.accept(keyId, nonce, now)) {
    throw new Error("Replay detected.");
  }

  return { keyId };
}

export async function signedFetch(url, {
  method = "POST",
  bodyObject = undefined,
  keyId,
  secret,
  timeoutMs = 30_000,
} = {}) {
  const body = bodyObject === undefined ? "" : JSON.stringify(bodyObject);
  const target = new URL(url);
  const signature = signRequest({
    method,
    path: canonicalPath(target),
    body,
    keyId,
    secret,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    return await fetch(target, {
      method,
      body: method.toUpperCase() === "GET" ? undefined : body,
      headers: {
        ...signature.headers,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}
