import assert from "node:assert/strict";
import test from "node:test";

import {
  containsCompletedAgentMessage,
  PersistedThreadStatusCache,
  fingerprintPersistedThread,
  inspectPersistedThread,
  isPersistedTurnCompleted,
  selectLatestPersistedAgentMessage,
} from "../src/thread-transcript.mjs";

function agentMessage(id, text, extra = {}) {
  return {
    type: "agentMessage",
    id,
    text,
    phase: "final_answer",
    ...extra,
  };
}

function completedTurn(id, items, extra = {}) {
  return {
    id,
    status: "completed",
    startedAt: null,
    completedAt: null,
    durationMs: null,
    items,
    error: null,
    ...extra,
  };
}

test("persisted selection treats rollout ids as opaque and uses transcript and item order", () => {
  const thread = {
    id: "thread-rollout-order",
    updatedAt: 100,
    status: { type: "idle" },
    turns: [
      completedTurn("turn-managed", [agentMessage("item-managed", "38 tests pass")]),
      completedTurn("rollout-900", [agentMessage("item-rollout-900", "41 tests pass")]),
      completedTurn("rollout-2", [
        agentMessage("item-commentary", "Work in progress", { phase: "commentary" }),
        agentMessage("item-first-final", "42 tests pass"),
        agentMessage("item-last-final", "43 tests pass and development is locally complete"),
      ]),
    ],
  };

  assert.deepEqual(selectLatestPersistedAgentMessage(thread), {
    text: "43 tests pass and development is locally complete",
    turnId: "rollout-2",
    itemId: "item-last-final",
    turnIndex: 2,
    itemIndex: 2,
    phase: "final_answer",
    completedAt: null,
  });

  const inspected = inspectPersistedThread(thread);
  assert.equal(isPersistedTurnCompleted(thread, "rollout-900"), true);
  assert.equal(isPersistedTurnCompleted(thread, "rollout-2"), true);
  assert.equal(isPersistedTurnCompleted(thread, "missing-turn"), false);
  assert.equal(
    containsCompletedAgentMessage(thread, {
      turnId: "rollout-2",
      text: "43 tests pass and development is locally complete",
    }),
    true,
  );
  assert.equal(
    containsCompletedAgentMessage(thread, {
      turnId: "rollout-900",
      text: "43 tests pass and development is locally complete",
    }),
    false,
  );
  assert.deepEqual(Object.keys(inspected), ["latestAgentMessage"]);
});

test("persisted selection ignores malformed, partial, non-final, and interrupted tails", () => {
  const completeText = "The last fully persisted completion.";
  const thread = {
    id: "thread-partial-tail",
    updatedAt: 200,
    status: { type: "idle" },
    turns: [
      completedTurn("rollout-complete", [agentMessage("item-complete", completeText)]),
      {
        id: "rollout-interrupted",
        status: "interrupted",
        items: [agentMessage("item-interrupted", "INTERRUPTED PARTIAL")],
      },
      completedTurn("rollout-malformed", [agentMessage("item-malformed", { corrupt: true })]),
      completedTurn("rollout-empty", [agentMessage("item-empty", "   ")]),
      completedTurn("rollout-commentary", [
        agentMessage("item-commentary", "Not a final response", { phase: "commentary" }),
      ]),
      completedTurn("rollout-item-in-progress", [
        agentMessage("item-in-progress", "ITEM PARTIAL", { status: "inProgress" }),
      ]),
      {
        id: "rollout-turn-in-progress",
        status: { type: "inProgress" },
        items: [agentMessage("item-turn-in-progress", "TRUNCATED FINAL RES")],
      },
    ],
  };

  assert.equal(selectLatestPersistedAgentMessage(thread).text, completeText);
  assert.equal(selectLatestPersistedAgentMessage({ id: "empty", turns: [] }), null);
  assert.equal(selectLatestPersistedAgentMessage({ id: "malformed", turns: {} }), null);
});

test("persisted fingerprint and cache invalidate on transcript metadata, shape, and content changes", () => {
  const thread = {
    id: "thread-fingerprint",
    updatedAt: 300,
    recencyAt: 301,
    status: { type: "idle" },
    turns: [
      completedTurn("rollout-complete", [agentMessage("item-complete", "Older completion")]),
      {
        id: "rollout-mutating",
        status: "inProgress",
        startedAt: null,
        completedAt: null,
        items: [agentMessage("item-mutating", "Local development takeov")],
      },
    ],
  };
  const originalFingerprint = fingerprintPersistedThread(thread);

  const updatedMetadata = structuredClone(thread);
  updatedMetadata.updatedAt += 1;
  assert.notEqual(fingerprintPersistedThread(updatedMetadata), originalFingerprint);

  const appendedTurn = structuredClone(thread);
  appendedTurn.turns.push(
    completedTurn("rollout-appended", [agentMessage("item-new", "New")]),
  );
  assert.notEqual(fingerprintPersistedThread(appendedTurn), originalFingerprint);

  const sameCountContentMutation = structuredClone(thread);
  sameCountContentMutation.turns[1].items[0].text = "Different partial content";
  assert.equal(sameCountContentMutation.updatedAt, thread.updatedAt);
  assert.equal(sameCountContentMutation.turns.length, thread.turns.length);
  assert.notEqual(fingerprintPersistedThread(sameCountContentMutation), originalFingerprint);

  const cache = new PersistedThreadStatusCache();
  const first = cache.reconcile(thread);
  assert.equal(first.changed, true);
  assert.equal(first.latestAgentMessage.text, "Older completion");
  assert.equal(cache.reconcile(thread).changed, false);

  thread.turns[1].status = "completed";
  thread.turns[1].items[0].text = "43 tests pass and development is locally complete";
  const completed = cache.reconcile(thread);
  assert.equal(thread.updatedAt, 300);
  assert.equal(thread.turns.length, 2);
  assert.equal(completed.changed, true);
  assert.equal(completed.latestAgentMessage.turnId, "rollout-mutating");
  assert.equal(
    completed.latestAgentMessage.text,
    "43 tests pass and development is locally complete",
  );
  assert.equal(cache.reconcile(thread).changed, false);

  const boundedCache = new PersistedThreadStatusCache({ maxEntries: 2 });
  boundedCache.reconcile({ ...thread, id: "thread-cache-1" });
  boundedCache.reconcile({ ...thread, id: "thread-cache-2" });
  boundedCache.reconcile({ ...thread, id: "thread-cache-3" });
  assert.deepEqual(
    [...boundedCache.entries.keys()],
    ["thread-cache-2", "thread-cache-3"],
  );
  for (const entry of boundedCache.entries.values()) {
    assert.deepEqual(Object.keys(entry).sort(), ["fingerprint", "latestAgentMessage"]);
  }
});
