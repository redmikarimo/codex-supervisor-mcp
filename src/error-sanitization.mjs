const DEFAULT_MAX_DATA_BYTES = 16 * 1024;
const DEFAULT_MAX_STRING_BYTES = 2 * 1024;
const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_ENTRIES = 50;

const REDACTED = "[REDACTED]";
const TRUNCATED = "[TRUNCATED]";

const SENSITIVE_KEYS = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "apikey",
  "secret",
  "clientsecret",
  "password",
  "passwd",
  "credential",
  "credentials",
]);

const SENSITIVE_KEY_WORDS = new Set([
  "authorization",
  "cookie",
  "token",
  "secret",
  "password",
  "passwd",
  "credential",
  "credentials",
]);

// These suffixes describe metadata about a credential rather than the credential
// value itself. Keeping this list narrow avoids treating names such as
// `tokenCount` as secrets while still redacting `secretValue` and
// `passwordHash`.
const NON_SECRET_METADATA_WORDS = new Set([
  "age",
  "bytes",
  "configured",
  "count",
  "counts",
  "enabled",
  "expiration",
  "expires",
  "expiry",
  "length",
  "limit",
  "max",
  "min",
  "name",
  "present",
  "size",
  "ttl",
  "type",
]);

const SENSITIVE_LABEL =
  "(?:authorization|proxy[-_ ]?authorization|cookie|set[-_ ]?cookie|token|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|api[-_ ]?key|secret|client[-_ ]?secret|password|passwd|credentials?)";

const LABELED_SECRET_PATTERN = new RegExp(
  `(["']?${SENSITIVE_LABEL}["']?\\s*[:=]\\s*)(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|(?:Bearer|Basic)\\s+[^,;\\r\\n}\\]]+|[^,;\\r\\n}\\]]+)`,
  "gi",
);
const AUTH_SCHEME_PATTERN = /\b(Bearer|Basic)\s+[^\s,;"'}\]]+/gi;

function normalizedKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function keyWords(key) {
  return (
    String(key)
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .match(/[a-z0-9]+/g) ?? []
  );
}

function isSensitiveKey(key) {
  if (SENSITIVE_KEYS.has(normalizedKey(key))) {
    return true;
  }

  const words = keyWords(key);
  for (let index = 0; index < words.length; index += 1) {
    const isApiKey = words[index] === "api" && words[index + 1] === "key";
    if (!isApiKey && !SENSITIVE_KEY_WORDS.has(words[index])) {
      continue;
    }
    const markerEnd = index + (isApiKey ? 1 : 0);
    const suffix = words.slice(markerEnd + 1);
    if (
      suffix.length === 0 ||
      !suffix.every((word) => NON_SECRET_METADATA_WORDS.has(word))
    ) {
      return true;
    }
    index = markerEnd;
  }
  return false;
}

function truncateUtf8(value, maxBytes) {
  const text = String(value);
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }

  const suffix = `\u2026${TRUNCATED}`;
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
  let output = "";
  let used = 0;
  for (const character of text) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (used + bytes > budget) {
      break;
    }
    output += character;
    used += bytes;
  }
  return `${output}${suffix}`;
}

export function sanitizeErrorText(value, maxBytes = DEFAULT_MAX_STRING_BYTES) {
  const boundedInput = truncateUtf8(String(value ?? ""), Math.max(maxBytes * 4, maxBytes));
  const redacted = boundedInput
    .replace(LABELED_SECRET_PATTERN, `$1${REDACTED}`)
    .replace(AUTH_SCHEME_PATTERN, `$1 ${REDACTED}`);
  return truncateUtf8(redacted, maxBytes);
}

function sanitizeValue(value, state, depth) {
  if (value === null || value === undefined) {
    return value ?? null;
  }

  if (typeof value === "string") {
    return sanitizeErrorText(value, state.maxStringBytes);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return `${value}n`;
  }
  if (typeof value === "symbol" || typeof value === "function") {
    return `[${typeof value}]`;
  }
  if (depth >= state.maxDepth) {
    return TRUNCATED;
  }
  if (state.seen.has(value)) {
    return "[CIRCULAR]";
  }

  state.seen.add(value);
  try {
    if (value instanceof Error) {
      return {
        name: sanitizeErrorText(value.name || "Error", 128),
        message: sanitizeErrorText(value.message || String(value), state.maxStringBytes),
        ...(value.cause === undefined
          ? {}
          : { cause: sanitizeValue(value.cause, state, depth + 1) }),
      };
    }

    if (Array.isArray(value)) {
      const output = value
        .slice(0, state.maxEntries)
        .map((entry) => sanitizeValue(entry, state, depth + 1));
      if (value.length > state.maxEntries) {
        output.push(TRUNCATED);
      }
      return output;
    }

    const output = Object.create(null);
    let count = 0;
    for (const rawKey of Object.keys(value)) {
      if (count >= state.maxEntries) {
        output[TRUNCATED] = true;
        break;
      }
      count += 1;
      const key = sanitizeErrorText(rawKey, 128);
      if (isSensitiveKey(rawKey)) {
        output[key] = REDACTED;
        continue;
      }
      try {
        const rawValue = value[rawKey];
        output[key] = sanitizeValue(rawValue, state, depth + 1);
      } catch {
        output[key] = "[UNAVAILABLE]";
      }
    }
    return output;
  } finally {
    state.seen.delete(value);
  }
}

export function sanitizeErrorData(
  value,
  {
    maxBytes = DEFAULT_MAX_DATA_BYTES,
    maxStringBytes = DEFAULT_MAX_STRING_BYTES,
    maxDepth = DEFAULT_MAX_DEPTH,
    maxEntries = DEFAULT_MAX_ENTRIES,
  } = {},
) {
  let sanitized;
  try {
    sanitized = sanitizeValue(
      value,
      {
        maxStringBytes,
        maxDepth,
        maxEntries,
        seen: new WeakSet(),
      },
      0,
    );
  } catch {
    return { omitted: true, reason: "Error data could not be inspected safely." };
  }

  let serialized;
  try {
    serialized = JSON.stringify(sanitized);
  } catch {
    return { omitted: true, reason: "Error data could not be serialized safely." };
  }
  if (Buffer.byteLength(serialized ?? "null", "utf8") > maxBytes) {
    return { omitted: true, reason: "Error data exceeded the safe size limit." };
  }
  return sanitized;
}

export const ERROR_SANITIZATION_LIMITS = Object.freeze({
  maxDataBytes: DEFAULT_MAX_DATA_BYTES,
  maxStringBytes: DEFAULT_MAX_STRING_BYTES,
  maxDepth: DEFAULT_MAX_DEPTH,
  maxEntries: DEFAULT_MAX_ENTRIES,
});
