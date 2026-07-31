import { ValidationError } from "./errors.mjs";

export const APPROVAL_POLICIES = Object.freeze(["on-request", "untrusted"]);
export const DEFAULT_APPROVAL_POLICY = "on-request";

const LEGACY_APPROVAL_POLICY_ALIASES = new Map([
  ["onRequest", "on-request"],
  ["unlessTrusted", "untrusted"],
]);

export function normalizeApprovalPolicy(value = DEFAULT_APPROVAL_POLICY) {
  const candidate = value ?? DEFAULT_APPROVAL_POLICY;

  if (typeof candidate !== "string") {
    throw new ValidationError("approvalPolicy must be a string.");
  }

  const normalized = LEGACY_APPROVAL_POLICY_ALIASES.get(candidate) ?? candidate;

  if (!APPROVAL_POLICIES.includes(normalized)) {
    throw new ValidationError(
      `approvalPolicy must be one of: ${APPROVAL_POLICIES.join(", ")}.`,
    );
  }

  return normalized;
}
