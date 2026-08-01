import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PathPolicy } from "../src/security.mjs";

test("PathPolicy allows roots and rejects escapes", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "codex-supervisor-security-"));
  t.after(async () => {
    await fs.rm(temporary, { recursive: true, force: true });
  });

  const root = path.join(temporary, "allowed");
  const repository = path.join(root, "repository");
  const outside = path.join(temporary, "outside");
  await fs.mkdir(repository, { recursive: true });
  await fs.mkdir(outside, { recursive: true });

  const policy = await PathPolicy.create({ allowedRoots: [root] });
  assert.equal(await policy.resolveCwd(repository), await fs.realpath(repository));
  assert.equal(await policy.resolveStoredPath(repository), await fs.realpath(repository));
  await assert.rejects(() => policy.resolveCwd(outside), /outside CODEX_ALLOWED_ROOTS/);

  const link = path.join(root, "escape-link");
  try {
    await fs.symlink(outside, link, "dir");
    await assert.rejects(() => policy.resolveCwd(link), /outside CODEX_ALLOWED_ROOTS/);
  } catch (error) {
    if (error?.code !== "EPERM") {
      throw error;
    }
  }

  const missing = path.join(await fs.realpath(root), "missing-repository");
  assert.equal(await policy.resolveStoredPath(missing), path.resolve(missing));
  await assert.rejects(
    () => policy.resolveStoredPath(missing, { mustExist: true }),
    /does not exist/,
  );
});
