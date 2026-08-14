import { randomBytes, randomUUID } from "node:crypto";

import { CODEX_AGENT_ROUTE, isAgentRoute, routeForToolName } from "./agent-routing.mjs";

function shortId() {
  return randomBytes(12).toString("base64url");
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function abortReason(signal, message) {
  return signal?.reason ?? Object.assign(new Error(message), { name: "AbortError" });
}

export class RelayQueue {
  constructor({
    jobTtlMs = 2 * 60_000,
    leaseMs = 60_000,
    maxQueuedJobs = 200,
    now = () => Date.now(),
  } = {}) {
    this.jobTtlMs = jobTtlMs;
    this.leaseMs = leaseMs;
    this.maxQueuedJobs = maxQueuedJobs;
    this.now = now;
    this.jobs = new Map();
    this.waiters = [];
  }

  get size() {
    this.#reap();
    return this.jobs.size;
  }

  enqueue({
    toolName,
    arguments: args,
    requestId = randomUUID(),
    resultTimeoutMs = undefined,
    mcpReceivedAt = undefined,
  }) {
    this.#reap();
    if (this.jobs.size >= this.maxQueuedJobs) {
      throw new Error("Relay job queue is full.");
    }

    const now = this.now();
    if (mcpReceivedAt !== undefined && !Number.isSafeInteger(mcpReceivedAt)) {
      throw new TypeError("mcpReceivedAt must be a safe integer when provided.");
    }
    const completion = deferred();
    const job = {
      id: shortId(),
      requestId,
      toolName,
      route: routeForToolName(toolName),
      arguments: args ?? {},
      state: "queued",
      createdAt: now,
      queuedAt: now,
      mcpReceivedAt,
      claimedAt: undefined,
      expiresAt: now + this.jobTtlMs,
      resultDeadlineAt:
        Number.isSafeInteger(resultTimeoutMs) && resultTimeoutMs > 0
          ? Math.min(now + this.jobTtlMs, now + resultTimeoutMs)
          : now + this.jobTtlMs,
      deliveryCount: 0,
      leaseId: null,
      leasedUntil: 0,
      completion,
    };
    this.jobs.set(job.id, job);
    this.#notifyWaiter();
    return job;
  }

  claim({ leaseOwner = undefined, agentRoute = CODEX_AGENT_ROUTE } = {}) {
    if (!isAgentRoute(agentRoute)) {
      throw new TypeError("Unknown authenticated agent route.");
    }
    this.#reap();
    const now = this.now();
    for (const job of this.jobs.values()) {
      const claimable =
        job.state === "queued" ||
        (job.state === "claimed" && job.leasedUntil <= now);
      if (!claimable) {
        continue;
      }
      if (job.route !== agentRoute) {
        continue;
      }
      job.state = "claimed";
      job.deliveryCount += 1;
      job.leaseId = shortId();
      job.leaseOwner = leaseOwner;
      job.leasedUntil = now + this.leaseMs;
      job.claimedAt = now;
      const resultBudgetMs = Math.max(
        0,
        Math.min(job.expiresAt, job.leasedUntil, job.resultDeadlineAt) - now,
      );
      return {
        id: job.id,
        leaseId: job.leaseId,
        requestId: job.requestId,
        toolName: job.toolName,
        arguments: job.arguments,
        expiresAt: job.expiresAt,
        leasedUntil: job.leasedUntil,
        resultDeadlineAt: job.resultDeadlineAt ?? job.expiresAt,
        resultBudgetMs,
        deliveryCount: job.deliveryCount,
        queuedAt: job.queuedAt,
        claimedAt: job.claimedAt,
      };
    }
    return null;
  }

  async waitForClaimable({
    timeoutMs = 25_000,
    signal = undefined,
    leaseOwner = undefined,
    agentRoute = CODEX_AGENT_ROUTE,
  } = {}) {
    if (signal?.aborted) {
      throw abortReason(signal, "Claim wait aborted.");
    }
    const immediate = this.claim({ leaseOwner, agentRoute });
    if (immediate) {
      return immediate;
    }

    return await new Promise((resolve, reject) => {
      const waiter = { resolve, reject, leaseOwner, agentRoute };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
      };
      const finish = (value) => {
        cleanup();
        resolve(value);
      };
      const onAbort = () => {
        cleanup();
        reject(abortReason(signal, "Claim wait aborted."));
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      waiter.resolve = finish;
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  complete({ jobId, leaseId, leaseOwner = undefined, result = undefined, error = undefined }) {
    const job = this.assertCurrentLease({ jobId, leaseId, leaseOwner });
    const resultReceivedAt = this.now();
    const relayTiming = Number.isSafeInteger(job.mcpReceivedAt)
      ? {
          mcpReceivedAt: job.mcpReceivedAt,
          queuedAt: job.queuedAt,
          claimedAt: job.claimedAt,
          resultReceivedAt,
        }
      : undefined;

    this.jobs.delete(jobId);
    if (error !== undefined) {
      job.completion.resolve({ error, ...(relayTiming ? { relayTiming } : {}) });
    } else {
      job.completion.resolve({ result, ...(relayTiming ? { relayTiming } : {}) });
    }
  }

  assertCurrentLease({ jobId, leaseId, leaseOwner = undefined }) {
    this.#reap();
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error("Unknown or expired job id.");
    }
    if (job.state !== "claimed" || job.leaseId !== leaseId) {
      throw new Error("Job lease is not current.");
    }
    if (job.leasedUntil <= this.now()) {
      throw new Error("Job lease has expired.");
    }
    if (leaseOwner !== undefined && job.leaseOwner !== leaseOwner) {
      throw new Error("Job lease belongs to another agent identity.");
    }
    return job;
  }

  async waitForResult(job, { timeoutMs, signal = undefined } = {}) {
    this.#reap();
    if (this.jobs.get(job.id) !== job) {
      return await job.completion.promise;
    }
    if (signal?.aborted) {
      const reason = abortReason(signal, "Result wait aborted.");
      if (this.#cancel(job, "RelayCancelled", "The MCP client disconnected before the job completed.")) {
        throw reason;
      }
      return await job.completion.promise;
    }
    job.resultDeadlineAt = Math.min(job.resultDeadlineAt, this.now() + timeoutMs);
    return await new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const timer = setTimeout(() => {
        this.#cancel(
          job,
          "RelayTimeout",
          "Timed out waiting for the local agent to finish the job.",
        );
      }, timeoutMs);
      const onAbort = () => {
        const reason = abortReason(signal, "Result wait aborted.");
        if (this.#cancel(job, "RelayCancelled", "The MCP client disconnected before the job completed.")) {
          cleanup();
          reject(reason);
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      job.completion.promise.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
    });
  }

  shutdown(message = "Relay is shutting down.") {
    for (const [id, job] of this.jobs) {
      this.jobs.delete(id);
      job.completion.resolve({
        error: {
          type: "RelayShutdown",
          message,
        },
      });
    }
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve(null);
    }
  }

  #notifyWaiter() {
    const waiterCount = this.waiters.length;
    for (let index = 0; index < waiterCount; index += 1) {
      const waiter = this.waiters.shift();
      const claimed = this.claim({
        leaseOwner: waiter.leaseOwner,
        agentRoute: waiter.agentRoute,
      });
      if (claimed) {
        waiter.resolve(claimed);
        return;
      }
      this.waiters.push(waiter);
    }
  }

  #cancel(job, type, message) {
    if (this.jobs.get(job.id) !== job) {
      return false;
    }
    this.jobs.delete(job.id);
    job.completion.resolve({
      error: {
        type,
        message,
      },
    });
    return true;
  }

  #reap() {
    const now = this.now();
    for (const [id, job] of this.jobs) {
      if (job.expiresAt <= now) {
        this.jobs.delete(id);
        job.completion.resolve({
          error: {
            type: "RelayExpired",
            message: "Relay job expired before completion.",
          },
        });
      }
    }
  }
}
