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

    throw new Error(`Unexpected method: ${method}`);
  }

  describe() {
    return { state: "ready" };
  }

  async stop() {}
}

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
  assert.deepEqual(client.calls.at(-1), {
    method: "thread/read",
    params: { threadId: workspaceTask.threadId, includeTurns: true },
  });
});
