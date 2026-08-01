const DEFAULT_EVENT_LIMIT = 1_000;
const MAX_STORED_VALUE_BYTES = 96 * 1024;
const MAX_ACCUMULATED_TEXT = 200_000;

export function rpcIdKey(id) {
  return `${typeof id}:${JSON.stringify(id)}`;
}

function boundedValue(value, maxBytes = MAX_STORED_VALUE_BYTES) {
  try {
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded, "utf8") <= maxBytes) {
      return JSON.parse(encoded);
    }

    return {
      truncated: true,
      originalBytes: Buffer.byteLength(encoded, "utf8"),
      preview: encoded.slice(0, maxBytes),
    };
  } catch {
    return {
      truncated: true,
      preview: String(value).slice(0, maxBytes),
    };
  }
}

function appendBounded(current, delta) {
  const combined = `${current ?? ""}${delta ?? ""}`;
  if (combined.length <= MAX_ACCUMULATED_TEXT) {
    return combined;
  }
  return combined.slice(combined.length - MAX_ACCUMULATED_TEXT);
}

function extractTurnId(params) {
  return params?.turnId ?? params?.turn?.id ?? params?.item?.turnId ?? null;
}

function extractThreadId(params, turnThreads) {
  const direct =
    params?.threadId ??
    params?.thread?.id ??
    params?.turn?.threadId ??
    params?.item?.threadId ??
    null;
  if (direct) {
    return direct;
  }

  const turnId = extractTurnId(params);
  return turnId ? turnThreads.get(turnId) ?? null : null;
}

function isTerminalEvent(event) {
  return (
    event.method === "turn/completed" ||
    event.method === "error" ||
    event.kind === "server_request"
  );
}

function stopReason(events) {
  const lastStop = [...events].reverse().find(isTerminalEvent);
  if (!lastStop) {
    return null;
  }
  if (lastStop.kind === "server_request") {
    return "request";
  }
  if (lastStop.method === "error") {
    return "error";
  }
  return "completed";
}

export class EventStore {
  constructor({ eventLimit = Number(process.env.CODEX_EVENT_LIMIT) || DEFAULT_EVENT_LIMIT } = {}) {
    this.eventLimit = Math.max(100, Math.min(eventLimit, 10_000));
    this.sequence = 0;
    this.events = [];
    this.activeTurns = new Map();
    this.turnThreads = new Map();
    this.threadStatuses = new Map();
    this.latestDiffs = new Map();
    this.latestAgentMessages = new Map();
    this.latestErrors = new Map();
    this.pendingRequests = new Map();
    this.waiters = new Set();
  }

  recordTurnStart(threadId, turn) {
    if (!threadId || !turn?.id) {
      return;
    }
    this.turnThreads.set(turn.id, threadId);
    this.activeTurns.set(threadId, turn.id);
  }

  recordProcessFailure(error) {
    const affectedTurns = new Map(this.activeTurns);
    for (const request of this.pendingRequests.values()) {
      if (request.threadId && !affectedTurns.has(request.threadId)) {
        affectedTurns.set(request.threadId, request.turnId ?? null);
      }
    }

    this.pendingRequests.clear();
    this.activeTurns.clear();
    this.turnThreads.clear();

    const failure = {
      type: error?.name ?? "AppServerError",
      message: error?.message ?? String(error),
      source: "app-server-process",
    };
    for (const [threadId, turnId] of affectedTurns) {
      this.threadStatuses.set(threadId, { type: "error" });
      this.record(
        "error",
        {
          threadId,
          ...(turnId ? { turnId } : {}),
          error: failure,
        },
        { kind: "lifecycle" },
      );
    }

    return affectedTurns.size;
  }

  record(method, params = {}, { kind = "notification", requestId = undefined } = {}) {
    const turnId = extractTurnId(params);
    let threadId = extractThreadId(params, this.turnThreads);

    if (method === "thread/started" && params?.thread?.id) {
      threadId = params.thread.id;
    }

    if (threadId && turnId) {
      this.turnThreads.set(turnId, threadId);
    }

    if (method === "turn/started" && threadId && turnId) {
      this.activeTurns.set(threadId, turnId);
    } else if (method === "turn/completed" && threadId) {
      const activeTurnId = this.activeTurns.get(threadId);
      if (!turnId || !activeTurnId || activeTurnId === turnId) {
        this.activeTurns.delete(threadId);
      }
    }

    if (method === "thread/status/changed" && threadId) {
      this.threadStatuses.set(threadId, boundedValue(params?.status ?? params));
    }

    if (method === "turn/diff/updated" && threadId) {
      this.latestDiffs.set(threadId, boundedValue(params?.diff ?? params));
    }

    if (method === "item/agentMessage/delta" && threadId && typeof params?.delta === "string") {
      this.latestAgentMessages.set(
        threadId,
        appendBounded(this.latestAgentMessages.get(threadId), params.delta),
      );
    }

    if (
      method === "item/completed" &&
      threadId &&
      params?.item?.type === "agentMessage" &&
      typeof params.item.text === "string"
    ) {
      this.latestAgentMessages.set(threadId, params.item.text.slice(-MAX_ACCUMULATED_TEXT));
    }

    if (method === "error" && threadId) {
      this.latestErrors.set(threadId, boundedValue(params?.error ?? params));
    }

    if (method === "serverRequest/resolved" && params?.requestId !== undefined) {
      this.pendingRequests.delete(rpcIdKey(params.requestId));
    }

    const event = {
      sequence: ++this.sequence,
      receivedAt: new Date().toISOString(),
      kind,
      method,
      threadId,
      turnId,
      params: boundedValue(params),
    };

    if (requestId !== undefined) {
      event.requestKey = rpcIdKey(requestId);
    }

    this.events.push(event);
    if (this.events.length > this.eventLimit) {
      this.events.splice(0, this.events.length - this.eventLimit);
    }

    this.#notifyWaiters(event);
    return event;
  }

  addPendingRequest(message) {
    const requestKey = rpcIdKey(message.id);
    const params = message.params ?? {};
    const turnId = extractTurnId(params);
    const threadId = extractThreadId(params, this.turnThreads);
    const request = {
      requestKey,
      requestId: message.id,
      method: message.method,
      threadId,
      turnId,
      receivedAt: new Date().toISOString(),
      params: boundedValue(params),
    };
    this.pendingRequests.set(requestKey, request);

    const event = this.record(message.method, params, {
      kind: "server_request",
      requestId: message.id,
    });
    request.threadId = event.threadId;
    request.turnId = event.turnId;
    request.receivedAt = event.receivedAt;
    return request;
  }

  getPendingRequest(requestKey) {
    return this.pendingRequests.get(requestKey) ?? null;
  }

  removePendingRequest(requestKey) {
    const request = this.pendingRequests.get(requestKey) ?? null;
    this.pendingRequests.delete(requestKey);
    return request;
  }

  getPendingRequests(threadId = undefined) {
    return [...this.pendingRequests.values()]
      .filter((request) => threadId === undefined || request.threadId === threadId)
      .sort((left, right) => left.receivedAt.localeCompare(right.receivedAt));
  }

  getEvents(threadId, afterSequence = 0, maxEvents = 50) {
    const matching = this.events.filter(
      (event) =>
        event.sequence > afterSequence &&
        event.threadId === threadId,
    );
    return matching.length > maxEvents ? matching.slice(-maxEvents) : matching;
  }

  getActiveTurnId(threadId) {
    return this.activeTurns.get(threadId) ?? null;
  }

  getSnapshot(threadId, { afterSequence = 0, maxEvents = 50 } = {}) {
    const events = this.getEvents(threadId, afterSequence, maxEvents);
    const eventCursor = events.length > 0 ? events.at(-1).sequence : Math.max(afterSequence, this.sequence);
    return {
      threadId,
      activeTurnId: this.getActiveTurnId(threadId),
      status: this.threadStatuses.get(threadId) ?? null,
      latestAgentMessage: this.latestAgentMessages.get(threadId) ?? "",
      latestDiff: this.latestDiffs.get(threadId) ?? null,
      latestError: this.latestErrors.get(threadId) ?? null,
      pendingRequests: this.getPendingRequests(threadId),
      events,
      eventCursor,
    };
  }

  async waitFor(threadId, { afterSequence = 0, maxEvents = 100, timeoutMs = 30_000, signal } = {}) {
    const initial = this.getEvents(threadId, afterSequence, maxEvents);
    const initialReason = stopReason(initial);
    if (initialReason) {
      return {
        reason: initialReason,
        ...this.getSnapshot(threadId, { afterSequence, maxEvents }),
      };
    }

    if (!this.getActiveTurnId(threadId)) {
      return {
        reason: "idle",
        ...this.getSnapshot(threadId, { afterSequence, maxEvents }),
      };
    }

    return await new Promise((resolve, reject) => {
      const waiter = {
        threadId,
        afterSequence,
        maxEvents,
        resolve: (reason) => {
          cleanup();
          resolve({
            reason,
            ...this.getSnapshot(threadId, { afterSequence, maxEvents }),
          });
        },
      };

      const cleanup = () => {
        clearTimeout(timer);
        this.waiters.delete(waiter);
        signal?.removeEventListener("abort", onAbort);
      };

      const onAbort = () => {
        cleanup();
        const error = new Error("The wait operation was cancelled.");
        error.name = "AbortError";
        reject(error);
      };

      const timer = setTimeout(() => waiter.resolve("timeout"), timeoutMs);
      timer.unref?.();
      this.waiters.add(waiter);

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  #notifyWaiters(event) {
    if (!isTerminalEvent(event)) {
      return;
    }

    for (const waiter of [...this.waiters]) {
      if (
        event.sequence > waiter.afterSequence &&
        event.threadId === waiter.threadId
      ) {
        waiter.resolve(
          event.kind === "server_request"
            ? "request"
            : event.method === "error"
              ? "error"
              : "completed",
        );
      }
    }
  }
}
