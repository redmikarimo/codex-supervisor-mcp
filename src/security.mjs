import fs from "node:fs/promises";
import path from "node:path";

import { SecurityError, ValidationError } from "./errors.mjs";

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function realPathOrNull(candidate) {
  try {
    return await fs.realpath(candidate);
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return null;
    }
    throw error;
  }
}

async function assertDirectory(candidate, label) {
  let stats;
  try {
    stats = await fs.stat(candidate);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new ValidationError(`${label} does not exist: ${candidate}`);
    }
    throw error;
  }
  if (!stats.isDirectory()) {
    throw new ValidationError(`${label} must be a directory: ${candidate}`);
  }
}

export class PathPolicy {
  static async create({ allowedRoots = undefined } = {}) {
    const rawRoots = allowedRoots ?? process.env.CODEX_ALLOWED_ROOTS;
    if (rawRoots === undefined || rawRoots === null || rawRoots === "") {
      throw new SecurityError(
        "CODEX_ALLOWED_ROOTS is required. Set it to one or more explicit repository roots separated by the platform path delimiter.",
      );
    }
    if (
      (!Array.isArray(rawRoots) && typeof rawRoots !== "string") ||
      (Array.isArray(rawRoots) && rawRoots.some((entry) => typeof entry !== "string"))
    ) {
      throw new SecurityError("CODEX_ALLOWED_ROOTS must contain only filesystem paths.");
    }

    const roots = (Array.isArray(rawRoots) ? rawRoots : rawRoots.split(path.delimiter))
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");

    if (roots.length === 0) {
      throw new SecurityError("At least one allowed repository root is required.");
    }

    const canonicalRoots = [];
    for (const rawRoot of roots) {
      const resolved = path.resolve(rawRoot);
      await assertDirectory(resolved, "Allowed root");
      canonicalRoots.push(await fs.realpath(resolved));
    }

    return new PathPolicy([...new Set(canonicalRoots)]);
  }

  constructor(allowedRoots) {
    this.allowedRoots = allowedRoots;
  }

  describe() {
    return [...this.allowedRoots];
  }

  async resolveCwd(rawCwd) {
    if (typeof rawCwd !== "string" || rawCwd.trim() === "") {
      throw new ValidationError("cwd must be a non-empty path.");
    }

    const resolved = path.resolve(rawCwd);
    await assertDirectory(resolved, "cwd");
    const canonical = await fs.realpath(resolved);
    this.assertAllowedCanonical(canonical);
    return canonical;
  }

  assertAllowedCanonical(candidate) {
    if (!this.allowedRoots.some((root) => isInside(root, candidate))) {
      throw new SecurityError(
        `Path is outside CODEX_ALLOWED_ROOTS: ${candidate}. Allowed roots: ${this.allowedRoots.join(", ")}`,
      );
    }
  }

  async isAllowedStoredPath(rawPath) {
    if (typeof rawPath !== "string" || rawPath.trim() === "") {
      return false;
    }

    try {
      await this.resolveStoredPath(rawPath);
      return true;
    } catch (error) {
      if (error instanceof SecurityError || error instanceof ValidationError) {
        return false;
      }
      throw error;
    }
  }

  async resolveStoredPath(rawPath, { mustExist = false } = {}) {
    if (typeof rawPath !== "string" || rawPath.trim() === "") {
      throw new ValidationError("Stored cwd must be a non-empty path.");
    }

    const resolved = path.resolve(rawPath);
    const canonical = await realPathOrNull(resolved);
    if (canonical === null) {
      if (mustExist) {
        throw new ValidationError(`Stored cwd does not exist: ${resolved}`);
      }
      this.assertAllowedCanonical(resolved);
      return resolved;
    }

    await assertDirectory(canonical, "Stored cwd");
    this.assertAllowedCanonical(canonical);
    return canonical;
  }

  async assertAllowedStoredPath(rawPath) {
    return await this.resolveStoredPath(rawPath);
  }
}
