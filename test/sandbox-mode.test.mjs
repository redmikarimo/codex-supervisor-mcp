import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SANDBOX_MODE,
  normalizeSandboxMode,
  toSandboxPolicyType,
} from "../src/sandbox-mode.mjs";

test("sandbox modes normalize to app-server thread enum values", () => {
  assert.equal(DEFAULT_SANDBOX_MODE, "workspace-write");
  assert.equal(normalizeSandboxMode("read-only"), "read-only");
  assert.equal(normalizeSandboxMode("workspace-write"), "workspace-write");
  assert.equal(normalizeSandboxMode("readOnly"), "read-only");
  assert.equal(normalizeSandboxMode("workspaceWrite"), "workspace-write");
});

test("sandbox policy types retain app-server turn union casing", () => {
  assert.equal(toSandboxPolicyType("read-only"), "readOnly");
  assert.equal(toSandboxPolicyType("workspace-write"), "workspaceWrite");
});
