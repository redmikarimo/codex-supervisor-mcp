import { createPublicKey, verify as verifySignature } from "node:crypto";

const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000;
const DEFAULT_JWKS_CACHE_MS = 10 * 60_000;
const DEFAULT_CLOCK_SKEW_SECONDS = 60;

function decodeBase64Url(value) {
  return Buffer.from(value, "base64url");
}

function decodeJwtPart(value, label) {
  try {
    return JSON.parse(decodeBase64Url(value).toString("utf8"));
  } catch {
    throw new Error(`Malformed JWT ${label}.`);
  }
}

function bearerToken(req) {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] ?? "";
}

function issuerMatches(actual, expected) {
  return actual === expected || actual === `${expected}/`;
}

function audienceMatches(actual, expected) {
  const audiences = Array.isArray(actual) ? actual : [actual];
  return audiences.includes(expected);
}

async function fetchJson(url, { timeoutMs, fetchImpl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export function extractScopes(claims) {
  const raw = claims?.scope ?? claims?.scp;
  if (typeof raw === "string") {
    return new Set(raw.split(/\s+/).filter(Boolean));
  }
  if (Array.isArray(raw)) {
    return new Set(raw.filter((entry) => typeof entry === "string"));
  }
  return new Set();
}

export class OAuthResourceServer {
  constructor({
    issuer,
    audience,
    jwksCacheMs = DEFAULT_JWKS_CACHE_MS,
    clockSkewSeconds = DEFAULT_CLOCK_SKEW_SECONDS,
    discoveryTimeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS,
    fetchImpl = fetch,
  } = {}) {
    if (!issuer) {
      throw new Error("BIOTELE_RELAY_OAUTH_ISSUER is required when OAuth is enabled.");
    }
    if (!audience) {
      throw new Error("BIOTELE_RELAY_OAUTH_AUDIENCE is required when OAuth is enabled.");
    }
    this.issuer = issuer.replace(/\/+$/, "");
    this.audience = audience;
    this.jwksCacheMs = jwksCacheMs;
    this.clockSkewSeconds = clockSkewSeconds;
    this.discoveryTimeoutMs = discoveryTimeoutMs;
    this.fetchImpl = fetchImpl;
    this.metadata = null;
    this.jwks = { expiresAt: 0, keys: new Map() };
  }

  async verifyRequest(req) {
    const token = bearerToken(req);
    if (!token) {
      throw new Error("Missing bearer token.");
    }
    return await this.verifyToken(token);
  }

  async verifyToken(token) {
    const parts = token.split(".");
    if (parts.length !== 3) {
      throw new Error("Malformed JWT.");
    }

    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const header = decodeJwtPart(encodedHeader, "header");
    const claims = decodeJwtPart(encodedPayload, "payload");

    if (header.alg !== "RS256") {
      throw new Error("Unsupported JWT signing algorithm.");
    }
    if (!header.kid || typeof header.kid !== "string") {
      throw new Error("JWT is missing a signing key id.");
    }

    let key = await this.#getKey(header.kid);
    if (!key) {
      await this.#refreshJwks();
      key = await this.#getKey(header.kid);
    }
    if (!key) {
      throw new Error("JWT signing key was not found.");
    }

    const valid = verifySignature(
      "RSA-SHA256",
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      createPublicKey({ key, format: "jwk" }),
      decodeBase64Url(encodedSignature),
    );
    if (!valid) {
      throw new Error("Invalid JWT signature.");
    }

    const now = Math.floor(Date.now() / 1_000);
    const skew = this.clockSkewSeconds;
    if (!issuerMatches(claims.iss, this.issuer)) {
      throw new Error("Invalid JWT issuer.");
    }
    if (!audienceMatches(claims.aud, this.audience)) {
      throw new Error("Invalid JWT audience.");
    }
    if (typeof claims.exp !== "number" || claims.exp + skew <= now) {
      throw new Error("Expired JWT.");
    }
    if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf - skew > now)) {
      throw new Error("JWT is not valid yet.");
    }

    return {
      subject: claims.sub ?? null,
      claims,
      scopes: extractScopes(claims),
    };
  }

  async protectedResourceMetadata({ publicUrl, resourcePath = "/mcp" }) {
    const metadata = await this.#getMetadata();
    const resourceBase = (publicUrl || "").replace(/\/+$/, "");
    return {
      resource: `${resourceBase}${resourcePath}`,
      authorization_servers: [metadata.issuer ?? this.issuer],
      bearer_methods_supported: ["header"],
      resource_documentation: resourceBase || undefined,
    };
  }

  async #getMetadata() {
    if (this.metadata) {
      return this.metadata;
    }
    const metadata = await fetchJson(`${this.issuer}/.well-known/openid-configuration`, {
      timeoutMs: this.discoveryTimeoutMs,
      fetchImpl: this.fetchImpl,
    });
    if (!metadata.jwks_uri) {
      throw new Error("OIDC discovery metadata did not include jwks_uri.");
    }
    this.metadata = metadata;
    return metadata;
  }

  async #getKey(kid) {
    const keys = await this.#getJwks();
    return keys.get(kid) ?? null;
  }

  async #getJwks() {
    if (Date.now() < this.jwks.expiresAt && this.jwks.keys.size > 0) {
      return this.jwks.keys;
    }
    await this.#refreshJwks();
    return this.jwks.keys;
  }

  async #refreshJwks() {
    const metadata = await this.#getMetadata();
    const document = await fetchJson(metadata.jwks_uri, {
      timeoutMs: this.discoveryTimeoutMs,
      fetchImpl: this.fetchImpl,
    });
    const keys = new Map(
      (document.keys ?? [])
        .filter((key) => key.kid && key.kty === "RSA")
        .map((key) => [key.kid, key]),
    );
    this.jwks = {
      expiresAt: Date.now() + this.jwksCacheMs,
      keys,
    };
  }
}

export function bearerChallenge({
  publicUrl,
  resourcePath = "/mcp",
  error = "invalid_token",
  errorDescription = undefined,
} = {}) {
  const metadataUrl = `${(publicUrl || "").replace(/\/+$/, "")}/.well-known/oauth-protected-resource`;
  const escapedError = String(error).replaceAll('"', "");
  const description = errorDescription
    ? `, error_description="${String(errorDescription).replaceAll('"', "")}"`
    : "";
  return `Bearer resource_metadata="${metadataUrl}", error="${escapedError}"${description}`;
}
