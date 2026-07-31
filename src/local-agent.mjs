#!/usr/bin/env node

import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { AppServerError } from "./errors.mjs";
import { PathPolicy } from "./security.mjs";
import { CodexSupervisorService } from "./supervisor-service.mjs";
import { createToolRegistry } from "./tool-registry.mjs";
import { signedFetch } from "./relay-auth.mjs";

const VERSION = "1.2.0";
const BASE_URL = (process.env.BIOTELE_RELAY_BASE_URL ?? "https://mcp.biotele.mx").replace(/\/+$/, "");
const AGENT_KEY_ID = process.env.BIOTELE_RELAY_AGENT_KEY_ID ?? "";
const AGENT_SECRET = process.env.BIOTELE_RELAY_AGENT_SECRET ?? "";
const POLL_WAIT_MS = Number.parseInt(process.env.BIOTELE_LOCAL_AGENT_POLL_WAIT_MS ?? "25000", 10);
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.BIOTELE_LOCAL_AGENT_REQUEST_TIMEOUT_MS ?? "45000", 10);
const MAX_BACKOFF_MS = Number.parseInt(process.env.BIOTELE_LOCAL_AGENT_MAX_BACKOFF_MS ?? "30000", 10);
const COMPLETED_CACHE_MS = Number.parseInt(process.env.BIOTELE_LOCAL_AGENT_COMPLETED_CACHE_MS ?? "600000", 10);

function assertStartupConfig() {
  if (!AGENT_KEY_ID || !AGENT_SECRET) {
    throw new Error("BIOTELE_RELAY_AGENT_KEY_ID and BIOTELE_RELAY_AGENT_SECRET are required.");
  }
  if (Buffer.byteLength(AGENT_SECRET, "utf8") < 32) {
    throw new Error("BIOTELE_RELAY_AGENT_SECRET must contain at least 32 bytes.");
  }
  for (const [value, name] of [
    [POLL_WAIT_MS, "BIOTELE_LOCAL_AGENT_POLL_WAIT_MS"],
    [REQUEST_TIMEOUT_MS, "BIOTELE_LOCAL_AGENT_REQUEST_TIMEOUT_MS"],
    [MAX_BACKOFF_MS, "BIOTELE_LOCAL_AGENT_MAX_BACKOFF_MS"],
    [COMPLETED_CACHE_MS, "BIOTELE_LOCAL_AGENT_COMPLETED_CACHE_MS"],
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer.`);
    }
  }
}

function redactError(error) {
  const message = String(error?.message ?? error);
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/(token|secret|key|password)=([^&\s]+)/gi, "$1=[REDACTED]");
}

function completeToolResult(output, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
    structuredContent: output,
    isError,
  };
}

function errorToolResult(error) {
  return completeToolResult(
    {
      error: {
        type: error?.name ?? "Error",
        message: redactError(error),
        ...(error instanceof AppServerError
          ? {
              code: error.code ?? null,
              method: error.method ?? null,
              data: error.data ?? null,
            }
          : {}),
      },
    },
    true,
  );
}

class CompletedJobCache {
  constructor({ ttlMs }) {
    this.ttlMs = ttlMs;
    this.entries = new Map();
  }

  get(jobId) {
    this.#reap();
    return this.entries.get(jobId)?.result;
  }

  set(jobId, result) {
    this.#reap();
    this.entries.set(jobId, {
      expiresAt: Date.now() + this.ttlMs,
      result,
    });
  }

  #reap() {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }
}

async function requestRelay(path, bodyObject, timeoutMs = REQUEST_TIMEOUT_MS) {
  const response = await signedFetch(`${BASE_URL}${path}`, {
    method: "POST",
    bodyObject,
    keyId: AGENT_KEY_ID,
    secret: AGENT_SECRET,
    timeoutMs,
  });
  if (response.status === 204) {
    return null;
  }
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`Relay ${path} failed with HTTP ${response.status}: ${payload?.message ?? payload?.error ?? text}`);
  }
  return payload;
}

async function submitResult(job, payload) {
  await requestRelay(
    "/agent/jobs/result",
    {
      jobId: job.id,
      leaseId: job.leaseId,
      ...payload,
    },
    REQUEST_TIMEOUT_MS,
  );
}

async function assertJobAllowed(job, pathPolicy) {
  if (typeof job?.id !== "string" || typeof job?.leaseId !== "string") {
    throw new Error("Relay delivered a malformed job.");
  }
  if (job.arguments?.sandboxMode === "danger-full-access") {
    throw new Error("danger-full-access is not supported by the local agent.");
  }
  if (job.arguments?.networkAccess === true && process.env.CODEX_ALLOW_NETWORK !== "1") {
    throw new Error("Network access is disabled for this local agent.");
  }

  const cwd = job.arguments?.cwd;
  if (typeof cwd === "string" && cwd.trim()) {
    await pathPolicy.resolveCwd(cwd);
  }
}

export class LocalRelayAgent {
  constructor({
    service,
    tools,
    pathPolicy,
    completed = new CompletedJobCache({ ttlMs: COMPLETED_CACHE_MS }),
  }) {
    this.service = service;
    this.tools = tools;
    this.pathPolicy = pathPolicy;
    this.completed = completed;
    this.stopping = false;
    this.inFlight = new Set();
  }

  async run() {
    process.stderr.write(`Biotele local agent v${VERSION} polling ${BASE_URL}\n`);
    let backoffMs = 1_000;
    while (!this.stopping) {
      try {
        const payload = await requestRelay(
          "/agent/jobs/claim",
          { maxWaitMs: POLL_WAIT_MS },
          POLL_WAIT_MS + REQUEST_TIMEOUT_MS,
        );
        backoffMs = 1_000;
        if (!payload?.job) {
          continue;
        }
        await this.#handleJob(payload.job);
      } catch (error) {
        process.stderr.write(`[local-agent] ${redactError(error)}\n`);
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      }
    }
  }

  async stop() {
    this.stopping = true;
    await this.service.close?.();
  }

  async #handleJob(job) {
    const cached = this.completed.get(job.id);
    if (cached) {
      await submitResult(job, { result: cached });
      return;
    }
    if (this.inFlight.has(job.id)) {
      await submitResult(job, {
        error: {
          type: "DuplicateJob",
          message: "Job is already running in this local agent.",
        },
      });
      return;
    }

    this.inFlight.add(job.id);
    try {
      await assertJobAllowed(job, this.pathPolicy);
      if (!this.tools.has(job.toolName)) {
        throw new Error(`Unknown tool: ${String(job.toolName)}`);
      }
      const output = await this.tools.call(job.toolName, job.arguments ?? {});
      const result = completeToolResult(output);
      this.completed.set(job.id, result);
      await submitResult(job, { result });
    } catch (error) {
      const result = errorToolResult(error);
      this.completed.set(job.id, result);
      await submitResult(job, { result });
    } finally {
      this.inFlight.delete(job.id);
    }
  }
}

export async function createLocalRelayAgent() {
  assertStartupConfig();
  const pathPolicy = await PathPolicy.create();
  const service = await CodexSupervisorService.create({ pathPolicy });
  return new LocalRelayAgent({
    service,
    tools: createToolRegistry(service),
    pathPolicy,
  });
}

export async function main() {
  const agent = await createLocalRelayAgent();
  const shutdown = async () => {
    await agent.stop();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  await agent.run();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${redactError(error)}\n`);
    process.exitCode = 1;
  });
}
