import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EventStore } from "../src/event-store.mjs";
import { PathPolicy } from "../src/security.mjs";
import { CodexSupervisorService } from "../src/supervisor-service.mjs";

class RecordingClient {
  constructor(eventStore) {
    this.eventStore = eventStore;
    this.loadedThreads = new Set();
    this.calls = [];
    this.nextThread = 1;
    this.nextTurn = 1;
  }

  async request(method, params = {}) {
    this.calls.push({ method, params });

    if (method === "thread/start") {
      const id = `thread-${this.nextThread++}`;
      this.loadedThreads.add(id);
      return {
        thread: {
          id,
          cwd: params.cwd,
          status: { type: "idle" },
        },
        instructionSources: [],
      };
    }

    if (method === "turn/start") {
      const turn = {
        id: `turn-${this.nextTurn++}`,
        status: "inProgress",
        items: [],
        error: null,
      };
      this.eventStore.recordTurnStart(params.threadId, turn);
      return { turn };
    }

    if (method === "thread/read") {
      return {
        thread: {
          id: params.threadId,
          cwd: this.threadCwd,
          status: { type: "idle" },
        },
      };
    }

    if (method === "thread/turns/list") {
      return { data: [], nextCursor: null, backwardsCursor: null };
    }

    if (method === "thread/items/list") {
      throw new Error("thread/items/list is not supported yet");
    }

    throw new Error(`Unexpected method: ${method}`);
  }

  describe() {
    return { state: "ready" };
  }

  async stop() {}
}

class MutableThreadClient {
  constructor(eventStore, thread) {
    this.eventStore = eventStore;
    this.thread = thread;
    this.loadedThreads = new Set([thread.id]);
    this.calls = [];
    this.turnStartCalls = 0;
    this.approvalResolutionCalls = 0;
    this.approvalResults = [];
  }

  async request(method, params = {}) {
    this.calls.push({ method, params });
    if (method === "thread/read") {
      return { thread: { ...this.thread, id: params.threadId } };
    }
    if (method === "thread/list") {
      return { data: [{ ...this.thread }], nextCursor: null };
    }
    if (method === "turn/start") {
      this.turnStartCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      const turn = { id: `turn-${this.turnStartCalls}`, status: "inProgress" };
      this.eventStore.recordTurnStart(params.threadId, turn);
      return { turn };
    }
    throw new Error(`Unexpected method: ${method}`);
  }

  async resolveServerRequest(requestKey, result) {
    this.approvalResolutionCalls += 1;
    this.approvalResults.push(result);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const request = this.eventStore.removePendingRequest(requestKey);
    if (!request) {
      throw new Error("request was already resolved");
    }
    return { request, result };
  }

  describe() {
    return { state: "ready" };
  }

  async stop() {}
}

class RestartedSteerClient {
  constructor(thread) {
    this.thread = thread;
    this.loadedThreads = new Set();
    this.calls = [];
  }

  async request(method, params = {}) {
    this.calls.push({ method, params });
    if (method === "thread/read") {
      return { thread: { ...this.thread, id: params.threadId } };
    }
    if (method === "thread/resume") {
      this.loadedThreads.add(params.threadId);
      return { thread: { ...this.thread, id: params.threadId } };
    }
    if (method === "turn/steer") {
      if (!this.loadedThreads.has(params.threadId)) {
        throw new Error("thread not found");
      }
      return { turnId: params.expectedTurnId };
    }
    throw new Error(`Unexpected method: ${method}`);
  }

  describe() {
    return { state: "ready" };
  }

  async stop() {}
}

test("steer resumes a persisted thread after the app-server restarts", async (t) => {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), "codex-supervisor-steer-"));
  t.after(async () => {
    await fs.rm(repository, { recursive: true, force: true });
  });

  const canonicalRepository = await fs.realpath(repository);
  const pathPolicy = await PathPolicy.create({ allowedRoots: [repository] });
  const client = new RestartedSteerClient({
    id: "thread-persisted",
    cwd: canonicalRepository,
    status: { type: "active" },
  });
  const service = new CodexSupervisorService({
    pathPolicy,
    eventStore: new EventStore(),
    appServerClient: client,
  });

  const result = await service.steer({
    threadId: "thread-persisted",
    expectedTurnId: "turn-active",
    prompt: "continue",
  });

  assert.equal(result.turnId, "turn-active");
  assert.deepEqual(client.calls.map((call) => call.method), [
    "thread/read",
    "thread/resume",
    "turn/steer",
  ]);
  assert.equal(client.calls[1].params.cwd, canonicalRepository);
});

test("CodexSupervisorService emits current app-server sandbox policies", async (t) => {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), "codex-supervisor-service-"));
  t.after(async () => {
    await fs.rm(repository, { recursive: true, force: true });
  });

  const canonicalRepository = await fs.realpath(repository);
  const pathPolicy = await PathPolicy.create({ allowedRoots: [repository] });
  const eventStore = new EventStore();
  const client = new RecordingClient(eventStore);
  const service = new CodexSupervisorService({
    pathPolicy,
    eventStore,
    appServerClient: client,
  });

  const workspaceTask = await service.startTask({
    cwd: repository,
    prompt: "change a file",
    sandboxMode: "workspaceWrite",
  });
  client.threadCwd = canonicalRepository;
  assert.match(workspaceTask.threadId, /^thread-/);
  assert.equal(workspaceTask.safety.approvalPolicy, "on-request");

  const workspaceThread = client.calls.find(
    (call) =>
      call.method === "thread/start" &&
      call.params.cwd === canonicalRepository,
  );
  assert.equal(workspaceThread.params.approvalPolicy, "on-request");

  const workspaceTurn = client.calls.find(
    (call) =>
      call.method === "turn/start" &&
      call.params.threadId === workspaceTask.threadId,
  );
  assert.deepEqual(workspaceTurn.params.sandboxPolicy, {
    type: "workspaceWrite",
    writableRoots: [canonicalRepository],
    networkAccess: false,
  });
  assert.equal("readOnlyAccess" in workspaceTurn.params.sandboxPolicy, false);

  const readOnlyTask = await service.startTask({
    cwd: repository,
    prompt: "inspect only",
    sandboxMode: "readOnly",
    approvalPolicy: "unlessTrusted",
  });
  assert.equal(readOnlyTask.safety.approvalPolicy, "untrusted");
  const readOnlyTurn = client.calls.find(
    (call) =>
      call.method === "turn/start" &&
      call.params.threadId === readOnlyTask.threadId,
  );
  assert.equal(readOnlyTurn.params.approvalPolicy, "untrusted");
  assert.deepEqual(readOnlyTurn.params.sandboxPolicy, {
    type: "readOnly",
  });
  assert.equal("access" in readOnlyTurn.params.sandboxPolicy, false);

  await assert.rejects(
    () =>
      service.startTask({
        cwd: repository,
        prompt: "use the network",
        networkAccess: true,
      }),
    /Network access is disabled/,
  );

  await service.readThread({ threadId: workspaceTask.threadId });
  assert.deepEqual(client.calls.at(-1), {
    method: "thread/read",
    params: { threadId: workspaceTask.threadId, includeTurns: false },
  });
  await service.readThread({ threadId: workspaceTask.threadId, includeTurns: true });
  assert.equal(
    client.calls.some(
      (call) => call.method === "thread/read" && call.params.includeTurns === true,
    ),
    false,
  );
  assert.equal(
    client.calls.some((call) => call.method === "thread/turns/list"),
    true,
  );
  assert.equal(client.calls.at(-1).method, "thread/turns/list");
  assert.equal(
    client.calls.some((call) => call.method === "thread/items/list"),
    false,
  );
});

test("same-thread turns and approval resolutions are serialized", async (t) => {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), "codex-supervisor-locks-"));
  t.after(async () => {
    await fs.rm(repository, { recursive: true, force: true });
  });

  const canonicalRepository = await fs.realpath(repository);
  const eventStore = new EventStore();
  const pathPolicy = await PathPolicy.create({ allowedRoots: [repository] });
  const client = new MutableThreadClient(eventStore, {
    id: "thread-locked",
    cwd: canonicalRepository,
    status: { type: "idle" },
  });
  const service = new CodexSupervisorService({
    pathPolicy,
    eventStore,
    appServerClient: client,
  });

  const sends = await Promise.allSettled([
    service.send({ threadId: "thread-locked", prompt: "first" }),
    service.send({ threadId: "thread-locked", prompt: "second" }),
  ]);
  assert.equal(sends.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(sends.filter((result) => result.status === "rejected").length, 1);
  assert.match(sends.find((result) => result.status === "rejected").reason.message, /active turn/);
  assert.equal(client.turnStartCalls, 1);

  eventStore.addPendingRequest({
    id: "approval-locked",
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-locked",
      turnId: eventStore.getActiveTurnId("thread-locked"),
      availableDecisions: ["accept", "decline"],
    },
  });
  const requestKey = eventStore.getPendingRequests("thread-locked")[0].requestKey;
  const resolutions = await Promise.allSettled([
    service.resolveApproval({ requestKey, decision: "accept" }),
    service.resolveApproval({ requestKey, decision: "decline" }),
  ]);
  assert.equal(resolutions.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(resolutions.filter((result) => result.status === "rejected").length, 1);
  assert.match(
    resolutions.find((result) => result.status === "rejected").reason.message,
    /No pending request/,
  );
  assert.equal(client.approvalResolutionCalls, 1);
});

test("decline safely maps to cancel when the app-server omits decline", async (t) => {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), "codex-supervisor-decline-"));
  t.after(async () => {
    await fs.rm(repository, { recursive: true, force: true });
  });

  const eventStore = new EventStore();
  const pathPolicy = await PathPolicy.create({ allowedRoots: [repository] });
  const client = new MutableThreadClient(eventStore, {
    id: "thread-decline",
    cwd: await fs.realpath(repository),
    status: { type: "active" },
  });
  const service = new CodexSupervisorService({
    pathPolicy,
    eventStore,
    appServerClient: client,
  });
  eventStore.recordTurnStart("thread-decline", { id: "turn-decline" });
  eventStore.addPendingRequest({
    id: "approval-decline",
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-decline",
      turnId: "turn-decline",
      availableDecisions: ["accept", "acceptWithExecpolicyAmendment", "cancel"],
    },
  });
  const requestKey = eventStore.getPendingRequests("thread-decline")[0].requestKey;

  const resolved = await service.resolveApproval({ requestKey, decision: "decline" });
  assert.equal(resolved.decision, "decline");
  assert.equal(resolved.requestedDecision, "decline");
  assert.equal(resolved.effectiveDecision, "cancel");
  assert.deepEqual(client.approvalResults, [{ decision: "cancel" }]);
});

test("thread authorization is revalidated for execution, list, and read operations", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-supervisor-revalidate-"));
  const repository = path.join(root, "repository");
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "codex-supervisor-outside-"));
  await fs.mkdir(repository);
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  const eventStore = new EventStore();
  const pathPolicy = await PathPolicy.create({ allowedRoots: [root] });
  const client = new MutableThreadClient(eventStore, {
    id: "thread-revalidated",
    cwd: await fs.realpath(repository),
    status: { type: "idle" },
  });
  const service = new CodexSupervisorService({
    pathPolicy,
    eventStore,
    appServerClient: client,
  });

  await service.readThread({ threadId: "thread-revalidated" });
  client.thread.cwd = await fs.realpath(outside);
  await assert.rejects(
    () => service.readThread({ threadId: "thread-revalidated" }),
    /outside CODEX_ALLOWED_ROOTS/,
  );
  const listed = await service.listThreads({});
  assert.deepEqual(listed.data, []);
  assert.equal(listed.filteredCount, 1);

  client.thread.cwd = repository;
  await fs.rm(repository, { recursive: true });
  await assert.rejects(
    () => service.send({ threadId: "thread-revalidated", prompt: "must not run" }),
    /Stored cwd does not exist/,
  );
  assert.equal(client.turnStartCalls, 0);
});
