import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export const TWO_MIB_BYTES = 2 * 1024 * 1024;
export const OVER_TWO_MIB_TRANSCRIPT_BYTES = TWO_MIB_BYTES + 64 * 1024 + 17;
export const REPRESENTATIVE_HISTORY_BYTES = 7_840_000;
export const DEFAULT_OVERSIZED_ITEM_BYTES = 1_700_000;
export const NEWEST_FINAL_TEXT =
  "Newest fully persisted assistant final — oxygen history complete 🫁✅";

const UNICODE_MARKERS = [
  "SpO₂ 98% 🫁",
  "Café e\u0301",
  "氧饱和度",
  "معدل التنفس",
  "श्वसन दर",
];

function statusType(value) {
  return typeof value === "string" ? value : value?.type ?? null;
}

function turnsFrom(value) {
  if (Array.isArray(value)) {
    return value;
  }
  return Array.isArray(value?.turns) ? value.turns : [];
}

function canonicalJson(value) {
  return JSON.stringify(value);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactUtf8Text(byteLength, prefix) {
  const prefixBytes = Buffer.byteLength(prefix, "utf8");
  if (!Number.isSafeInteger(byteLength) || byteLength < prefixBytes) {
    throw new RangeError(
      `byteLength must be an integer of at least ${prefixBytes} bytes.`,
    );
  }
  const remaining = byteLength - prefixBytes;
  const multibytePattern = "🫁漢é";
  const patternBytes = Buffer.byteLength(multibytePattern, "utf8");
  const repetitions = Math.floor(remaining / patternBytes);
  return `${prefix}${multibytePattern.repeat(repetitions)}${"x".repeat(
    remaining - repetitions * patternBytes,
  )}`;
}

function appendAsciiBytes(target, byteLength) {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new RangeError("byteLength must be a non-negative integer.");
  }
  target.text += "x".repeat(byteLength);
}

function makeCompletedTurn(index, turnCount) {
  const ordinal = index;
  const token = String(index).padStart(5, "0");
  const isNewestFinal = index === turnCount - 1;
  const turnId = isNewestFinal
    ? "rollout-2"
    : index === turnCount - 2
      ? "rollout-900"
      : `turn-${token}`;
  const marker = UNICODE_MARKERS[index % UNICODE_MARKERS.length];

  return {
    id: turnId,
    ordinal,
    status: "completed",
    startedAt: 1_800_000_000 + index * 2,
    completedAt: 1_800_000_001 + index * 2,
    durationMs: 1_000 + index,
    items: [
      {
        type: "userMessage",
        id: `item-${token}-user`,
        ordinal: 0,
        content: [
          {
            type: "input_text",
            text: `Ordered request ${token}: ${marker}`,
          },
        ],
      },
      {
        type: "toolOutput",
        id: `item-${token}-payload`,
        ordinal: 1,
        text: `Deterministic payload ${token}: ${marker}\n`,
      },
      {
        type: "agentMessage",
        id: `item-${token}-assistant`,
        ordinal: 2,
        text: isNewestFinal
          ? NEWEST_FINAL_TEXT
          : `Completed ordered turn ${token}: ${marker}`,
        phase: "final_answer",
        status: "completed",
      },
    ],
    error: null,
  };
}

function makeInterruptedTail(ordinal) {
  const token = String(ordinal).padStart(5, "0");
  return {
    id: "rollout-interrupted-tail",
    ordinal,
    status: "interrupted",
    startedAt: 1_800_000_000 + ordinal * 2,
    completedAt: 1_800_000_001 + ordinal * 2,
    durationMs: 21,
    items: [
      {
        type: "agentMessage",
        id: `item-${token}-partial`,
        ordinal: 0,
        text: "Interrupted partial must not replace the newest final 🛑",
        phase: "final_answer",
        status: "interrupted",
      },
    ],
    error: null,
  };
}

function assertTargetSize(targetTranscriptBytes) {
  if (!Number.isSafeInteger(targetTranscriptBytes) || targetTranscriptBytes <= 0) {
    throw new RangeError("targetTranscriptBytes must be a positive integer.");
  }
}

/**
 * Build a deterministic persisted thread whose canonical turns-array JSON is
 * exactly targetTranscriptBytes UTF-8 bytes. The large payload is generated in
 * memory; no multi-megabyte fixture is stored on disk.
 */
export function createLargeThreadFixture({
  targetTranscriptBytes = OVER_TWO_MIB_TRANSCRIPT_BYTES,
  threadId = "thread-large-history-fixture",
  cwd = "C:\\fixture\\allowed-repository",
  turnCount = 32,
  oversizedSingleItem = false,
  oversizedItemBytes = DEFAULT_OVERSIZED_ITEM_BYTES,
  includeInterruptedTail = true,
} = {}) {
  assertTargetSize(targetTranscriptBytes);
  if (!Number.isSafeInteger(turnCount) || turnCount < 3) {
    throw new RangeError("turnCount must be an integer of at least 3.");
  }

  const completedTurns = Array.from({ length: turnCount }, (_, index) =>
    makeCompletedTurn(index, turnCount),
  );
  const payloadItems = completedTurns.map((turn) => turn.items[1]);

  if (oversizedSingleItem) {
    payloadItems[0].text = exactUtf8Text(
      oversizedItemBytes,
      `Oversized canonical record: ${UNICODE_MARKERS.join(" | ")}\n`,
    );
  }

  const turns = includeInterruptedTail
    ? [...completedTurns, makeInterruptedTail(completedTurns.length)]
    : completedTurns;
  const baselineBytes = canonicalTranscriptBytes(turns).length;
  if (baselineBytes > targetTranscriptBytes) {
    throw new RangeError(
      `Fixture metadata requires ${baselineBytes} bytes, exceeding target ${targetTranscriptBytes}.`,
    );
  }

  let remaining = targetTranscriptBytes - baselineBytes;
  const distributableItems = oversizedSingleItem
    ? payloadItems.slice(1)
    : payloadItems;
  if (distributableItems.length === 0 && remaining > 0) {
    throw new RangeError("No payload item is available for deterministic padding.");
  }
  for (let index = 0; index < distributableItems.length; index += 1) {
    const slots = distributableItems.length - index;
    const bytes = Math.floor(remaining / slots);
    appendAsciiBytes(distributableItems[index], bytes);
    remaining -= bytes;
  }
  assert.equal(remaining, 0);

  const thread = {
    id: threadId,
    sessionId: threadId,
    cwd,
    status: { type: "idle" },
    createdAt: 1_800_000_000,
    updatedAt: 1_800_000_000 + turns.length * 2,
    turns,
  };
  const canonical = canonicalTranscriptBytes(thread);
  assert.equal(canonical.length, targetTranscriptBytes);
  assertUniqueOrderedTranscript(thread);

  const newestFinal = findNewestFinalAssistant(thread);
  assert.equal(newestFinal?.text, NEWEST_FINAL_TEXT);

  if (oversizedSingleItem) {
    assert.ok(
      Buffer.byteLength(payloadItems[0].text, "utf8") >= oversizedItemBytes,
    );
  }

  return {
    thread,
    turns,
    canonical,
    canonicalSha256: sha256(canonical),
    transcriptBytes: canonical.length,
    newestFinal,
    oversizedItem: oversizedSingleItem ? payloadItems[0] : null,
  };
}

export function createOverTwoMiBThreadFixture(options = {}) {
  return createLargeThreadFixture({
    ...options,
    targetTranscriptBytes:
      options.targetTranscriptBytes ?? OVER_TWO_MIB_TRANSCRIPT_BYTES,
  });
}

export function createRepresentativeHistoryFixture(options = {}) {
  return createLargeThreadFixture({
    ...options,
    targetTranscriptBytes:
      options.targetTranscriptBytes ?? REPRESENTATIVE_HISTORY_BYTES,
  });
}

export function canonicalTranscriptBytes(threadOrTurns) {
  return Buffer.from(canonicalJson(turnsFrom(threadOrTurns)), "utf8");
}

export function canonicalTranscriptSha256(threadOrTurns) {
  return sha256(canonicalTranscriptBytes(threadOrTurns));
}

export function findNewestFinalAssistant(threadOrTurns) {
  const turns = turnsFrom(threadOrTurns);
  let newest = null;
  for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
    const turn = turns[turnIndex];
    if (statusType(turn?.status) !== "completed") {
      continue;
    }
    const items = Array.isArray(turn?.items) ? turn.items : [];
    for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
      const item = items[itemIndex];
      if (
        item?.type !== "agentMessage" ||
        item?.phase !== "final_answer" ||
        statusType(item?.status) !== "completed" ||
        typeof item?.text !== "string" ||
        item.text.trim().length === 0
      ) {
        continue;
      }
      newest = {
        text: item.text,
        turnId: turn.id,
        itemId: item.id,
        turnIndex,
        itemIndex,
      };
    }
  }
  return newest;
}

export function transcriptIdentities(threadOrTurns) {
  const turns = turnsFrom(threadOrTurns);
  return turns.map((turn, turnIndex) => ({
    turnIndex,
    turnId: turn?.id ?? null,
    itemIds: (Array.isArray(turn?.items) ? turn.items : []).map(
      (item) => item?.id ?? null,
    ),
  }));
}

export function assertUniqueOrderedTranscript(threadOrTurns) {
  const turns = turnsFrom(threadOrTurns);
  const turnIds = new Set();
  const itemIds = new Set();
  for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
    const turn = turns[turnIndex];
    assert.equal(turn?.ordinal, turnIndex);
    assert.equal(typeof turn?.id, "string");
    assert.equal(turnIds.has(turn.id), false, `duplicate turn id ${turn.id}`);
    turnIds.add(turn.id);

    const items = Array.isArray(turn?.items) ? turn.items : [];
    for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
      const item = items[itemIndex];
      assert.equal(item?.ordinal, itemIndex);
      assert.equal(typeof item?.id, "string");
      assert.equal(itemIds.has(item.id), false, `duplicate item id ${item.id}`);
      itemIds.add(item.id);
    }
  }
  return {
    turnCount: turns.length,
    itemCount: itemIds.size,
  };
}

export function fragmentCanonicalTranscript(threadOrTurns, { fragmentBytes = 64 * 1024 } = {}) {
  if (!Number.isSafeInteger(fragmentBytes) || fragmentBytes <= 0) {
    throw new RangeError("fragmentBytes must be a positive integer.");
  }
  const canonical = canonicalTranscriptBytes(threadOrTurns);
  const digest = sha256(canonical);
  const fragments = [];
  for (let byteStart = 0; byteStart < canonical.length; byteStart += fragmentBytes) {
    const byteEnd = Math.min(canonical.length, byteStart + fragmentBytes);
    fragments.push({
      encoding: "base64url-json",
      byteStart,
      byteEnd,
      totalBytes: canonical.length,
      sha256: digest,
      data: canonical.subarray(byteStart, byteEnd).toString("base64url"),
    });
  }
  return {
    fragments,
    totalBytes: canonical.length,
    sha256: digest,
  };
}

export function reconstructCanonicalTranscript(fragments) {
  assert.ok(Array.isArray(fragments) && fragments.length > 0);
  const first = fragments[0];
  const expectedTotal = first.totalBytes;
  const expectedDigest = first.sha256;
  let expectedStart = 0;
  const decoded = [];

  for (const fragment of fragments) {
    assert.equal(fragment.encoding, "base64url-json");
    assert.equal(fragment.totalBytes, expectedTotal);
    assert.equal(fragment.sha256, expectedDigest);
    assert.equal(fragment.byteStart, expectedStart);
    const bytes = Buffer.from(fragment.data, "base64url");
    assert.equal(fragment.byteEnd, fragment.byteStart + bytes.length);
    decoded.push(bytes);
    expectedStart = fragment.byteEnd;
  }

  assert.equal(expectedStart, expectedTotal);
  const canonical = Buffer.concat(decoded);
  assert.equal(canonical.length, expectedTotal);
  assert.equal(sha256(canonical), expectedDigest);
  return {
    canonical,
    turns: JSON.parse(canonical.toString("utf8")),
    totalBytes: canonical.length,
    sha256: expectedDigest,
  };
}

export function assertExactTranscriptReconstruction(expected, actual) {
  const expectedTurns = turnsFrom(expected);
  const actualTurns = turnsFrom(actual);
  assert.deepEqual(actualTurns, expectedTurns);
  assert.equal(
    canonicalTranscriptSha256(actualTurns),
    canonicalTranscriptSha256(expectedTurns),
  );
  assert.deepEqual(
    transcriptIdentities(actualTurns),
    transcriptIdentities(expectedTurns),
  );
  assertUniqueOrderedTranscript(actualTurns);
  assert.deepEqual(
    findNewestFinalAssistant(actualTurns),
    findNewestFinalAssistant(expectedTurns),
  );
  return {
    transcriptBytes: canonicalTranscriptBytes(actualTurns).length,
    sha256: canonicalTranscriptSha256(actualTurns),
    newestFinal: findNewestFinalAssistant(actualTurns),
  };
}
