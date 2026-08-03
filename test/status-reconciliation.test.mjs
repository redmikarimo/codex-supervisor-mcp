import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EventStore } from "../src/event-store.mjs";
import { PathPolicy } from "../src/security.mjs";
import { CodexSupervisorService } from "../src/supervisor-service.mjs";
import {
  boundStatusResult,
  MAX_THREAD_PAGE_BYTES,
  TOOL_RESULT_BYTE_BASIS,
} from "../src/thread-pagination.mjs";
import { MAX_RECONCILED_AGENT_TEXT } from "../src/thread-transcript.mjs";
import { measureToolResultEnvelopeBytes } from "../src/tool-result.mjs";

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

function completedTurn(
  id,
  text,
  {
    itemId = `item-${id}`,
    items = undefined,
    startedAt = null,
    completedAt = null,
  } = {},
) {
  return {
    id,
    status: "completed",
    startedAt,
    completedAt,
    durationMs: null,
    items: items ?? [agentItem(itemId, text)],
    error: null,
  };
}

function recordLiveCompletion(
  store,
  threadId,
  turnId,
  text,
  { startedAt = null } = {},
) {
  store.recordTurnStart(threadId, {
    id: turnId,
    status: "inProgress",
    startedAt,
  });
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
    if (method === "thread/read") {
      const thread = structuredClone(this.thread);
      if (!params.includeTurns) {
        delete thread.turns;
      }
      return { thread };
    }
    if (method === "thread/turns/list") {
      const source = structuredClone(this.thread.turns ?? []);
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
      return {
        data,
        nextCursor: nextOffset < source.length ? String(nextOffset) : null,
        backwardsCursor: data.length > 0 ? `anchor:${originalIndex}` : null,
      };
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
  assert.deepEqual(client.calls[0], {
    method: "thread/read",
    params: { threadId: thread.id, includeTurns: false },
  });
  assert.equal(
    client.calls.some(
      (call) => call.method === "thread/read" && call.params.includeTurns === true,
    ),
    false,
  );

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

test("aggregate active status clears stale EventStore ids for every terminal turn state", async (t) => {
  for (const terminalStatus of ["completed", "interrupted", "failed"]) {
    await t.test(terminalStatus, async (subtest) => {
      const harness = await createHarness(subtest);
      const { eventStore, service, thread } = harness;
      thread.status = { type: "active" };
      thread.turns.push({
        id: `stale-${terminalStatus}`,
        status: terminalStatus,
        items: [],
        error: terminalStatus === "failed" ? { message: "expected" } : null,
      });
      thread.turns.push({
        id: `external-active-${terminalStatus}`,
        status: "inProgress",
        items: [],
        error: null,
      });
      eventStore.recordTurnStart(thread.id, {
        id: `stale-${terminalStatus}`,
        status: "inProgress",
      });

      const status = await service.status({ threadId: thread.id });
      assert.equal(status.activeTurnId, null);
      assert.deepEqual(status.status, { type: "active" });
      assert.equal(status.latestAgentMessage, SNAPSHOT_38);
    });
  }
});

test("an old live completion beyond the status window cannot override a newer final", async (t) => {
  const oldText = "Old EventStore completion.";
  const newestText = "Newest persisted completion.";
  const turns = [
    completedTurn("turn-old-live", oldText, {
      startedAt: 100,
      completedAt: 101,
    }),
  ];
  for (let index = 0; index < 20; index += 1) {
    turns.push(
      completedTurn(
        `turn-newer-${index}`,
        index === 19 ? newestText : `Newer completion ${index}.`,
        { startedAt: 1_000 + index, completedAt: 1_001 + index },
      ),
    );
  }
  const thread = {
    id: "thread-old-live-record",
    status: { type: "idle" },
    updatedAt: 500,
    turns,
  };
  const harness = await createHarness(t, { thread });
  recordLiveCompletion(
    harness.eventStore,
    thread.id,
    "turn-old-live",
    oldText,
    { startedAt: 100 },
  );

  const status = await harness.service.status({ threadId: thread.id });
  assert.equal(status.latestAgentMessage, newestText);
  const metadataCalls = harness.client.calls.filter(
    (call) =>
      call.method === "thread/turns/list" &&
      call.params.sortDirection === "desc" &&
      call.params.itemsView === "notLoaded",
  );
  const fullCalls = harness.client.calls.filter(
    (call) =>
      call.method === "thread/turns/list" &&
      call.params.sortDirection === "asc" &&
      call.params.itemsView === "full",
  );
  assert.equal(metadataCalls.length, 16);
  assert.equal(fullCalls.length, 1);
  assert.equal(fullCalls[0].params.limit, 1);
  assert.equal(
    harness.client.calls.some((call) => call.method === "thread/items/list"),
    false,
  );
});

test("a just-completed live turn wins while its item precedes visible turn metadata", async (t) => {
  const turns = Array.from({ length: 16 }, (_, index) =>
    completedTurn(`turn-older-visible-${index}`, `Older final ${index}.`, {
      startedAt: 100 + index,
      completedAt: 101 + index,
    }),
  );
  const thread = {
    id: "thread-turn-metadata-lag",
    status: { type: "idle" },
    updatedAt: 550,
    turns,
  };
  const harness = await createHarness(t, { thread });
  const liveText = "Newest live final with item-only persistence.";
  harness.eventStore.recordTurnStart(thread.id, {
    id: "turn-metadata-lag",
    status: "inProgress",
    startedAt: 1_000,
  });
  const liveItem = agentItem("item-metadata-lag", liveText);
  harness.eventStore.record("item/completed", {
    threadId: thread.id,
    turnId: "turn-metadata-lag",
    item: liveItem,
  });
  harness.eventStore.record("turn/completed", {
    threadId: thread.id,
    turn: { id: "turn-metadata-lag", status: "completed", items: [] },
  });

  const status = await harness.service.status({ threadId: thread.id });
  assert.equal(status.activeTurnId, null);
  assert.equal(status.latestAgentMessage, liveText);
  assert.equal(
    harness.client.calls.some(
      (call) =>
        call.method === "thread/items/list" &&
        call.params.turnId === "turn-metadata-lag",
    ),
    false,
  );
});

test("ambiguous absent turn ordering conservatively preserves the live final", async (t) => {
  const thread = {
    id: "thread-ambiguous-live-order",
    status: { type: "idle" },
    updatedAt: 575,
    turns: Array.from({ length: 16 }, (_, index) =>
      completedTurn(`opaque-older-${index}`, `Visible completion ${index}.`),
    ),
  };
  const harness = await createHarness(t, { thread });
  const liveText = "Ambiguous item-only live final.";
  harness.eventStore.recordTurnStart(thread.id, {
    id: "opaque-live-turn",
    status: "inProgress",
  });
  const liveItem = agentItem("opaque-live-item", liveText);
  harness.eventStore.record("item/completed", {
    threadId: thread.id,
    turnId: "opaque-live-turn",
    item: liveItem,
  });
  harness.eventStore.record("turn/completed", {
    threadId: thread.id,
    turn: { id: "opaque-live-turn", status: "completed", items: [] },
  });

  const status = await harness.service.status({ threadId: thread.id });
  assert.equal(status.latestAgentMessage, liveText);
  assert.equal(
    harness.client.calls.some(
      (call) =>
        call.method === "thread/items/list" &&
        call.params.turnId === "opaque-live-turn",
    ),
    false,
  );
});

test("an authoritative completed full turn supersedes stale live text from the same turn", async (t) => {
  const persistedText = "Authoritative persisted final for this turn.";
  const thread = {
    id: "thread-same-turn-final-refresh",
    status: { type: "idle" },
    updatedAt: 590,
    turns: [completedTurn("turn-same-id", persistedText)],
  };
  const harness = await createHarness(t, { thread });
  harness.eventStore.recordTurnStart(thread.id, {
    id: "turn-same-id",
    status: "inProgress",
  });
  harness.eventStore.record("item/completed", {
    threadId: thread.id,
    turnId: "turn-same-id",
    item: agentItem("stale-live-item", "Stale live wording."),
  });

  const status = await harness.service.status({ threadId: thread.id });
  assert.equal(status.activeTurnId, null);
  assert.equal(status.latestAgentMessage, persistedText);
  assert.equal(
    harness.client.calls.some((call) => call.method === "thread/items/list"),
    false,
  );
});

test("status fails closed when a native hydration anchor returns a different turn", async (t) => {
  const harness = await createHarness(t);
  const request = harness.client.request.bind(harness.client);
  harness.client.request = async (method, params = {}) => {
    if (
      method === "thread/turns/list" &&
      params.sortDirection === "asc" &&
      params.itemsView === "full"
    ) {
      harness.client.calls.push({ method, params: structuredClone(params) });
      return {
        data: [completedTurn("wrong-anchor-turn", "Wrong final")],
        nextCursor: null,
        backwardsCursor: null,
      };
    }
    return await request(method, params);
  };

  await assert.rejects(
    () => harness.service.status({ threadId: harness.thread.id }),
    /mismatched full turn for status anchor/,
  );
  assert.equal(
    harness.client.calls.some((call) => call.method === "thread/items/list"),
    false,
  );
});

test("an in-progress persisted turn with a final-looking item does not supersede its live completion", async (t) => {
  const liveText = "Live completion awaiting terminal turn persistence.";
  const thread = {
    id: "thread-in-progress-final-item",
    status: { type: "active" },
    updatedAt: 600,
    turns: [
      completedTurn("turn-prior", "Prior persisted completion."),
      {
        id: "turn-current",
        status: "inProgress",
        items: [agentItem("item-current", liveText)],
        error: null,
      },
    ],
  };
  const harness = await createHarness(t, { thread });
  harness.eventStore.recordTurnStart(thread.id, {
    id: "turn-current",
    status: "inProgress",
  });
  harness.eventStore.record("item/completed", {
    threadId: thread.id,
    turnId: "turn-current",
    item: agentItem("item-current", liveText),
  });

  const status = await harness.service.status({ threadId: thread.id });
  assert.equal(status.activeTurnId, "turn-current");
  assert.equal(status.latestAgentMessage, liveText);
  assert.equal(
    harness.client.calls.some(
      (call) =>
        call.method === "thread/items/list" &&
        call.params.turnId === "turn-current",
    ),
    false,
  );
});

test("authoritative interrupted and failed turns suppress completed live-item text", async (t) => {
  for (const terminalStatus of ["interrupted", "failed"]) {
    await t.test(terminalStatus, async (subtest) => {
      const liveText = `Invalid ${terminalStatus} live final.`;
      const thread = {
        id: `thread-suppress-${terminalStatus}`,
        status: { type: "idle" },
        updatedAt: 625,
        turns: [
          completedTurn("turn-prior-valid", "Prior valid persisted final."),
          {
            id: "turn-terminal-live",
            status: terminalStatus,
            items: [agentItem("item-terminal-live", liveText)],
            error: terminalStatus === "failed" ? { message: "expected" } : null,
          },
        ],
      };
      const harness = await createHarness(subtest, { thread });
      harness.eventStore.recordTurnStart(thread.id, {
        id: "turn-terminal-live",
        status: "inProgress",
      });
      harness.eventStore.record("item/completed", {
        threadId: thread.id,
        turnId: "turn-terminal-live",
        item: agentItem("item-terminal-live", liveText),
      });

      const status = await harness.service.status({ threadId: thread.id });
      assert.equal(status.activeTurnId, null);
      assert.equal(status.latestAgentMessage, "Prior valid persisted final.");
    });
  }
});

test("an active full status window does not fabricate an absent newer live turn as completed", async (t) => {
  const turns = Array.from({ length: 16 }, (_, index) =>
    completedTurn(`turn-older-${index}`, `Older persisted completion ${index}.`),
  );
  const thread = {
    id: "thread-active-absent-live",
    status: { type: "active" },
    updatedAt: 650,
    turns,
  };
  const harness = await createHarness(t, { thread });
  const liveText = "New live final whose turn is not persisted yet.";
  harness.eventStore.recordTurnStart(thread.id, {
    id: "turn-new-live",
    status: "inProgress",
  });
  harness.eventStore.record("item/completed", {
    threadId: thread.id,
    turnId: "turn-new-live",
    item: agentItem("item-new-live", liveText),
  });

  const status = await harness.service.status({ threadId: thread.id });
  assert.equal(status.activeTurnId, "turn-new-live");
  assert.equal(status.latestAgentMessage, liveText);
  assert.equal(
    harness.client.calls.some(
      (call) =>
        call.method === "thread/items/list" &&
        call.params.turnId === "turn-new-live",
    ),
    false,
  );
});

test("bounded status finds finals anywhere in a hydrated turn after malformed tails", async (t) => {
  for (const descendingPosition of [1, 16]) {
    await t.test(`position-${descendingPosition}`, async (subtest) => {
      const items = Array.from({ length: 16 }, (_, index) => ({
        type: "toolOutput",
        id: `tool-${index}`,
        text: `tool output ${index}`,
      }));
      const itemIndex = items.length - descendingPosition;
      items[itemIndex] = agentItem(
        `final-${descendingPosition}`,
        `Expected final at descending position ${descendingPosition}.`,
      );
      const thread = {
        id: `thread-final-position-${descendingPosition}`,
        status: { type: "idle" },
        updatedAt: 700 + descendingPosition,
        turns: [
          completedTurn(`turn-target-${descendingPosition}`, "unused", { items }),
          completedTurn("turn-malformed-tail", "unused", {
            items: [
              agentItem("commentary-tail", "Ignored commentary", {
                phase: "commentary",
              }),
              { type: "agentMessage", id: "missing-text", phase: "final_answer" },
            ],
          }),
        ],
      };
      const harness = await createHarness(subtest, { thread });

      const status = await harness.service.status({ threadId: thread.id });
      assert.equal(
        status.latestAgentMessage,
        `Expected final at descending position ${descendingPosition}.`,
      );
      const fullCalls = harness.client.calls.filter(
        (call) =>
          call.method === "thread/turns/list" &&
          call.params.sortDirection === "asc" &&
          call.params.itemsView === "full",
      );
      assert.equal(fullCalls.length, 2);
      assert.ok(fullCalls.every((call) => call.params.limit === 1));
      assert.equal(
        harness.client.calls.some((call) => call.method === "thread/items/list"),
        false,
      );
    });
  }
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

test("compact status stays below the result budget while preserving approval identities", () => {
  const finalText = "🫁".repeat(MAX_RECONCILED_AGENT_TEXT);
  const pendingRequests = Array.from({ length: 4 }, (_, index) => ({
    requestKey: `request-${index}`,
    id: `approval-${index}`,
    method: "item/commandExecution/requestApproval",
    threadId: "thread-status-boundary",
    turnId: "turn-active",
    receivedAt: `2026-08-02T00:00:0${index}.000Z`,
    params: {
      availableDecisions: ["accept", "cancel"],
      command: "氧".repeat(150_000),
    },
  }));
  const bounded = boundStatusResult({
    thread: {
      id: "thread-status-boundary",
      cwd: "C:\\allowed",
      status: { type: "active" },
    },
    threadId: "thread-status-boundary",
    activeTurnId: "turn-active",
    latestAgentMessage: finalText,
    latestDiff: { text: "δ".repeat(250_000) },
    latestError: { message: "錯".repeat(250_000) },
    pendingRequests,
    events: Array.from({ length: 5 }, (_, index) => ({
      sequence: index + 1,
      payload: "é".repeat(100_000),
    })),
    eventCursor: 5,
    appServer: { state: "ready" },
  });

  const modernBytes = measureToolResultEnvelopeBytes(bounded, { isModern: true });
  const legacyBytes = measureToolResultEnvelopeBytes(bounded, { isModern: false });
  assert.equal(bounded.responseByteBasis, TOOL_RESULT_BYTE_BASIS);
  assert.ok(modernBytes <= MAX_THREAD_PAGE_BYTES);
  assert.ok(legacyBytes <= MAX_THREAD_PAGE_BYTES);
  assert.equal(
    bounded.responseBytes,
    modernBytes,
  );
  assert.equal(bounded.latestAgentMessage, finalText);
  assert.deepEqual(
    bounded.pendingRequests.map((request) => request.requestKey),
    pendingRequests.map((request) => request.requestKey),
  );
  assert.ok(bounded.eventsTruncated > 0);
});

test("status overflow compacts and deterministically truncates many small approvals", () => {
  const total = 400;
  const bounded = boundStatusResult(
    {
      thread: { id: "thread-many-approvals", cwd: "C:\\allowed" },
      latestAgentMessage: "Newest final",
      latestDiff: null,
      latestError: null,
      pendingRequests: Array.from({ length: total }, (_, index) => ({
        requestKey: `number:${index}`,
        requestId: index,
        method: "item/commandExecution/requestApproval",
        threadId: "thread-many-approvals",
        turnId: "turn-active",
        receivedAt: `2026-08-02T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
        params: {
          availableDecisions: ["accept", "cancel"],
          command: `command-${index}-${"x".repeat(100)}`,
        },
      })),
      events: [],
      eventCursor: 0,
      appServer: { state: "ready" },
    },
    50_000,
  );

  assert.ok(measureToolResultEnvelopeBytes(bounded, { isModern: true }) <= 50_000);
  assert.equal(bounded.pendingRequestsTotal, total);
  assert.equal(
    bounded.pendingRequestsReturned + bounded.pendingRequestsTruncated,
    total,
  );
  assert.ok(bounded.pendingRequestsTruncated > 0);
  assert.deepEqual(
    bounded.pendingRequests.map((request) => request.requestId),
    Array.from({ length: bounded.pendingRequestsReturned }, (_, index) => index),
  );
  assert.ok(
    bounded.pendingRequests.every(
      (request) => request.requestKey && request.method && request.params.truncated,
    ),
  );
});

test("status bulk-trims 200 large events to the newest bounded suffix", () => {
  const events = Array.from({ length: 200 }, (_, index) => ({
    sequence: index + 1,
    payload: "x".repeat(96_000),
  }));
  let measureCalls = 0;
  const measureEnvelope = (output, options) => {
    measureCalls += 1;
    return measureToolResultEnvelopeBytes(output, options);
  };

  const bounded = boundStatusResult(
    {
      thread: { id: "thread-event-suffix", cwd: "C:\\allowed" },
      latestAgentMessage: "Newest final",
      latestDiff: null,
      latestError: null,
      pendingRequests: [],
      events,
      eventCursor: 200,
      appServer: { state: "ready" },
    },
    MAX_THREAD_PAGE_BYTES,
    { measureEnvelope },
  );

  assert.ok(measureCalls <= 30, `expected at most 30 measurements, received ${measureCalls}`);
  assert.equal(bounded.events.length, 15);
  assert.equal(bounded.eventsTruncated, 185);
  assert.deepEqual(
    bounded.events.map((event) => event.sequence),
    Array.from({ length: 15 }, (_, index) => 186 + index),
  );
  assert.equal(
    bounded.responseBytes,
    measureToolResultEnvelopeBytes(bounded, { isModern: true }),
  );
  assert.ok(bounded.responseBytes <= MAX_THREAD_PAGE_BYTES);
});
