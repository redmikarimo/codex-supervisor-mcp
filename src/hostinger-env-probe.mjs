const KEY_ID_PATTERN = /^[A-Za-z0-9_.-]{3,128}$/;
const DASH_PATTERN = /[\u2010-\u2015\u2212]/g;
const DASH_TEST_PATTERN = /[\u2010-\u2015\u2212]/;
const KEY_ID_WHITESPACE_PATTERN = /\s+/g;
const INVISIBLE_PATTERN = /[\u200B-\u200D\u2060\uFEFF]/g;
const INVISIBLE_TEST_PATTERN = /[\u200B-\u200D\u2060\uFEFF]/;
const HTML_QUOTE_PATTERN = /&(quot|#34|#x22);/gi;
const HTML_APOSTROPHE_PATTERN = /&(apos|#39|#x27);/gi;
const HTML_ENTITY_TEST_PATTERN = /&(?:amp;)?(?:quot|apos|#34|#39|#x22|#x27|lt|gt);/i;
const SINGLE_QUOTE_PATTERN = /[\u2018\u2019\u201A\u201B\u2032]/g;
const DOUBLE_QUOTE_PATTERN = /[\u201C\u201D\u201E\u201F\u2033]/g;
const PLACEHOLDER_SECRET_PATTERN = /replace-with|placeholder|example/i;

function normalizeEnvText(value) {
  return String(value)
    .trim()
    .replace(HTML_QUOTE_PATTERN, '"')
    .replace(HTML_APOSTROPHE_PATTERN, "'")
    .replace(DOUBLE_QUOTE_PATTERN, '"')
    .replace(SINGLE_QUOTE_PATTERN, "'")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'");
}

function stripCredentialWrapper(value) {
  return normalizeEnvText(value).replace(/^[\s{["']+|[\s}["']+$/g, "");
}

function present(value) {
  return value !== undefined && String(value).trim() !== "";
}

function codePoint(value) {
  return `U+${value.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
}

function describeKeyId(value) {
  if (typeof value !== "string") {
    return { type: typeof value, validAfterNormalization: false };
  }

  const normalized = stripCredentialWrapper(value)
    .replace(DASH_PATTERN, "-")
    .replace(KEY_ID_WHITESPACE_PATTERN, "");
  const invalidCodePoints = [
    ...new Set(
      Array.from(normalized)
        .filter((character) => !/[A-Za-z0-9_.-]/.test(character))
        .slice(0, 16)
        .map(codePoint),
    ),
  ];

  return {
    type: "string",
    length: Array.from(value).length,
    normalizedLength: Array.from(normalized).length,
    changedByNormalization: normalized !== value,
    hasWhitespace: /\s/.test(value),
    hasUnicodeDash: DASH_TEST_PATTERN.test(value),
    hasInvisibleFormatCharacter: INVISIBLE_TEST_PATTERN.test(value),
    validAfterNormalization: KEY_ID_PATTERN.test(normalized),
    invalidCodePoints,
  };
}

function describeSecret(value) {
  if (typeof value !== "string") {
    return { type: typeof value, meetsMinimumLength: false };
  }
  const normalized = stripCredentialWrapper(value);
  return {
    type: "string",
    length: Buffer.byteLength(value, "utf8"),
    normalizedLength: Buffer.byteLength(normalized, "utf8"),
    changedByNormalization: normalized !== value,
    meetsMinimumLength: Buffer.byteLength(normalized, "utf8") >= 32,
    looksLikePlaceholder: PLACEHOLDER_SECRET_PATTERN.test(normalized),
  };
}

function describeParsed(value, depth = 0) {
  if (typeof value === "string") {
    const result = {
      type: "string",
      length: Buffer.byteLength(value, "utf8"),
    };
    if (depth === 0) {
      result.nestedJson = tryJson(normalizeEnvText(value), depth + 1);
    }
    return result;
  }
  if (!value || typeof value !== "object") {
    return { type: value === null ? "null" : typeof value };
  }
  if (Array.isArray(value)) {
    return { type: "array", length: value.length };
  }
  return {
    type: "object",
    keyCount: Object.keys(value).length,
    entries: Object.entries(value).slice(0, 10).map(([keyId, secret]) => ({
      keyId: describeKeyId(keyId),
      secret: describeSecret(secret),
    })),
  };
}

function tryJson(value, depth = 0) {
  try {
    return {
      ok: true,
      parsed: describeParsed(JSON.parse(value), depth),
    };
  } catch (error) {
    return {
      ok: false,
      errorType: error?.name ?? "Error",
    };
  }
}

function describeFallbackPair(raw) {
  const separator = raw.indexOf(":");
  if (separator <= 0) {
    return { separatorFound: false };
  }
  return {
    separatorFound: true,
    keyId: describeKeyId(raw.slice(0, separator)),
    secret: describeSecret(raw.slice(separator + 1)),
  };
}

export function buildHostingerCredentialProbe(env = process.env) {
  const splitKeyIdPresent = present(env.BIOTELE_RELAY_AGENT_KEY_ID);
  const splitSecretPresent = present(env.BIOTELE_RELAY_AGENT_SECRET);
  const raw = String(env.BIOTELE_RELAY_AGENT_KEYS ?? "");
  const trimmed = raw.trim();
  const normalized = normalizeEnvText(raw);

  return {
    selectedSource: splitSecretPresent ? "split" : "legacy",
    split: {
      keyIdPresent: splitKeyIdPresent,
      secretPresent: splitSecretPresent,
      keyId: splitKeyIdPresent ? describeKeyId(String(env.BIOTELE_RELAY_AGENT_KEY_ID)) : null,
      secret: splitSecretPresent ? describeSecret(String(env.BIOTELE_RELAY_AGENT_SECRET)) : null,
    },
    legacy: {
      present: present(raw),
      length: Buffer.byteLength(raw, "utf8"),
      hasHtmlEntities: HTML_ENTITY_TEST_PATTERN.test(raw),
      hasBackslashes: raw.includes("\\"),
      hasNewlines: /\r|\n/.test(raw),
      hasInvisibleFormatCharacter: INVISIBLE_TEST_PATTERN.test(raw),
      looksWrappedInQuotes:
        trimmed.length >= 2 &&
        ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
          (trimmed.startsWith("'") && trimmed.endsWith("'"))),
      directJson: tryJson(raw),
      normalizedJson: tryJson(normalized),
      fallbackPair: describeFallbackPair(raw),
    },
  };
}
