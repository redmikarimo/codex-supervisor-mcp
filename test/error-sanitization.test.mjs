import assert from "node:assert/strict";
import test from "node:test";

import {
  ERROR_SANITIZATION_LIMITS,
  sanitizeErrorData,
  sanitizeErrorText,
} from "../src/error-sanitization.mjs";

test("error sanitization recursively redacts keyed and embedded credentials", () => {
  const sentinel = ["must", "not", "escape"].join("-");
  const sanitized = sanitizeErrorData({
    authorization: `Bearer ${sentinel}`,
    nested: {
      access_token: sentinel,
      json: `{"client_secret":"${sentinel}"}`,
      header: `Authorization: Bearer ${sentinel}`,
      colon: `password: ${sentinel}`,
    },
  });

  const output = JSON.stringify(sanitized);
  assert.doesNotMatch(output, new RegExp(sentinel));
  assert.match(output, /\[REDACTED\]/);
});

test("error sanitization recognizes qualified secret keys without redacting metrics", () => {
  const sentinel = ["qualified", "secret", "sentinel"].join("-");
  const sanitized = sanitizeErrorData({
    BIOTELE_RELAY_AGENT_SECRET: sentinel,
    "x-api-key": sentinel,
    upstream_auth_token: sentinel,
    databasePassword: sentinel,
    service_credentials: sentinel,
    secretValue: sentinel,
    passwordHash: sentinel,
    tokenCount: 7,
    token_count: 8,
    apiKeyCount: 9,
  });

  assert.equal(sanitized.BIOTELE_RELAY_AGENT_SECRET, "[REDACTED]");
  assert.equal(sanitized["x-api-key"], "[REDACTED]");
  assert.equal(sanitized.upstream_auth_token, "[REDACTED]");
  assert.equal(sanitized.databasePassword, "[REDACTED]");
  assert.equal(sanitized.service_credentials, "[REDACTED]");
  assert.equal(sanitized.secretValue, "[REDACTED]");
  assert.equal(sanitized.passwordHash, "[REDACTED]");
  assert.equal(sanitized.tokenCount, 7);
  assert.equal(sanitized.token_count, 8);
  assert.equal(sanitized.apiKeyCount, 9);
  assert.doesNotMatch(JSON.stringify(sanitized), new RegExp(sentinel));
});

test("error sanitization bounds strings, nesting, cycles, and aggregate data", () => {
  const cycle = { label: "root" };
  cycle.self = cycle;
  const sanitizedCycle = sanitizeErrorData(cycle);
  assert.equal(sanitizedCycle.self, "[CIRCULAR]");

  const longText = sanitizeErrorText("x".repeat(10_000));
  assert.ok(
    Buffer.byteLength(longText, "utf8") <= ERROR_SANITIZATION_LIMITS.maxStringBytes,
  );
  assert.match(longText, /\[TRUNCATED\]$/);

  const oversized = sanitizeErrorData(
    Array.from({ length: 100 }, (_, index) => ({
      index,
      value: `value-${index}-${"x".repeat(100)}`,
    })),
    { maxBytes: 256, maxEntries: 100 },
  );
  assert.deepEqual(oversized, {
    omitted: true,
    reason: "Error data exceeded the safe size limit.",
  });
  assert.ok(Buffer.byteLength(JSON.stringify(oversized), "utf8") <= 256);
});
