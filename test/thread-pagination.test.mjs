import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EventStore } from "../src/event-store.mjs";
import { PathPolicy } from "../src/security.mjs";
import { CodexSupervisorService } from "../src/supervisor-service.mjs";
import {
  MAX_THREAD_PAGE_BYTES,
  MIN_THREAD_PAGE_BYTES,
  TOOL_RESULT_BYTE_BASIS,
} from "../src/thread-pagination.mjs";
import { measureToolResultEnvelopeBytes } from "../src/tool-result.mjs";
import {
  NEWEST_FINAL_TEXT,
  OVER_TWO_MIB_TRANSCRIPT_BYTES,
  REPRESENTATIVE_HISTORY_BYTES,
  assertExactTranscriptReconstruction,
  canonicalTranscriptBytes,
  createOverTwoMiBThreadFixture,
  createRepresentativeHistoryFixture,
} from "./large-thread-fixture.mjs";

function compactThread(thread) {
  const { turns: _turns, ...metadata } = thread;
  return metadata;
}

function itemSummary(item) {
  return {
    id: item?.id ?? null,
    type: item?.type ?? null,
    phase: item?.phase ?? null,
    status: item?.status ?? null,
  };
}

function cursorOffset(cursor, prefix) {
  if (cursor === undefined || cursor === null) {
    return 0;
  }
  const match = new RegExp(`^${prefix}:(\\d+)$`).exec(cursor);
  if (!match) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Number.parseInt(match[1], 10);
}

class PaginatedThreadClient {
  constructor(thread) {
    this.thread = thread;
    this.loadedThreads = new Set([thread.id]);
    this.calls = [];
    this.turnPageTraces = [];
  }

  async request(method, params = {}) {
    this.calls.push({ method, params: structuredClone(params) });
    if (method === "thread/read") {
      return { thread: compactThread(this.thread) };
    }
    if (method === "thread/turns/list") {
      const descending = params.sortDirection === "desc";
      const source = descending
        ? [...(this.thread.turns ?? [])].reverse()
        : [...(this.thread.turns ?? [])];
      const prefix = descending ? "turn-desc" : "turn-asc";
      const offset = cursorOffset(params.cursor, prefix);
      const limit = params.limit ?? source.length;
      let data = source.slice(offset, offset + limit);
      if (params.itemsView === "notLoaded") {
        data = data.map((turn) => ({ ...turn, items: [] }));
      } else if (params.itemsView === "summary") {
        data = data.map((turn) => ({
          ...turn,
          items: (turn.items ?? []).map(itemSummary),
        }));
      }
      const nextOffset = offset + data.length;
      const sourceIndex = descending
        ? (this.thread.turns?.length ?? 0) - 1 - offset
        : offset;
      this.turnPageTraces.push({
        params: structuredClone(params),
        returnedTurnCount: data.length,
        returnedBytes: Buffer.byteLength(JSON.stringify(data), "utf8"),
      });
      return {
        data,
        nextCursor:
          nextOffset < source.length ? `${prefix}:${nextOffset}` : null,
        backwardsCursor:
          data.length > 0 ? `turn-asc:${sourceIndex}` : null,
      };
    }
    if (method === "thread/items/list") {
      throw new Error("thread/items/list unavailable (-32601)");
    }
    throw new Error(`Unexpected app-server method: ${method}`);
  }

  describe() {
    return { state: "ready" };
  }

  async stop() {}
}

async function createHarness(t, fixture) {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), "codex-thread-page-"));
  t.after(async () => {
    await fs.rm(repository, { recursive: true, force: true });
  });
  fixture.thread.cwd = await fs.realpath(repository);
  const client = new PaginatedThreadClient(fixture.thread);
  const eventStore = new EventStore();
  const service = new CodexSupervisorService({
    pathPolicy: await PathPolicy.create({ allowedRoots: [repository] }),
    eventStore,
    appServerClient: client,
  });
  t.after(async () => {
    await service.close();
  });
  return { client, eventStore, repository, service, thread: fixture.thread };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertBoundedPage(page, maxBytes) {
  const modernBytes = measureToolResultEnvelopeBytes(page, { isModern: true });
  const legacyBytes = measureToolResultEnvelopeBytes(page, { isModern: false });
  assert.equal(page.responseByteBasis, TOOL_RESULT_BYTE_BASIS);
  assert.equal(page.responseBytes, modernBytes);
  assert.ok(modernBytes <= maxBytes, `${modernBytes} exceeds requested ${maxBytes}`);
  assert.ok(legacyBytes <= maxBytes, `${legacyBytes} exceeds requested ${maxBytes}`);
  assert.ok(modernBytes <= MAX_THREAD_PAGE_BYTES);
  assert.equal(page.maxBytes, maxBytes);
  assert.equal(page.range.order, "chronological");
  assert.equal(page.hasMore, page.nextCursor !== null);
  if (page.hasMore) {
    assert.equal(typeof page.nextCursor, "string");
  } else {
    assert.equal(page.nextCursor, null);
  }
}

function decodeCanonicalFragment(fragment) {
  assert.equal(fragment.encoding, "base64url-json-utf8");
  const decoded = Buffer.from(fragment.data, "base64url");
  assert.equal(decoded.toString("base64url"), fragment.data);
  assert.equal(fragment.byteEnd, fragment.byteStart + decoded.length);
  return decoded;
}

async function readAllPages(service, threadId, { maxBytes = MAX_THREAD_PAGE_BYTES } = {}) {
  const pages = [];
  const turnsByIndex = new Map();
  const fragmentState = new Map();
  let cursor;
  let snapshotId = null;

  do {
    const page = await service.readThread({
      threadId,
      includeTurns: true,
      ...(cursor === undefined ? {} : { cursor }),
      maxBytes,
    });
    pages.push(page);
    assertBoundedPage(page, maxBytes);
    snapshotId ??= page.snapshot.id;
    assert.equal(page.snapshot.id, snapshotId);

    for (let offset = 0; offset < page.thread.turns.length; offset += 1) {
      const turnIndex = page.range.startTurnIndex + offset;
      assert.equal(turnsByIndex.has(turnIndex), false, `duplicate turn ${turnIndex}`);
      assert.equal(fragmentState.has(turnIndex), false);
      turnsByIndex.set(turnIndex, page.thread.turns[offset]);
    }

    if (page.turnFragment) {
      const fragment = page.turnFragment;
      assert.equal(fragment.turnIndex, page.range.fragmentTurnIndex);
      let state = fragmentState.get(fragment.turnIndex);
      if (!state) {
        state = {
          expectedStart: 0,
          totalBytes: fragment.totalBytes,
          sha256: fragment.sha256,
          buffers: [],
        };
        fragmentState.set(fragment.turnIndex, state);
      }
      assert.equal(fragment.byteStart, state.expectedStart);
      assert.equal(fragment.totalBytes, state.totalBytes);
      assert.equal(fragment.sha256, state.sha256);
      const decoded = decodeCanonicalFragment(fragment);
      state.buffers.push(decoded);
      state.expectedStart = fragment.byteEnd;
      if (fragment.byteEnd === fragment.totalBytes) {
        const canonical = Buffer.concat(state.buffers);
        assert.equal(canonical.length, state.totalBytes);
        assert.equal(sha256(canonical), state.sha256);
        assert.equal(turnsByIndex.has(fragment.turnIndex), false);
        turnsByIndex.set(
          fragment.turnIndex,
          JSON.parse(canonical.toString("utf8")),
        );
        fragmentState.delete(fragment.turnIndex);
      }
    }

    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);

  assert.equal(fragmentState.size, 0);
  const indexes = [...turnsByIndex.keys()].sort((left, right) => left - right);
  assert.deepEqual(indexes, Array.from({ length: indexes.length }, (_, index) => index));
  return {
    pages,
    turns: indexes.map((index) => turnsByIndex.get(index)),
  };
}

function smallFixture() {
  const fixture = createOverTwoMiBThreadFixture({
    targetTranscriptBytes: 32_000,
    turnCount: 3,
    includeInterruptedTail: false,
  });
  return fixture;
}

test("reconstructs an exact transcript above 2 MiB in bounded chronological pages", async (t) => {
  const fixture = createOverTwoMiBThreadFixture();
  assert.equal(fixture.transcriptBytes, OVER_TWO_MIB_TRANSCRIPT_BYTES);
  const { service, thread } = await createHarness(t, fixture);
  const reconstructed = await readAllPages(service, thread.id);

  assert.ok(reconstructed.pages.length > 1);
  assertExactTranscriptReconstruction(thread, reconstructed.turns);
  assert.equal(canonicalTranscriptBytes(reconstructed.turns).length, fixture.transcriptBytes);
});

test("reconstructs the exact 7,840,000-byte history without gaps or duplicates", async (t) => {
  const fixture = createRepresentativeHistoryFixture();
  assert.equal(fixture.transcriptBytes, REPRESENTATIVE_HISTORY_BYTES);
  const { client, service, thread } = await createHarness(t, fixture);
  const reconstructed = await readAllPages(service, thread.id);
  const verified = assertExactTranscriptReconstruction(thread, reconstructed.turns);

  assert.ok(reconstructed.pages.length >= 6);
  assert.equal(verified.transcriptBytes, REPRESENTATIVE_HISTORY_BYTES);
  assert.equal(verified.newestFinal.text, NEWEST_FINAL_TEXT);
  assert.equal(verified.newestFinal.turnId, "rollout-2");
  const fullTurnCalls = client.turnPageTraces.filter(
    (trace) =>
      trace.params.sortDirection === "asc" && trace.params.itemsView === "full",
  );
  assert.equal(fullTurnCalls.length, 9);
  assert.equal(reconstructed.pages.length, 9);
  assert.ok(fullTurnCalls.every((trace) => trace.returnedTurnCount <= 4));
  assert.ok(Math.max(...fullTurnCalls.map((trace) => trace.returnedTurnCount)) <= 4);
  assert.ok(Math.max(...fullTurnCalls.map((trace) => trace.returnedBytes)) < 1_100_000);
});

test("adaptive 4 to 2 to 1 retries advance the accepted cursor exactly once", async (t) => {
  const fixture = createRepresentativeHistoryFixture({
    targetTranscriptBytes: 1_200_000,
    turnCount: 6,
    includeInterruptedTail: false,
  });
  const { client, service, thread } = await createHarness(t, fixture);
  const reconstructed = await readAllPages(service, thread.id, { maxBytes: 300_000 });
  const fullTurnCalls = client.turnPageTraces.filter(
    (trace) =>
      trace.params.sortDirection === "asc" && trace.params.itemsView === "full",
  );

  assert.deepEqual(
    fullTurnCalls.slice(0, 3).map((trace) => trace.params.limit),
    [4, 2, 1],
  );
  assert.ok(reconstructed.pages.every((page) => page.range.endTurnIndex - page.range.startTurnIndex === 1));
  assert.deepEqual(
    reconstructed.pages.map((page) => page.range.startTurnIndex),
    thread.turns.map((_, index) => index),
  );
  assert.deepEqual(
    reconstructed.turns.map((turn) => turn.id),
    thread.turns.map((turn) => turn.id),
  );
  assertExactTranscriptReconstruction(thread, reconstructed.turns);
});

test("preserves compact and small-thread compatibility", async (t) => {
  const fixture = smallFixture();
  const { service, thread } = await createHarness(t, fixture);
  const compact = await service.readThread({ threadId: thread.id });
  assert.equal("turns" in compact.thread, false);
  assert.deepEqual(compact, { thread: compactThread(thread) });

  const expanded = await service.readThread({
    threadId: thread.id,
    includeTurns: true,
  });
  assert.deepEqual(expanded.thread.turns, thread.turns);
  assert.equal(expanded.hasMore, false);
  assert.equal(expanded.nextCursor, null);
  assert.equal(expanded.turnFragment, undefined);
  assert.equal(expanded.range.startTurnIndex, 0);
  assert.equal(expanded.range.endTurnIndex, thread.turns.length);
  assertBoundedPage(expanded, MAX_THREAD_PAGE_BYTES);
});

test("replaying a cursor is stable across calls and a fresh service", async (t) => {
  const fixture = createOverTwoMiBThreadFixture();
  const first = await createHarness(t, fixture);
  const pageOne = await first.service.readThread({
    threadId: first.thread.id,
    includeTurns: true,
    maxBytes: 180_000,
  });
  assert.equal(pageOne.hasMore, true);

  const pageTwoA = await first.service.readThread({
    threadId: first.thread.id,
    includeTurns: true,
    cursor: pageOne.nextCursor,
  });
  const pageTwoB = await first.service.readThread({
    threadId: first.thread.id,
    includeTurns: true,
    cursor: pageOne.nextCursor,
  });
  assert.deepEqual(pageTwoB, pageTwoA);

  const secondClient = new PaginatedThreadClient(first.thread);
  const secondService = new CodexSupervisorService({
    pathPolicy: await PathPolicy.create({ allowedRoots: [first.repository] }),
    eventStore: new EventStore(),
    appServerClient: secondClient,
  });
  t.after(async () => {
    await secondService.close();
  });
  const pageTwoAfterRestart = await secondService.readThread({
    threadId: first.thread.id,
    includeTurns: true,
    cursor: pageOne.nextCursor,
  });
  assert.deepEqual(pageTwoAfterRestart, pageTwoA);
});

test("rejects malformed, tampered, cross-thread, mismatched-budget, and stale cursors", async (t) => {
  const fixture = createOverTwoMiBThreadFixture();
  const first = await createHarness(t, fixture);
  const initial = await first.service.readThread({
    threadId: first.thread.id,
    includeTurns: true,
    maxBytes: 180_000,
  });
  assert.equal(initial.hasMore, true);
  const cursor = initial.nextCursor;

  await assert.rejects(
    () => first.service.readThread({
      threadId: first.thread.id,
      includeTurns: true,
      cursor: "not-a-cursor",
    }),
    /malformed or unsupported/,
  );
  const replacement = cursor.endsWith("A") ? "B" : "A";
  await assert.rejects(
    () => first.service.readThread({
      threadId: first.thread.id,
      includeTurns: true,
      cursor: `${cursor.slice(0, -1)}${replacement}`,
    }),
    /malformed or unsupported/,
  );
  await assert.rejects(
    () => first.service.readThread({
      threadId: first.thread.id,
      includeTurns: true,
      cursor,
      maxBytes: 181_000,
    }),
    /must match the value bound into cursor/,
  );

  const otherFixture = createOverTwoMiBThreadFixture({ threadId: "thread-other" });
  otherFixture.thread.cwd = first.thread.cwd;
  const otherClient = new PaginatedThreadClient(otherFixture.thread);
  const otherService = new CodexSupervisorService({
    pathPolicy: await PathPolicy.create({ allowedRoots: [first.repository] }),
    eventStore: new EventStore(),
    appServerClient: otherClient,
  });
  t.after(async () => {
    await otherService.close();
  });
  await assert.rejects(
    () => otherService.readThread({
      threadId: otherFixture.thread.id,
      includeTurns: true,
      cursor,
    }),
    /different thread/,
  );

  first.thread.turns.at(-1).items[0].text += " changed";
  await assert.rejects(
    () => first.service.readThread({
      threadId: first.thread.id,
      includeTurns: true,
      cursor,
    }),
    /cursor is stale/,
  );
});

test("fragments and reconstructs a 1.7 MB turn across a multibyte boundary", async (t) => {
  const fixture = createOverTwoMiBThreadFixture({ oversizedSingleItem: true });
  const { service, thread } = await createHarness(t, fixture);
  const firstTurnBytes = Buffer.from(JSON.stringify(thread.turns[0]), "utf8");
  assert.ok(firstTurnBytes.length > MAX_THREAD_PAGE_BYTES);

  let splitBudget = null;
  for (let maxBytes = 200_000; maxBytes <= 200_064; maxBytes += 1) {
    const page = await service.readThread({
      threadId: thread.id,
      includeTurns: true,
      maxBytes,
    });
    const byteEnd = page.turnFragment?.byteEnd;
    if (
      Number.isInteger(byteEnd) &&
      byteEnd < firstTurnBytes.length &&
      (firstTurnBytes[byteEnd] & 0xc0) === 0x80
    ) {
      splitBudget = maxBytes;
      break;
    }
  }
  assert.notEqual(splitBudget, null, "expected a fragment boundary inside UTF-8 text");

  const reconstructed = await readAllPages(service, thread.id, {
    maxBytes: splitBudget,
  });
  assert.ok(reconstructed.pages.some((page) => page.turnFragment));
  assertExactTranscriptReconstruction(thread, reconstructed.turns);
});

test("honors both the 16,384-byte minimum and 1,500,000-byte maximum", async (t) => {
  const fixture = createOverTwoMiBThreadFixture();
  const { service, thread } = await createHarness(t, fixture);
  const minimum = await service.readThread({
    threadId: thread.id,
    includeTurns: true,
    maxBytes: MIN_THREAD_PAGE_BYTES,
  });
  assertBoundedPage(minimum, MIN_THREAD_PAGE_BYTES);
  assert.equal(minimum.hasMore, true);

  const maximum = await service.readThread({
    threadId: thread.id,
    includeTurns: true,
    maxBytes: MAX_THREAD_PAGE_BYTES,
  });
  assertBoundedPage(maximum, MAX_THREAD_PAGE_BYTES);
  assert.equal(maximum.hasMore, true);

  await assert.rejects(
    () => service.readThread({
      threadId: thread.id,
      includeTurns: true,
      maxBytes: MIN_THREAD_PAGE_BYTES - 1,
    }),
    /maxBytes must be between/,
  );
  await assert.rejects(
    () => service.readThread({
      threadId: thread.id,
      includeTurns: true,
      maxBytes: MAX_THREAD_PAGE_BYTES + 1,
    }),
    /maxBytes must be between/,
  );
});

test("returns a bounded terminal page for an empty thread", async (t) => {
  const fixture = {
    thread: {
      id: "thread-empty",
      cwd: "unused",
      status: { type: "idle" },
      createdAt: 1,
      updatedAt: 1,
      turns: [],
    },
  };
  const { service, thread } = await createHarness(t, fixture);
  const page = await service.readThread({
    threadId: thread.id,
    includeTurns: true,
  });
  assert.deepEqual(page.thread.turns, []);
  assert.equal(page.hasMore, false);
  assert.equal(page.nextCursor, null);
  assert.deepEqual(page.range, {
    order: "chronological",
    startTurnIndex: 0,
    endTurnIndex: 0,
    completeTurnCount: 0,
  });
  assertBoundedPage(page, MAX_THREAD_PAGE_BYTES);
});

test("turn-only status finds a final beyond item 16 after fifteen malformed completed turns", async (t) => {
  const validItems = Array.from({ length: 24 }, (_, index) => ({
    type: "toolOutput",
    id: `valid-noise-${index}`,
    ordinal: index,
    text: `non-final-${index}`,
  }));
  validItems.push({
    type: "agentMessage",
    id: "valid-deep-final",
    ordinal: validItems.length,
    text: "Deep exact final after item sixteen 🫁",
    phase: "final_answer",
    status: "completed",
  });
  const validTurn = {
    id: "turn-valid-oldest-in-window",
    ordinal: 0,
    status: "completed",
    startedAt: 1,
    completedAt: 2,
    items: validItems,
    error: null,
  };
  const malformedTurns = Array.from({ length: 15 }, (_, index) => ({
    id: `turn-malformed-${String(index).padStart(2, "0")}`,
    ordinal: index + 1,
    status: "completed",
    startedAt: 3 + index * 2,
    completedAt: 4 + index * 2,
    items: [
      index % 3 === 0
        ? {
            type: "agentMessage",
            id: `malformed-commentary-${index}`,
            ordinal: 0,
            text: "commentary is not final",
            phase: "commentary",
            status: "completed",
          }
        : index % 3 === 1
          ? {
              type: "agentMessage",
              id: `malformed-in-progress-${index}`,
              ordinal: 0,
              text: "unfinished final",
              phase: "final_answer",
              status: "inProgress",
            }
          : {
              type: "agentMessage",
              id: `malformed-text-${index}`,
              ordinal: 0,
              text: { invalid: true },
              phase: "final_answer",
              status: "completed",
            },
    ],
    error: null,
  }));
  const fixture = {
    thread: {
      id: "thread-turn-only-status-window",
      cwd: "unused",
      status: { type: "idle" },
      createdAt: 1,
      updatedAt: 40,
      turns: [validTurn, ...malformedTurns],
    },
  };
  const { client, service, thread } = await createHarness(t, fixture);
  client.calls.length = 0;
  client.turnPageTraces.length = 0;

  const status = await service.status({
    threadId: thread.id,
    includeTurns: false,
  });
  assert.equal(status.latestAgentMessage, validItems.at(-1).text);
  assert.equal(validTurn.items.indexOf(validItems.at(-1)), 24);
  assert.equal(client.calls.some((call) => call.method === "thread/items/list"), false);
  assert.equal(client.calls.length, 33);
  assert.equal(client.calls[0].method, "thread/read");
  const turnCalls = client.calls.slice(1);
  assert.equal(
    turnCalls.filter((call) => call.params.itemsView === "notLoaded").length,
    16,
  );
  assert.equal(
    turnCalls.filter((call) => call.params.itemsView === "full").length,
    16,
  );
  assert.ok(turnCalls.every((call) => call.method === "thread/turns/list"));
  assert.ok(turnCalls.every((call) => call.params.limit === 1));
  assert.equal(turnCalls.at(-1).params.cursor, "turn-asc:0");
});

test("repeated active status stays fixed-cost with multi-megabyte history and >128 active items", async (t) => {
  const fixture = createRepresentativeHistoryFixture({
    includeInterruptedTail: false,
  });
  const activeTurn = {
    id: "turn-active-large",
    ordinal: fixture.thread.turns.length,
    status: "inProgress",
    startedAt: 1_900_000_000,
    completedAt: null,
    durationMs: null,
    items: Array.from({ length: 160 }, (_, index) => ({
      type: "toolOutput",
      id: `active-item-${String(index).padStart(3, "0")}`,
      ordinal: index,
      text: `active-${index}-${"z".repeat(24_000)}`,
    })),
    error: null,
  };
  fixture.thread.turns.push(activeTurn);
  fixture.thread.status = { type: "active" };
  const { client, eventStore, service, thread } = await createHarness(t, fixture);
  eventStore.recordTurnStart(thread.id, {
    id: activeTurn.id,
    status: "inProgress",
    items: [],
  });
  client.calls.length = 0;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const status = await service.status({
      threadId: thread.id,
      includeTurns: false,
    });
    assert.equal(status.activeTurnId, activeTurn.id);
    assert.equal(status.latestAgentMessage, NEWEST_FINAL_TEXT);
    assert.equal("turns" in status.thread, false);
    assert.ok(status.responseBytes <= MAX_THREAD_PAGE_BYTES);

    const calls = client.calls.slice(attempt * 4, attempt * 4 + 4);
    assert.deepEqual(calls.map((call) => call.method), [
      "thread/read",
      "thread/turns/list",
      "thread/turns/list",
      "thread/turns/list",
    ]);
    assert.equal(calls[0].params.includeTurns, false);
    assert.equal(calls[1].params.limit, 1);
    assert.equal(calls[1].params.itemsView, "notLoaded");
    assert.equal(calls[1].params.sortDirection, "desc");
    assert.equal(calls[2].params.cursor, "turn-desc:1");
    assert.equal(calls[2].params.limit, 1);
    assert.equal(calls[2].params.itemsView, "notLoaded");
    assert.equal(calls[2].params.sortDirection, "desc");
    assert.equal(calls[3].params.cursor, "turn-asc:31");
    assert.equal(calls[3].params.limit, 1);
    assert.equal(calls[3].params.itemsView, "full");
    assert.equal(calls[3].params.sortDirection, "asc");
  }
  assert.equal(client.calls.length, 12);
  assert.equal(client.calls.some((call) => call.method === "thread/items/list"), false);
  assert.equal(canonicalTranscriptBytes(thread).length, 11_692_725);
});
