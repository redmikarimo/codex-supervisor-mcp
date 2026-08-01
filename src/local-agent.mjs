#!/usr/bin/env node

import { setTimeout as sleep } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { AppServerError } from "./errors.mjs";
import { PathPolicy } from "./security.mjs";
import { CodexSupervisorService } from "./supervisor-service.mjs";
import { createToolRegistry } from "./tool-registry.mjs";
import { signedFetch } from "./relay-auth.mjs";
import {
  DEFAULT_MAX_RESULT_BYTES,
  DEFAULT_RESULT_CHUNK_BYTES,
  DEFAULT_MAX_RESULT_CHUNKS,
  MIN_RESULT_BYTES,
  RESULT_SUBMISSION_PROTOCOL,
  ResultTooLargeError,
  encodeResultSubmission,
} from "./relay-result-protocol.mjs";

const VERSION = "1.2.3";
const BASE_URL = (process.env.BIOTELE_RELAY_BASE_URL ?? "https://mcp.biotele.mx").replace(/\/+$/, "");
const AGENT_KEY_ID = process.env.BIOTELE_RELAY_AGENT_KEY_ID ?? "";
const AGENT_SECRET = process.env.BIOTELE_RELAY_AGENT_SECRET ?? "";
const POLL_WAIT_MS = Number.parseInt(process.env.BIOTELE_LOCAL_AGENT_POLL_WAIT_MS ?? "25000", 10);
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.BIOTELE_LOCAL_AGENT_REQUEST_TIMEOUT_MS ?? "45000", 10);
const MAX_BACKOFF_MS = Number.parseInt(process.env.BIOTELE_LOCAL_AGENT_MAX_BACKOFF_MS ?? "30000", 10);
const COMPLETED_CACHE_MS = Number.parseInt(process.env.BIOTELE_LOCAL_AGENT_COMPLETED_CACHE_MS ?? "600000", 10);
const MAX_RESULT_BYTES = Number.parseInt(
  process.env.BIOTELE_LOCAL_AGENT_MAX_RESULT_BYTES ?? String(DEFAULT_MAX_RESULT_BYTES),
  10,
);
const LEGACY_MAX_RESULT_BYTES = 128 * 1024;
const MAX_INLINE_CONTENT_BYTES = 16 * 1024;
const DEFAULT_COMPLETED_CACHE_ENTRIES = 100;
const DEFAULT_COMPLETED_CACHE_BYTES = 8 * 1024 * 1024;
const MIN_ADAPTIVE_CHUNK_BYTES = 512;
const RESULT_RETRY_DELAYS_MS = [100, 250, 500, 1_000];
const RESULT_BUDGET_SAFETY_MS = 2_000;
const MIN_REPLAY_SENSITIVE_BUDGET_MS = 10_000;
const REPLAY_SENSITIVE_TOOLS = new Set([
  "codex_start",
  "codex_send",
  "codex_steer",
  "codex_interrupt",
  "codex_resolve_approval",
]);
const monotonicNow = () => performance.now();

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
    [MAX_RESULT_BYTES, "BIOTELE_LOCAL_AGENT_MAX_RESULT_BYTES"],
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer.`);
    }
  }
  if (MAX_RESULT_BYTES < MIN_RESULT_BYTES) {
    throw new Error(
      `BIOTELE_LOCAL_AGENT_MAX_RESULT_BYTES must be at least ${MIN_RESULT_BYTES}.`,
    );
  }
}

function redactError(error) {
  const message = String(error?.message ?? error);
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/(token|secret|key|password)=([^&\s]+)/gi, "$1=[REDACTED]");
}

function completeToolResult(output, isError = false) {
  const serialized = JSON.stringify(output, null, 2);
  const text =
    Buffer.byteLength(serialized, "utf8") <= MAX_INLINE_CONTENT_BYTES
      ? serialized
      : `Structured result available (${Buffer.byteLength(serialized, "utf8")} bytes).`;
  return {
    content: [{ type: "text", text }],
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

export class CompletedJobCache {
  constructor({
    ttlMs,
    maxEntries = DEFAULT_COMPLETED_CACHE_ENTRIES,
    maxBytes = DEFAULT_COMPLETED_CACHE_BYTES,
    now = () => Date.now(),
  }) {
    for (const [value, name] of [
      [ttlMs, "ttlMs"],
      [maxEntries, "maxEntries"],
      [maxBytes, "maxBytes"],
    ]) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer.`);
      }
    }
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.now = now;
    this.entries = new Map();
    this.bytes = 0;
  }

  get(jobId) {
    this.#reap();
    return this.entries.get(jobId)?.result;
  }

  set(jobId, result) {
    this.#reap();
    this.delete(jobId);
    const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    if (bytes > this.maxBytes) {
      return false;
    }
    while (
      this.entries.size >= this.maxEntries ||
      this.bytes + bytes > this.maxBytes
    ) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.delete(oldest);
    }
    this.entries.set(jobId, {
      expiresAt: this.now() + this.ttlMs,
      result,
      bytes,
    });
    this.bytes += bytes;
    return true;
  }

  delete(jobId) {
    const entry = this.entries.get(jobId);
    if (!entry) {
      return false;
    }
    this.entries.delete(jobId);
    this.bytes -= entry.bytes;
    return true;
  }

  #reap() {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.delete(key);
      }
    }
  }
}

export async function parseRelayResponse(response, path) {
  if (response.status === 204) {
    return null;
  }
  const text = await response.text();
  let payload = null;
  let parsed = false;
  if (text) {
    try {
      payload = JSON.parse(text);
      parsed = true;
    } catch {
      payload = null;
    }
  }
  if (!response.ok) {
    const fallback = text.trim().slice(0, 160) || response.statusText || "non-JSON response";
    const error = new Error(
      `Relay ${path} failed with HTTP ${response.status}: ${payload?.message ?? payload?.error ?? fallback}`,
    );
    error.statusCode = response.status;
    error.transient =
      response.status === 408 ||
      response.status === 425 ||
      response.status === 429 ||
      response.status >= 500;
    throw error;
  }
  if (text && !parsed) {
    const error = new Error(
      `Relay ${path} returned non-JSON data with HTTP ${response.status}.`,
    );
    error.transient = false;
    throw error;
  }
  return payload;
}

async function requestRelay(path, bodyObject, timeoutMs = REQUEST_TIMEOUT_MS) {
  const response = await signedFetch(`${BASE_URL}${path}`, {
    method: "POST",
    bodyObject,
    keyId: AGENT_KEY_ID,
    secret: AGENT_SECRET,
    timeoutMs,
  });
  return await parseRelayResponse(response, path);
}

function positiveAdvertisedInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function negotiatedResultLimits(capability) {
  const supportsChunked =
    capability?.preferredProtocol === RESULT_SUBMISSION_PROTOCOL &&
    Array.isArray(capability.supportedProtocols) &&
    capability.supportedProtocols.includes(RESULT_SUBMISSION_PROTOCOL);
  if (!supportsChunked) {
    return {
      supportsChunked: false,
      maxResultBytes: Math.min(MAX_RESULT_BYTES, LEGACY_MAX_RESULT_BYTES),
      chunkBytes: DEFAULT_RESULT_CHUNK_BYTES,
      maxChunks: 1,
    };
  }

  const advertisedMax = positiveAdvertisedInteger(
    capability.maxResultBytes,
    DEFAULT_MAX_RESULT_BYTES,
  );
  const advertisedChunk = positiveAdvertisedInteger(
    capability.chunkBytes,
    DEFAULT_RESULT_CHUNK_BYTES,
  );
  const advertisedMaxChunks = positiveAdvertisedInteger(
    capability.maxChunks,
    DEFAULT_MAX_RESULT_CHUNKS,
  );
  const chunkBytes = Math.min(DEFAULT_RESULT_CHUNK_BYTES, advertisedChunk);
  const maxChunks = Math.min(DEFAULT_MAX_RESULT_CHUNKS, advertisedMaxChunks);
  const maxResultBytes = Math.min(
    MAX_RESULT_BYTES,
    advertisedMax,
    chunkBytes * maxChunks,
  );
  if (maxResultBytes < MIN_RESULT_BYTES) {
    throw new Error(
      `Relay result capability must allow at least ${MIN_RESULT_BYTES} bytes.`,
    );
  }
  return {
    supportsChunked: true,
    maxResultBytes,
    chunkBytes,
    maxChunks,
  };
}

function boundToolResult(result, capability) {
  const { maxResultBytes } = negotiatedResultLimits(capability);
  const actualBytes = Buffer.byteLength(JSON.stringify({ result }), "utf8");
  if (actualBytes <= maxResultBytes) {
    return result;
  }
  return errorToolResult(new ResultTooLargeError(actualBytes, maxResultBytes));
}

function resultDeadline(job, now) {
  return Number.isFinite(job?.localResultDeadlineAt) && job.localResultDeadlineAt > 0
    ? job.localResultDeadlineAt
    : now + REQUEST_TIMEOUT_MS;
}

function anchorResultBudget(job, now = monotonicNow()) {
  if (Number.isFinite(job?.localResultDeadlineAt) && job.localResultDeadlineAt > 0) {
    return job;
  }
  if (!Number.isSafeInteger(job?.resultBudgetMs) || job.resultBudgetMs < 0) {
    return job;
  }
  return {
    ...job,
    localResultDeadlineAt:
      now + Math.max(0, job.resultBudgetMs - RESULT_BUDGET_SAFETY_MS),
  };
}

async function requestResultWithRetry(body, {
  job,
  request,
  sleepFn,
  now,
  retryDelays = RESULT_RETRY_DELAYS_MS,
}) {
  const deadline = resultDeadline(job, now());
  let attempt = 0;
  while (true) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new Error("Relay result deadline expired before upload completed.");
    }
    try {
      return await request(
        "/agent/jobs/result",
        body,
        Math.max(100, Math.min(REQUEST_TIMEOUT_MS, remaining)),
      );
    } catch (error) {
      const delay = retryDelays[attempt];
      if (error?.statusCode === 413 || error?.transient === false || delay === undefined) {
        throw error;
      }
      attempt += 1;
      if (now() + delay >= deadline) {
        throw error;
      }
      await sleepFn(delay);
    }
  }
}

function adaptiveTooLargePayload(actualBytes, maxBytes) {
  return {
    result: errorToolResult(new ResultTooLargeError(actualBytes, maxBytes)),
  };
}

export async function submitResult(job, payload, capability, {
  request = requestRelay,
  sleepFn = sleep,
  now = monotonicNow,
  retryDelays = RESULT_RETRY_DELAYS_MS,
} = {}) {
  const limits = negotiatedResultLimits(capability);
  if (!limits.supportsChunked) {
    await requestResultWithRetry(
      {
        jobId: job.id,
        leaseId: job.leaseId,
        ...payload,
      },
      { job, request, sleepFn, now, retryDelays },
    );
    return;
  }

  let chunkBytes = limits.chunkBytes;
  let effectivePayload = payload;
  const originalBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  while (true) {
    const adaptiveLimit = Math.min(
      limits.maxResultBytes,
      chunkBytes * limits.maxChunks,
    );
    if (Buffer.byteLength(JSON.stringify(effectivePayload), "utf8") > adaptiveLimit) {
      effectivePayload = adaptiveTooLargePayload(originalBytes, adaptiveLimit);
    }
    const encoded = encodeResultSubmission(effectivePayload, {
      maxResultBytes: adaptiveLimit,
      chunkBytes,
      maxChunks: limits.maxChunks,
    });
    try {
      for (const submission of encoded.submissions) {
        await requestResultWithRetry(
          {
            jobId: job.id,
            leaseId: job.leaseId,
            submission,
          },
          { job, request, sleepFn, now, retryDelays },
        );
      }
      return;
    } catch (error) {
      if (error?.statusCode !== 413 || chunkBytes <= MIN_ADAPTIVE_CHUNK_BYTES) {
        throw error;
      }
      chunkBytes = Math.max(MIN_ADAPTIVE_CHUNK_BYTES, Math.floor(chunkBytes / 2));
    }
  }
}

async function assertJobAllowed(job, pathPolicy) {
  if (typeof job?.id !== "string" || typeof job?.leaseId !== "string") {
    throw new Error("Relay delivered a malformed job.");
  }
  if (!Number.isSafeInteger(job.deliveryCount) || job.deliveryCount <= 0) {
    throw new Error("Relay delivered an invalid job delivery count.");
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
    submit = submitResult,
  }) {
    this.service = service;
    this.tools = tools;
    this.pathPolicy = pathPolicy;
    this.completed = completed;
    this.submit = submit;
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
        await this.handleJob(payload.job, payload.resultSubmission);
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

  async handleJob(job, resultSubmission) {
    job = anchorResultBudget(job);
    const cached = this.completed.get(job.id);
    if (cached) {
      await this.submit(job, { result: cached }, resultSubmission);
      this.completed.delete(job.id);
      return;
    }
    if (
      Number.isSafeInteger(job.deliveryCount) &&
      job.deliveryCount > 1 &&
      REPLAY_SENSITIVE_TOOLS.has(job.toolName)
    ) {
      const result = errorToolResult(
        Object.assign(
          new Error(
            "A replay-sensitive Codex operation was re-delivered without a cached outcome and was not executed again.",
          ),
          { name: "UnsafeRedelivery" },
        ),
      );
      await this.submit(job, { result }, resultSubmission);
      return;
    }
    if (
      REPLAY_SENSITIVE_TOOLS.has(job.toolName) &&
      Number.isSafeInteger(job.resultBudgetMs) &&
      job.resultBudgetMs < MIN_REPLAY_SENSITIVE_BUDGET_MS
    ) {
      const result = errorToolResult(
        Object.assign(
          new Error(
            `Only ${job.resultBudgetMs}ms remained to execute and report a replay-sensitive Codex operation, so it was not started.`,
          ),
          { name: "InsufficientResultBudget" },
        ),
      );
      await this.submit(job, { result }, resultSubmission);
      return;
    }
    if (this.inFlight.has(job.id)) {
      await this.submit(job, {
        error: {
          type: "DuplicateJob",
          message: "Job is already running in this local agent.",
        },
      }, resultSubmission);
      return;
    }

    this.inFlight.add(job.id);
    try {
      let result;
      try {
        await assertJobAllowed(job, this.pathPolicy);
        if (!this.tools.has(job.toolName)) {
          throw new Error(`Unknown tool: ${String(job.toolName)}`);
        }
        const output = await this.tools.call(job.toolName, job.arguments ?? {});
        result = completeToolResult(output);
      } catch (error) {
        result = errorToolResult(error);
      }
      result = boundToolResult(result, resultSubmission);
      this.completed.set(job.id, result);
      await this.submit(job, { result }, resultSubmission);
      this.completed.delete(job.id);
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
