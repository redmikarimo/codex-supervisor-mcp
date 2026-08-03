#!/usr/bin/env node

import readline from "node:readline";

const APPROVAL_POLICIES = new Set(["untrusted", "on-request", "never"]);
const threads = new Map();
const pendingApprovals = new Map();
let nextThread = 1;
let nextTurn = 1;
let nextApproval = 1;
let initializeParams = null;

const reader = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function validateApprovalPolicy(message) {
  const approvalPolicy = message.params?.approvalPolicy;
  if (approvalPolicy === undefined || APPROVAL_POLICIES.has(approvalPolicy)) {
    return true;
  }

  send({
    id: message.id,
    error: {
      code: -32602,
      message:
        `unknown variant '${String(approvalPolicy)}', expected one of ` +
        "'untrusted', 'on-request', 'granular', 'never'",
    },
  });
  return false;
}

function validateSandboxPolicy(message) {
  const sandboxPolicy = message.params?.sandboxPolicy;
  if (!sandboxPolicy) {
    return true;
  }

  if (
    Object.prototype.hasOwnProperty.call(sandboxPolicy, "access") ||
    Object.prototype.hasOwnProperty.call(sandboxPolicy, "readOnlyAccess")
  ) {
    send({
      id: message.id,
      error: {
        code: -32602,
        message:
          "Invalid request: deprecated sandbox read-access fields are not supported; " +
          "use permissionProfile for restricted reads",
      },
    });
    return false;
  }

  return true;
}

function completeTurn(threadId, turnId, prompt) {
  send({
    method: "turn/diff/updated",
    params: {
      threadId,
      turnId,
      diff: `diff --git a/mock.txt b/mock.txt\n+${prompt}\n`,
    },
  });
  send({
    method: "item/completed",
    params: {
      threadId,
      turnId,
      item: {
        type: "agentMessage",
        id: `message-${turnId}`,
        text: `Completed: ${prompt}`,
      },
    },
  });
  send({
    method: "turn/completed",
    params: {
      threadId,
      turn: {
        id: turnId,
        status: "completed",
        items: [],
        error: null,
      },
    },
  });
  send({
    method: "thread/status/changed",
    params: {
      threadId,
      status: { type: "idle" },
    },
  });

  const thread = threads.get(threadId);
  if (thread) {
    thread.status = { type: "idle" };
    thread.updatedAt = Math.floor(Date.now() / 1000);
  }
}

function startTurn(message) {
  const { threadId, input = [] } = message.params;
  const thread = threads.get(threadId);
  if (!thread) {
    send({
      id: message.id,
      error: { code: -32000, message: `Unknown thread: ${threadId}` },
    });
    return;
  }

  const prompt = input.find((item) => item.type === "text")?.text ?? "";
  const turnId = `turn-${nextTurn++}`;
  thread.status = { type: "active", activeFlags: [] };
  thread.updatedAt = Math.floor(Date.now() / 1000);

  send({
    id: message.id,
    result: {
      turn: {
        id: turnId,
        status: "inProgress",
        items: [],
        error: null,
      },
    },
  });
  send({
    method: "turn/started",
    params: {
      threadId,
      turn: {
        id: turnId,
        status: "inProgress",
        items: [],
        error: null,
      },
    },
  });
  send({
    method: "thread/status/changed",
    params: {
      threadId,
      status: { type: "active", activeFlags: [] },
    },
  });
  send({
    method: "item/agentMessage/delta",
    params: {
      threadId,
      turnId,
      itemId: `message-${turnId}`,
      delta: `Working on: ${prompt}`,
    },
  });

  if (prompt.includes("approval")) {
    const approvalId = `approval-${nextApproval++}`;
    pendingApprovals.set(approvalId, { threadId, turnId, prompt });
    send({
      id: approvalId,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId,
        turnId,
        itemId: `command-${turnId}`,
        reason: "Mock command needs approval",
        command: ["node", "--version"],
        cwd: thread.cwd,
        availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
      },
    });
    return;
  }

  setTimeout(() => completeTurn(threadId, turnId, prompt), 10);
}

function handleRequest(message) {
  const { method, params = {} } = message;

  if (method === "initialize") {
    initializeParams = structuredClone(params);
    send({
      id: message.id,
      result: {
        userAgent: "mock-codex-app-server/1.0",
        platformFamily: process.platform,
        platformOs: process.platform,
      },
    });
    return;
  }

  if (method === "test/initializeParams") {
    send({ id: message.id, result: initializeParams });
    return;
  }

  if (method === "thread/start") {
    if (!validateApprovalPolicy(message)) {
      return;
    }

    const id = `thread-${nextThread++}`;
    const thread = {
      id,
      sessionId: id,
      cwd: params.cwd ?? process.cwd(),
      modelProvider: "mock",
      preview: "",
      ephemeral: false,
      createdAt: Math.floor(Date.now() / 1000),
      updatedAt: Math.floor(Date.now() / 1000),
      status: { type: "idle" },
      turns: [],
    };
    threads.set(id, thread);
    send({
      id: message.id,
      result: {
        thread,
        instructionSources: [],
      },
    });
    send({
      method: "thread/started",
      params: { thread },
    });
    return;
  }

  if (method === "thread/resume") {
    const thread = threads.get(params.threadId);
    if (!thread) {
      send({
        id: message.id,
        error: { code: -32000, message: `Unknown thread: ${params.threadId}` },
      });
      return;
    }
    send({ id: message.id, result: { thread, instructionSources: [] } });
    send({ method: "thread/started", params: { thread } });
    return;
  }

  if (method === "thread/read") {
    const thread = threads.get(params.threadId);
    if (!thread) {
      send({
        id: message.id,
        error: { code: -32000, message: `Unknown thread: ${params.threadId}` },
      });
      return;
    }
    send({
      id: message.id,
      result: {
        thread: {
          ...thread,
          ...(params.includeTurns ? { turns: thread.turns ?? [] } : { turns: undefined }),
        },
      },
    });
    return;
  }

  if (method === "thread/turns/list") {
    const thread = threads.get(params.threadId);
    if (!thread) {
      send({
        id: message.id,
        error: { code: -32000, message: `Unknown thread: ${params.threadId}` },
      });
      return;
    }
    const source = structuredClone(thread.turns ?? []);
    if (params.sortDirection === "desc") {
      source.reverse();
    }
    const anchor = /^anchor:(\d+)$/.exec(params.cursor ?? "");
    const offset = anchor
      ? Number.parseInt(anchor[1], 10)
      : Number.parseInt(params.cursor ?? "0", 10);
    const limit = params.limit ?? source.length;
    const data = source.slice(offset, offset + limit).map((turn) =>
      params.itemsView === "notLoaded" ? { ...turn, items: [] } : turn,
    );
    const nextOffset = offset + data.length;
    const originalIndex =
      params.sortDirection === "desc"
        ? source.length - 1 - offset
        : offset;
    send({
      id: message.id,
      result: {
        data,
        nextCursor: nextOffset < source.length ? String(nextOffset) : null,
        backwardsCursor: data.length > 0 ? `anchor:${originalIndex}` : null,
      },
    });
    return;
  }

  if (method === "thread/items/list") {
    send({
      id: message.id,
      error: { code: -32601, message: "thread/items/list is not supported yet" },
    });
    return;
  }

  if (method === "thread/list") {
    send({
      id: message.id,
      result: {
        data: [...threads.values()],
        nextCursor: null,
      },
    });
    return;
  }

  if (method === "turn/start") {
    if (!validateApprovalPolicy(message) || !validateSandboxPolicy(message)) {
      return;
    }

    startTurn(message);
    return;
  }

  if (method === "turn/steer") {
    send({
      id: message.id,
      result: { turnId: params.expectedTurnId },
    });
    send({
      method: "item/agentMessage/delta",
      params: {
        threadId: params.threadId,
        turnId: params.expectedTurnId,
        delta: `\nSteered: ${params.input?.[0]?.text ?? ""}`,
      },
    });
    return;
  }

  if (method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    send({
      method: "turn/completed",
      params: {
        threadId: params.threadId,
        turn: {
          id: params.turnId,
          status: "interrupted",
          items: [],
          error: null,
        },
      },
    });
    return;
  }

  send({
    id: message.id,
    error: { code: -32601, message: `Unknown method: ${method}` },
  });
}

reader.on("line", (line) => {
  if (!line.trim()) {
    return;
  }

  const message = JSON.parse(line);
  if (message.method) {
    if (Object.prototype.hasOwnProperty.call(message, "id")) {
      handleRequest(message);
    }
    return;
  }

  const pending = pendingApprovals.get(message.id);
  if (!pending) {
    return;
  }
  pendingApprovals.delete(message.id);

  send({
    method: "serverRequest/resolved",
    params: {
      threadId: pending.threadId,
      requestId: message.id,
    },
  });

  if (message.result?.decision === "accept" || message.result?.decision === "acceptForSession") {
    completeTurn(pending.threadId, pending.turnId, pending.prompt);
  } else {
    send({
      method: "item/completed",
      params: {
        threadId: pending.threadId,
        turnId: pending.turnId,
        item: {
          type: "commandExecution",
          id: `command-${pending.turnId}`,
          command: ["node", "--version"],
          cwd: threads.get(pending.threadId)?.cwd,
          status: "declined",
        },
      },
    });
    send({
      method: "turn/completed",
      params: {
        threadId: pending.threadId,
        turn: {
          id: pending.turnId,
          status: "completed",
          items: [],
          error: null,
        },
      },
    });
  }
});
