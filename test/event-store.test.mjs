import assert from "node:assert/strict";
import test from "node:test";

import { EventStore } from "../src/event-store.mjs";

test("threadless and other-thread terminal events do not complete an unrelated wait", async () => {
  const store = new EventStore();
  store.recordTurnStart("thread-a", { id: "turn-a" });
  store.recordTurnStart("thread-b", { id: "turn-b" });
  const cursor = store.sequence;

  const waiting = store.waitFor("thread-a", {
    afterSequence: cursor,
    timeoutMs: 1_000,
  });
  store.record("error", { error: { message: "global failure" } });
  store.record("turn/completed", {
    threadId: "thread-b",
    turn: { id: "turn-b", status: "completed" },
  });
  store.record("turn/completed", {
    threadId: "thread-a",
    turn: { id: "turn-a", status: "completed" },
  });

  const completed = await waiting;
  assert.equal(completed.reason, "completed");
  assert.deepEqual(completed.events.map((event) => event.threadId), ["thread-a"]);
  assert.equal(completed.latestError, null);
});

test("process failure terminates only affected threads and clears invalid runtime state", async () => {
  const store = new EventStore();
  store.recordTurnStart("thread-a", { id: "turn-a" });
  store.recordTurnStart("thread-b", { id: "turn-b" });
  store.addPendingRequest({
    id: "approval-a",
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-a", turnId: "turn-a" },
  });
  const cursor = store.sequence;
  const waitingA = store.waitFor("thread-a", { afterSequence: cursor, timeoutMs: 1_000 });
  const waitingB = store.waitFor("thread-b", { afterSequence: cursor, timeoutMs: 1_000 });

  const affected = store.recordProcessFailure(new Error("app-server stopped"));
  assert.equal(affected, 2);

  const [failedA, failedB] = await Promise.all([waitingA, waitingB]);
  for (const failed of [failedA, failedB]) {
    assert.equal(failed.reason, "error");
    assert.equal(failed.activeTurnId, null);
    assert.equal(failed.latestError.source, "app-server-process");
    assert.deepEqual(failed.pendingRequests, []);
  }
  assert.deepEqual(store.getPendingRequests(), []);

  const unrelated = store.getSnapshot("thread-c");
  assert.equal(unrelated.latestError, null);
  assert.deepEqual(unrelated.events, []);
});
