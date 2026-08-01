import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EventStore } from "../src/event-store.mjs";
import { PathPolicy } from "../src/security.mjs";
import { CodexSupervisorService } from "../src/supervisor-service.mjs";
import { MAX_RECONCILED_AGENT_TEXT } from "../src/thread-transcript.mjs";

const SNAPSHOT_38 =
  "Development snapshot: 38 tests pass and browser integration is incomplete.";
const COMPLETION_43 =
  "Local development takeover is complete. All 43 tests pass.";

function agentItem(id, text, extra = {}) {
  return {
    type: "agentMessage",
    id,
    text,
    phase: "final_answer",
    memoryCitation: null,
    ...extra,
  };
}

function completedTurn(id, text, { itemId = `item-${id}`, items = undefined } = {}) {
  return {
    id,
    status: "completed",
    startedAt: null,
    completedAt: null,
    durationMs: null,
    items: items ?? [agentItem(itemId, text)],
    error: null,
  };
}

function recordLiveCompletion(store, threadId, turnId, text) {
  store.recordTurnStart(threadId, { id: turnId, status: "inProgress" });
  store.record("item/completed", {
    threadId,
    turnId,
    item: agentItem(`live-${turnId}`, text),
  });
  store.record("turn/completed", {
    threadId,
    turn: {
      id: turnId,
      status: "completed",
      items: [],
      error: null,
    },
  });
  store.record("thread/status/changed", {
    threadId,
    status: { type: "idle" },
  });
}

function latestFixtureCompletion(thread) {
  for (let turnIndex = (thread.turns?.length ?? 0) - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = thread.turns[turnIndex];
    if (turn?.status !== "completed") {
      continue;
    }
    for (let itemIndex = (turn.items?.length ?? 0) - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = turn.items[itemIndex];
      if (item?.type === "agentMessage" && typeof item.text === "string") {
        return { text: item.text, turnId: turn.id, itemId: item.id };
      }
    }
  }
  return null;
}

class PersistedThreadClient {
  constructor(eventStore, thread) {
    this.eventStore = eventStore;
    this.thread = thread;
    this.loadedThreads = new Set([thread.id]);
    this.calls = [];
  }

  async request(method, params = {}) {
    this.calls.push({ method, params: structuredClone(params) });
    if (method !== "thread/read") {
      throw new Error(`Unexpected method: ${method}`);
    }

    const thread = structuredClone(this.thread);
    if (!params.includeTurns) {
      delete thread.turns;
    }
    return { thread };
  }

  describe() {
    return { state: "ready" };
  }

  async stop() {}
}

async function createHarness(t, { eventStore = new EventStore(), thread = undefined } = {}) {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), "codex-status-reconcile-"));
  t.after(async () => {
    await fs.rm(repository, { recursive: true, force: true });
  });

  const cwd = await fs.realpath(repository);
  const persistedThread = thread ?? {
    id: "thread-status-reconcile",
    cwd,
    status: { type: "idle" },
    updatedAt: 100,
    turns: [completedTurn("turn-managed-38", SNAPSHOT_38)],
  };
  persistedThread.cwd = cwd;

  const client = new PersistedThreadClient(eventStore, persistedThread);
  const service = new CodexSupervisorService({
    pathPolicy: await PathPolicy.create({ allowedRoots: [repository] }),
    eventStore,
    appServerClient: client,
  });
  return { client, cwd, eventStore, repository, service, thread: persistedThread };
}

test("status reconciles a cache populated before a synthesized rollout is appended", async (t) => {
  const harness = await createHarness(t);
  const { client, eventStore, service, thread } = harness;
  recordLiveCompletion(eventStore, thread.id, "turn-managed-38", SNAPSHOT_38);

  const beforeSequence = eventStore.sequence;
  const before = await service.status({ threadId: thread.id });
  assert.equal(before.latestAgentMessage, SNAPSHOT_38);
  assert.equal("turns" in before.thread, false);
  assert.equal(eventStore.sequence, beforeSequence);
  assert.deepEqual(client.calls.at(-1), {
    method: "thread/read",
    params: { threadId: thread.id, includeTurns: true },
  });

  thread.turns.push(completedTurn("rollout-689", COMPLETION_43, { itemId: "item-44" }));
  thread.updatedAt = 101;

  const after = await service.status({ threadId: thread.id });
  assert.equal(after.latestAgentMessage, COMPLETION_43);
  assert.equal("turns" in after.thread, false);
  assert.equal(eventStore.sequence, beforeSequence);

  const read = await service.readThread({ threadId: thread.id, includeTurns: true });
  const persistedLatest = latestFixtureCompletion(read.thread);
  assert.deepEqual(persistedLatest, {
    text: COMPLETION_43,
    turnId: "rollout-689",
    itemId: "item-44",
  });
  assert.equal(after.latestAgentMessage, persistedLatest.text);

  const expanded = await service.status({ threadId: thread.id, includeTurns: true });
  assert.equal(expanded.thread.turns.at(-1).id, "rollout-689");
  assert.equal(expanded.latestAgentMessage, persistedLatest.text);
});

test("a fresh service and EventStore recover the latest persisted rollout after restart", async (t) => {
  const first = await createHarness(t);
  recordLiveCompletion(first.eventStore, first.thread.id, "turn-managed-38", SNAPSHOT_38);
  assert.equal((await first.service.status({ threadId: first.thread.id })).latestAgentMessage, SNAPSHOT_38);

  first.thread.turns.push(
    completedTurn("rollout-689", COMPLETION_43, { itemId: "item-44" }),
  );
  const persistedAcrossRestart = structuredClone(first.thread);

  const secondStore = new EventStore();
  const secondClient = new PersistedThreadClient(secondStore, persistedAcrossRestart);
  const secondService = new CodexSupervisorService({
    pathPolicy: await PathPolicy.create({ allowedRoots: [first.repository] }),
    eventStore: secondStore,
    appServerClient: secondClient,
  });

  const afterRestart = await secondService.status({ threadId: first.thread.id });
  assert.equal(afterRestart.latestAgentMessage, COMPLETION_43);
  assert.equal(afterRestart.activeTurnId, null);
  assert.deepEqual(afterRestart.status, { type: "idle" });
  assert.equal(secondStore.sequence, 0);
});

test("status invalidates same-count transcript state after a partial rollout becomes complete", async (t) => {
  const harness = await createHarness(t);
  const { service, thread } = harness;
  thread.turns.push(completedTurn("rollout-100", "Earlier synthesized completion."));
  thread.turns.push({
    id: "rollout-2",
    status: "inProgress",
    startedAt: null,
    completedAt: null,
    durationMs: null,
    items: [
      agentItem("item-earlier", "An earlier item in the same synthesized turn."),
      agentItem("item-partial", "Local development takeov"),
    ],
    error: null,
  });

  const unchangedUpdatedAt = thread.updatedAt;
  const unchangedTurnCount = thread.turns.length;
  assert.equal(
    (await service.status({ threadId: thread.id })).latestAgentMessage,
    "Earlier synthesized completion.",
  );

  const mutableTail = thread.turns.at(-1);
  mutableTail.status = "completed";
  mutableTail.items[1].text = COMPLETION_43;

  assert.equal(thread.updatedAt, unchangedUpdatedAt);
  assert.equal(thread.turns.length, unchangedTurnCount);
  assert.equal((await service.status({ threadId: thread.id })).latestAgentMessage, COMPLETION_43);
});

test("status ignores malformed, partial, and interrupted persisted tails", async (t) => {
  const harness = await createHarness(t);
  const { service, thread } = harness;
  thread.turns.push(completedTurn("rollout-complete", COMPLETION_43));
  thread.turns.push({
    id: "rollout-interrupted",
    status: "interrupted",
    items: [agentItem("item-interrupted", "INTERRUPTED PARTIAL")],
    error: null,
  });
  thread.turns.push({
    id: "rollout-malformed",
    status: "completed",
    items: [agentItem("item-malformed", { corrupt: true })],
    error: null,
  });
  thread.turns.push({
    id: "rollout-partial",
    status: "inProgress",
    items: [agentItem("item-partial", "TRUNCATED FINAL RES")],
    error: null,
  });

  const status = await service.status({ threadId: thread.id });
  assert.equal(status.latestAgentMessage, COMPLETION_43);
});

test("terminal live partials are never returned when no persisted completion exists", async (t) => {
  const thread = {
    id: "thread-only-partials",
    status: { type: "idle" },
    updatedAt: 250,
    turns: [],
  };
  const { eventStore, service } = await createHarness(t, { thread });

  eventStore.recordTurnStart(thread.id, {
    id: "turn-interrupted-only",
    status: "inProgress",
  });
  eventStore.record("item/agentMessage/delta", {
    threadId: thread.id,
    turnId: "turn-interrupted-only",
    itemId: "item-partial-only",
    delta: "CORRUPTED TERMINAL PARTIAL",
  });
  eventStore.record("turn/completed", {
    threadId: thread.id,
    turn: {
      id: "turn-interrupted-only",
      status: "interrupted",
      items: [],
      error: null,
    },
  });

  const interrupted = await service.status({ threadId: thread.id });
  assert.equal(interrupted.activeTurnId, null);
  assert.equal(interrupted.latestAgentMessage, "");

  eventStore.recordTurnStart(thread.id, {
    id: "turn-commentary-only",
    status: "inProgress",
  });
  eventStore.record("item/completed", {
    threadId: thread.id,
    turnId: "turn-commentary-only",
    item: agentItem("item-commentary-only", "TERMINAL COMMENTARY", {
      phase: "commentary",
    }),
  });
  eventStore.record("turn/completed", {
    threadId: thread.id,
    turn: {
      id: "turn-commentary-only",
      status: "completed",
      items: [],
      error: null,
    },
  });

  const commentary = await service.status({ threadId: thread.id });
  assert.equal(commentary.activeTurnId, null);
  assert.equal(commentary.latestAgentMessage, "");
});

test("status preserves live precedence and control state while reconciling persisted turns", async (t) => {
  const harness = await createHarness(t);
  const { eventStore, service, thread } = harness;
  recordLiveCompletion(eventStore, thread.id, "turn-managed-38", SNAPSHOT_38);
  eventStore.record("error", {
    threadId: thread.id,
    error: { type: "EarlierError", message: "retained diagnostic" },
  });
  eventStore.recordTurnStart(thread.id, { id: "turn-live", status: "inProgress" });
  eventStore.record("item/agentMessage/delta", {
    threadId: thread.id,
    turnId: "turn-live",
    itemId: "item-live",
    delta: "Current live progress",
  });
  eventStore.record("turn/diff/updated", {
    threadId: thread.id,
    turnId: "turn-live",
    diff: "diff --git a/file b/file\n+live\n",
  });
  eventStore.addPendingRequest({
    id: "approval-live",
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: thread.id,
      turnId: "turn-live",
      availableDecisions: ["accept", "cancel"],
    },
  });

  const sequenceBeforeStatus = eventStore.sequence;
  const active = await service.status({ threadId: thread.id });
  assert.equal(active.activeTurnId, "turn-live");
  assert.equal(active.latestAgentMessage, "Current live progress");
  assert.equal(active.pendingRequests.length, 1);
  assert.match(active.latestDiff.preview ?? active.latestDiff, /\+live/);
  assert.equal(active.latestError.message, "retained diagnostic");
  assert.equal(active.eventCursor, sequenceBeforeStatus);
  assert.equal(eventStore.sequence, sequenceBeforeStatus);

  eventStore.removePendingRequest(active.pendingRequests[0].requestKey);
  eventStore.record("item/completed", {
    threadId: thread.id,
    turnId: "turn-live",
    item: agentItem("item-live", "New live completion not persisted yet."),
  });
  eventStore.record("turn/completed", {
    threadId: thread.id,
    turn: { id: "turn-live", status: "completed", items: [], error: null },
  });
  const terminal = await service.status({ threadId: thread.id });
  assert.equal(terminal.latestAgentMessage, "New live completion not persisted yet.");

  thread.turns.push(completedTurn("rollout-689", COMPLETION_43, { itemId: "item-44" }));
  eventStore.recordTurnStart(thread.id, { id: "turn-commentary", status: "inProgress" });
  eventStore.record("item/completed", {
    threadId: thread.id,
    turnId: "turn-commentary",
    item: agentItem("item-commentary", "TERMINAL COMMENTARY", {
      phase: "commentary",
    }),
  });
  eventStore.record("turn/completed", {
    threadId: thread.id,
    turn: { id: "turn-commentary", status: "interrupted", items: [], error: null },
  });
  assert.equal((await service.status({ threadId: thread.id })).latestAgentMessage, COMPLETION_43);

  eventStore.recordTurnStart(thread.id, { id: "turn-interrupted", status: "inProgress" });
  eventStore.record("item/agentMessage/delta", {
    threadId: thread.id,
    turnId: "turn-interrupted",
    itemId: "item-interrupted",
    delta: "CORRUPTED TERMINAL PARTIAL",
  });
  eventStore.record("turn/completed", {
    threadId: thread.id,
    turn: { id: "turn-interrupted", status: "interrupted", items: [], error: null },
  });
  const interrupted = await service.status({ threadId: thread.id });
  assert.equal(interrupted.activeTurnId, null);
  assert.equal(interrupted.latestAgentMessage, COMPLETION_43);

  thread.status = { type: "active" };
  thread.turns.push({
    id: "external-active-turn",
    status: "inProgress",
    items: [],
  });
  const externalActive = await service.status({ threadId: thread.id });
  assert.equal(externalActive.activeTurnId, null);
  assert.equal(externalActive.latestAgentMessage, COMPLETION_43);
  assert.deepEqual(externalActive.status, { type: "active" });
});

test("status bounds persisted responses and recognizes their bounded live representation", async (t) => {
  const hugeCompletion = `${"x".repeat(MAX_RECONCILED_AGENT_TEXT + 1_000)}FINAL`;
  const thread = {
    id: "thread-large-status",
    status: { type: "idle" },
    updatedAt: 400,
    turns: [
      completedTurn("turn-large", hugeCompletion),
      completedTurn("rollout-later", COMPLETION_43),
    ],
  };
  const harness = await createHarness(t, { thread });
  recordLiveCompletion(harness.eventStore, thread.id, "turn-large", hugeCompletion);

  const status = await harness.service.status({ threadId: thread.id });
  assert.equal(status.latestAgentMessage, COMPLETION_43);

  thread.turns.pop();
  const bounded = await harness.service.status({ threadId: thread.id });
  assert.equal(bounded.latestAgentMessage.length, MAX_RECONCILED_AGENT_TEXT);
  assert.equal(
    bounded.latestAgentMessage,
    hugeCompletion.slice(-MAX_RECONCILED_AGENT_TEXT),
  );
});

test("status reconciliation does not synthesize a terminal event or wake an ordinary wait", async (t) => {
  const harness = await createHarness(t);
  const { eventStore, service, thread } = harness;
  eventStore.recordTurnStart(thread.id, { id: "turn-wait", status: "inProgress" });
  const cursor = eventStore.sequence;
  let settled = false;
  const waiting = eventStore
    .waitFor(thread.id, { afterSequence: cursor, timeoutMs: 1_000 })
    .then((result) => {
      settled = true;
      return result;
    });

  const status = await service.status({ threadId: thread.id });
  await Promise.resolve();
  assert.equal(status.activeTurnId, "turn-wait");
  assert.equal(eventStore.sequence, cursor);
  assert.equal(settled, false);

  eventStore.record("item/completed", {
    threadId: thread.id,
    turnId: "turn-wait",
    item: agentItem("item-wait", "Ordinary wait completion."),
  });
  eventStore.record("turn/completed", {
    threadId: thread.id,
    turn: { id: "turn-wait", status: "completed", items: [], error: null },
  });
  const completed = await waiting;
  assert.equal(completed.reason, "completed");
  assert.equal(completed.latestAgentMessage, "Ordinary wait completion.");
});
