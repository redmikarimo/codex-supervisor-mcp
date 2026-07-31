import assert from "node:assert/strict";
import test from "node:test";

import {
  APPROVAL_POLICIES,
  DEFAULT_APPROVAL_POLICY,
  normalizeApprovalPolicy,
} from "../src/approval-policy.mjs";

test("approval policies use current app-server wire values", () => {
  assert.deepEqual(APPROVAL_POLICIES, ["on-request", "untrusted"]);
  assert.equal(DEFAULT_APPROVAL_POLICY, "on-request");
  assert.equal(normalizeApprovalPolicy(), "on-request");
  assert.equal(normalizeApprovalPolicy("on-request"), "on-request");
  assert.equal(normalizeApprovalPolicy("untrusted"), "untrusted");
});

test("legacy approval policy aliases normalize to current wire values", () => {
  assert.equal(normalizeApprovalPolicy("onRequest"), "on-request");
  assert.equal(normalizeApprovalPolicy("unlessTrusted"), "untrusted");
});

test("unsupported approval policies are rejected before app-server calls", () => {
  assert.throws(
    () => normalizeApprovalPolicy("sometimes"),
    /approvalPolicy must be one of: on-request, untrusted/,
  );
  assert.throws(
    () => normalizeApprovalPolicy({}),
    /approvalPolicy must be a string/,
  );
});
