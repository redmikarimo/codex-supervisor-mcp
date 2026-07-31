import { ValidationError } from "./errors.mjs";

export const SANDBOX_MODES = Object.freeze(["read-only", "workspace-write"]);
export const DEFAULT_SANDBOX_MODE = "workspace-write";

const LEGACY_SANDBOX_MODE_ALIASES = new Map([
  ["readOnly", "read-only"],
  ["workspaceWrite", "workspace-write"],
]);

export function normalizeSandboxMode(value = DEFAULT_SANDBOX_MODE) {
  const candidate = value ?? DEFAULT_SANDBOX_MODE;

  if (typeof candidate !== "string") {
    throw new ValidationError("sandboxMode must be a string.");
  }

  const normalized = LEGACY_SANDBOX_MODE_ALIASES.get(candidate) ?? candidate;

  if (!SANDBOX_MODES.includes(normalized)) {
    throw new ValidationError(
      `sandboxMode must be one of: ${SANDBOX_MODES.join(", ")}.`,
    );
  }

  return normalized;
}

export function toSandboxPolicyType(sandboxMode) {
  const normalized = normalizeSandboxMode(sandboxMode);
  return normalized === "read-only" ? "readOnly" : "workspaceWrite";
}
