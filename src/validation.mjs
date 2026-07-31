import { ValidationError } from "./errors.mjs";

export function requireObject(value, name = "value") {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${name} must be an object.`);
  }
  return value;
}

export function assertAllowedKeys(value, allowedKeys, name = "arguments") {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new ValidationError(
      `${name} contains unsupported field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`,
    );
  }
}

export function requireString(value, name, { minLength = 1, maxLength = 200_000 } = {}) {
  if (typeof value !== "string") {
    throw new ValidationError(`${name} must be a string.`);
  }
  if (value.length < minLength) {
    throw new ValidationError(`${name} must contain at least ${minLength} character(s).`);
  }
  if (value.length > maxLength) {
    throw new ValidationError(`${name} must contain at most ${maxLength} characters.`);
  }
  return value;
}

export function optionalString(
  value,
  name,
  { minLength = 1, maxLength = 200_000, defaultValue = undefined } = {},
) {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  return requireString(value, name, { minLength, maxLength });
}

export function optionalBoolean(value, name, defaultValue = undefined) {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (typeof value !== "boolean") {
    throw new ValidationError(`${name} must be a boolean.`);
  }
  return value;
}

export function optionalInteger(
  value,
  name,
  { minimum = Number.MIN_SAFE_INTEGER, maximum = Number.MAX_SAFE_INTEGER, defaultValue = undefined } = {},
) {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (!Number.isInteger(value)) {
    throw new ValidationError(`${name} must be an integer.`);
  }
  if (value < minimum || value > maximum) {
    throw new ValidationError(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

export function optionalEnum(value, name, allowed, defaultValue = undefined) {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (!allowed.includes(value)) {
    throw new ValidationError(`${name} must be one of: ${allowed.join(", ")}.`);
  }
  return value;
}

export function requireRequestKey(value) {
  return requireString(value, "requestKey", { minLength: 3, maxLength: 1_024 });
}
