import { AppServerClient } from "./app-server-client.mjs";
import {
  DEFAULT_APPROVAL_POLICY,
  normalizeApprovalPolicy,
} from "./approval-policy.mjs";
import { AppServerError, SecurityError, ValidationError } from "./errors.mjs";
import { EventStore } from "./event-store.mjs";
import { PathPolicy } from "./security.mjs";
import {
  DEFAULT_SANDBOX_MODE,
  normalizeSandboxMode,
  toSandboxPolicyType,
} from "./sandbox-mode.mjs";

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
]);

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null),
  );
}

function buildSandboxPolicy(cwd, sandboxMode, networkAccess) {
  const policyType = toSandboxPolicyType(sandboxMode);
  if (policyType === "readOnly") {
    return {
      type: "readOnly",
    };
  }

  return {
    type: "workspaceWrite",
    writableRoots: [cwd],
    networkAccess,
  };
}

function extractThreadCwd(thread) {
  return thread?.cwd ?? thread?.workingDirectory ?? null;
}

export class CodexSupervisorService {
  static async create({
    pathPolicy = undefined,
    eventStore = undefined,
    appServerClient = undefined,
  } = {}) {
    const resolvedPolicy = pathPolicy ?? (await PathPolicy.create());
    const resolvedStore = eventStore ?? appServerClient?.eventStore ?? new EventStore();
    const resolvedClient =
      appServerClient ??
      new AppServerClient({
        eventStore: resolvedStore,
      });

    return new CodexSupervisorService({
      pathPolicy: resolvedPolicy,
      eventStore: resolvedStore,
      appServerClient: resolvedClient,
    });
  }

  constructor({ pathPolicy, eventStore, appServerClient }) {
    this.pathPolicy = pathPolicy;
    this.eventStore = eventStore;
    this.appServerClient = appServerClient;
    this.authorizedThreads = new Map();
    this.mutationLocks = new Map();
  }

  async startTask({
    cwd,
    prompt,
    model = undefined,
    effort = undefined,
    sandboxMode = DEFAULT_SANDBOX_MODE,
    networkAccess = false,
    approvalPolicy = DEFAULT_APPROVAL_POLICY,
  }) {
    const canonicalCwd = await this.pathPolicy.resolveCwd(cwd);
    this.#assertNetworkAllowed(networkAccess);
    const resolvedApprovalPolicy = normalizeApprovalPolicy(approvalPolicy);
    const resolvedSandboxMode = normalizeSandboxMode(sandboxMode);

    const threadResult = await this.appServerClient.request(
      "thread/start",
      compactObject({
        cwd: canonicalCwd,
        model,
        approvalPolicy: resolvedApprovalPolicy,
        sandbox: resolvedSandboxMode,
        serviceName: "codex_supervisor_mcp",
      }),
    );

    const threadId = threadResult?.thread?.id;
    if (!threadId) {
      throw new AppServerError("Codex thread/start returned no thread id.");
    }
    this.authorizedThreads.set(threadId, canonicalCwd);

    const eventCursor = this.eventStore.sequence;
    const turnResult = await this.appServerClient.request(
      "turn/start",
      compactObject({
        threadId,
        input: [{ type: "text", text: prompt }],
        cwd: canonicalCwd,
        model,
        effort,
        approvalPolicy: resolvedApprovalPolicy,
        sandboxPolicy: buildSandboxPolicy(canonicalCwd, resolvedSandboxMode, networkAccess),
      }),
    );

    const turnId = turnResult?.turn?.id;
    if (!turnId) {
      throw new AppServerError("Codex turn/start returned no turn id.");
    }

    return {
      threadId,
      turnId,
      thread: threadResult.thread,
      turn: turnResult.turn,
      instructionSources: threadResult.instructionSources ?? [],
      eventCursor,
      safety: {
        cwd: canonicalCwd,
        sandboxMode: resolvedSandboxMode,
        networkAccess,
        approvalPolicy: resolvedApprovalPolicy,
      },
    };
  }

  async send({
    threadId,
    prompt,
    cwd = undefined,
    model = undefined,
    effort = undefined,
    sandboxMode = DEFAULT_SANDBOX_MODE,
    networkAccess = false,
    approvalPolicy = DEFAULT_APPROVAL_POLICY,
  }) {
    return await this.#withMutationLock(`thread:${threadId}`, async () => {
      const authorization = await this.#ensureAuthorizedThread(threadId, {
        forExecution: cwd === undefined || cwd === null,
      });
      const canonicalCwd = cwd
        ? await this.pathPolicy.resolveCwd(cwd)
        : authorization.cwd;
      this.#assertNetworkAllowed(networkAccess);
      const resolvedApprovalPolicy = normalizeApprovalPolicy(approvalPolicy);
      const resolvedSandboxMode = normalizeSandboxMode(sandboxMode);

      if (this.eventStore.getActiveTurnId(threadId)) {
        throw new ValidationError(
          `Thread ${threadId} already has an active turn. Use codex_steer or codex_interrupt.`,
        );
      }

      if (!this.appServerClient.loadedThreads.has(threadId)) {
        await this.appServerClient.request(
          "thread/resume",
          compactObject({
            threadId,
            cwd: canonicalCwd,
            model,
            approvalPolicy: resolvedApprovalPolicy,
            sandbox: resolvedSandboxMode,
          }),
        );
      }

      const eventCursor = this.eventStore.sequence;
      const turnResult = await this.appServerClient.request(
        "turn/start",
        compactObject({
          threadId,
          input: [{ type: "text", text: prompt }],
          cwd: canonicalCwd,
          model,
          effort,
          approvalPolicy: resolvedApprovalPolicy,
          sandboxPolicy: buildSandboxPolicy(canonicalCwd, resolvedSandboxMode, networkAccess),
        }),
      );

      const turnId = turnResult?.turn?.id;
      if (!turnId) {
        throw new AppServerError("Codex turn/start returned no turn id.");
      }

      this.authorizedThreads.set(threadId, canonicalCwd);
      return {
        threadId,
        turnId,
        turn: turnResult.turn,
        eventCursor,
        safety: {
          cwd: canonicalCwd,
          sandboxMode: resolvedSandboxMode,
          networkAccess,
          approvalPolicy: resolvedApprovalPolicy,
        },
      };
    });
  }

  async steer({ threadId, prompt, expectedTurnId = undefined }) {
    return await this.#withMutationLock(`thread:${threadId}`, async () => {
      await this.#ensureAuthorizedThread(threadId, { forExecution: true });
      const activeTurnId = this.eventStore.getActiveTurnId(threadId);
      const turnId = expectedTurnId ?? activeTurnId;

      if (!turnId) {
        throw new ValidationError(`Thread ${threadId} has no active turn to steer.`);
      }
      if (activeTurnId && expectedTurnId && activeTurnId !== expectedTurnId) {
        throw new ValidationError(
          `expectedTurnId ${expectedTurnId} does not match active turn ${activeTurnId}.`,
        );
      }

      const eventCursor = this.eventStore.sequence;
      const result = await this.appServerClient.request("turn/steer", {
        threadId,
        input: [{ type: "text", text: prompt }],
        expectedTurnId: turnId,
      });

      return {
        threadId,
        turnId: result?.turnId ?? turnId,
        eventCursor,
      };
    });
  }

  async interrupt({ threadId, turnId = undefined }) {
    return await this.#withMutationLock(`thread:${threadId}`, async () => {
      await this.#ensureAuthorizedThread(threadId, { forExecution: true });
      const activeTurnId = this.eventStore.getActiveTurnId(threadId);
      const resolvedTurnId = turnId ?? activeTurnId;
      if (!resolvedTurnId) {
        throw new ValidationError(`Thread ${threadId} has no known active turn.`);
      }
      if (turnId && activeTurnId && turnId !== activeTurnId) {
        throw new ValidationError(
          `turnId ${turnId} does not match active turn ${activeTurnId}.`,
        );
      }

      const eventCursor = this.eventStore.sequence;
      await this.appServerClient.request("turn/interrupt", {
        threadId,
        turnId: resolvedTurnId,
      });

      return {
        threadId,
        turnId: resolvedTurnId,
        interrupted: true,
        eventCursor,
      };
    });
  }

  async status({
    threadId,
    afterSequence = 0,
    maxEvents = 50,
    includeTurns = false,
  }) {
    const authorization = await this.#ensureAuthorizedThread(threadId, { includeTurns });
    return {
      thread: authorization.thread,
      ...this.eventStore.getSnapshot(threadId, { afterSequence, maxEvents }),
      appServer: this.appServerClient.describe(),
    };
  }

  async wait({
    threadId,
    afterSequence = 0,
    maxEvents = 100,
    timeoutMs = 30_000,
    signal = undefined,
  }) {
    await this.#ensureAuthorizedThread(threadId);
    const waited = await this.eventStore.waitFor(threadId, {
      afterSequence,
      maxEvents,
      timeoutMs,
      signal,
    });

    let thread = null;
    try {
      const result = await this.appServerClient.request("thread/read", {
        threadId,
        includeTurns: false,
      });
      thread = result?.thread ?? null;
      await this.#authorizeThreadObject(thread, threadId);
    } catch (error) {
      if (waited.reason !== "error") {
        throw error;
      }
    }

    return {
      thread,
      ...waited,
      appServer: this.appServerClient.describe(),
    };
  }

  async listThreads({
    limit = 50,
    cursor = undefined,
    searchTerm = undefined,
    cwd = undefined,
  }) {
    const canonicalCwd = cwd ? await this.pathPolicy.resolveCwd(cwd) : undefined;
    const result = await this.appServerClient.request(
      "thread/list",
      compactObject({
        limit,
        cursor,
        searchTerm,
        cwd: canonicalCwd,
        sortKey: "updated_at",
        sortDirection: "desc",
      }),
    );

    const visible = [];
    for (const thread of result?.data ?? []) {
      const threadId = thread?.id;
      try {
        await this.#authorizeThreadObject(thread, threadId);
        visible.push(thread);
      } catch (error) {
        if (
          !(error instanceof AppServerError) &&
          !(error instanceof SecurityError) &&
          !(error instanceof ValidationError)
        ) {
          throw error;
        }
      }
    }

    return {
      data: visible,
      nextCursor: result?.nextCursor ?? null,
      filteredCount: (result?.data?.length ?? 0) - visible.length,
      allowedRoots: this.pathPolicy.describe(),
    };
  }

  async readThread({ threadId, includeTurns = false }) {
    const result = await this.appServerClient.request("thread/read", {
      threadId,
      includeTurns,
    });
    await this.#authorizeThreadObject(result?.thread, threadId);
    return {
      thread: result?.thread ?? null,
    };
  }

  async listPendingRequests({ threadId = undefined } = {}) {
    const authorized = new Set();
    if (threadId) {
      await this.#ensureAuthorizedThread(threadId);
      authorized.add(threadId);
    }

    const requests = [];
    for (const request of this.eventStore.getPendingRequests(threadId)) {
      if (!request.threadId) {
        continue;
      }
      if (!authorized.has(request.threadId)) {
        try {
          await this.#ensureAuthorizedThread(request.threadId);
          authorized.add(request.threadId);
        } catch (error) {
          if (
            error instanceof AppServerError ||
            error instanceof SecurityError ||
            error instanceof ValidationError
          ) {
            continue;
          }
          throw error;
        }
      }
      requests.push(request);
    }

    return {
      requests,
      count: requests.length,
    };
  }

  async resolveApproval({ requestKey, decision }) {
    return await this.#withMutationLock(`approval:${requestKey}`, async () => {
      const request = this.eventStore.getPendingRequest(requestKey);
      if (!request) {
        throw new ValidationError(`No pending request exists for requestKey "${requestKey}".`);
      }
      if (!APPROVAL_METHODS.has(request.method)) {
        throw new SecurityError(
          `Request ${requestKey} uses unsupported method ${request.method}; it cannot be answered by codex_resolve_approval.`,
        );
      }
      if (!request.threadId) {
        throw new SecurityError(`Request ${requestKey} has no thread id and cannot be authorized.`);
      }

      return await this.#withMutationLock(`thread:${request.threadId}`, async () => {
        await this.#ensureAuthorizedThread(request.threadId, { forExecution: true });

        const currentRequest = this.eventStore.getPendingRequest(requestKey);
        if (currentRequest !== request) {
          throw new ValidationError(`No pending request exists for requestKey "${requestKey}".`);
        }

        const available = request.params?.availableDecisions;
        let effectiveDecision = decision;
        if (Array.isArray(available) && available.length > 0 && !available.includes(decision)) {
          if (decision === "decline" && available.includes("cancel")) {
            effectiveDecision = "cancel";
          } else {
            throw new ValidationError(
              `Decision "${decision}" is unavailable. Allowed decisions: ${available.join(", ")}.`,
            );
          }
        }

        await this.appServerClient.resolveServerRequest(requestKey, {
          decision: effectiveDecision,
        });
        return {
          requestKey,
          method: request.method,
          threadId: request.threadId,
          turnId: request.turnId,
          decision,
          requestedDecision: decision,
          effectiveDecision,
          resolved: true,
          eventCursor: this.eventStore.sequence,
        };
      });
    });
  }

  async close() {
    await this.appServerClient.stop();
  }

  async #ensureAuthorizedThread(
    threadId,
    { forExecution = false, includeTurns = false } = {},
  ) {
    const result = await this.appServerClient.request("thread/read", {
      threadId,
      includeTurns,
    });
    const cwd = await this.#authorizeThreadObject(result?.thread, threadId, {
      forExecution,
    });
    return {
      cwd,
      thread: result?.thread ?? null,
    };
  }

  async #authorizeThreadObject(thread, expectedThreadId, { forExecution = false } = {}) {
    if (!expectedThreadId || !thread || thread.id !== expectedThreadId) {
      if (expectedThreadId) {
        this.authorizedThreads.delete(expectedThreadId);
      }
      throw new AppServerError(`Codex returned no matching thread for ${expectedThreadId}.`);
    }

    const threadCwd = extractThreadCwd(thread);
    if (!threadCwd) {
      this.authorizedThreads.delete(expectedThreadId);
      throw new SecurityError(
        `Thread ${expectedThreadId} has no cwd metadata, so its repository boundary cannot be verified.`,
      );
    }

    try {
      const canonicalCwd = await this.pathPolicy.resolveStoredPath(threadCwd, {
        mustExist: forExecution,
      });
      this.authorizedThreads.set(expectedThreadId, canonicalCwd);
      return canonicalCwd;
    } catch (error) {
      this.authorizedThreads.delete(expectedThreadId);
      throw error;
    }
  }

  async #withMutationLock(key, operation) {
    const previous = this.mutationLocks.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    this.mutationLocks.set(key, current);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.mutationLocks.get(key) === current) {
        this.mutationLocks.delete(key);
      }
    }
  }

  #assertNetworkAllowed(networkAccess) {
    if (networkAccess && process.env.CODEX_ALLOW_NETWORK !== "1") {
      throw new SecurityError(
        "Network access is disabled. Set CODEX_ALLOW_NETWORK=1 on the MCP server to permit it.",
      );
    }
  }
}
