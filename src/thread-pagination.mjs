import { createHash, timingSafeEqual } from "node:crypto";

import { ValidationError } from "./errors.mjs";
import {
  containsCompletedAgentMessage,
  inspectPersistedThread,
} from "./thread-transcript.mjs";
import { measureToolResultEnvelopeBytes } from "./tool-result.mjs";

export const MIN_THREAD_PAGE_BYTES = 16_384;
export const MAX_THREAD_PAGE_BYTES = 1_500_000;
export const DEFAULT_THREAD_PAGE_BYTES = MAX_THREAD_PAGE_BYTES;
export const TOOL_RESULT_BYTE_BASIS = "modern-complete-mcp-envelope";

const CURSOR_VERSION = 1;
// Native full-item listing must materialize at least one turn before an oversized
// turn can be fragmented. Keep the speculative batch deliberately small so the
// app-server never has to build a history-sized intermediate response.
const INITIAL_TURN_LIMIT = 4;
const STATUS_TURN_LIMIT = 16;
const CURSOR_PATTERN = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/;

function sha256(value, encoding = "hex") {
  return createHash("sha256").update(value).digest(encoding);
}

function compactThread(thread) {
  if (!thread || typeof thread !== "object") {
    return thread;
  }
  const { turns: _turns, ...metadata } = thread;
  return metadata;
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "null" : encoded;
}

function comparableTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.abs(value) < 100_000_000_000 ? value * 1_000 : value;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return Math.abs(numeric) < 100_000_000_000 ? numeric * 1_000 : numeric;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function uuidV7Timestamp(value) {
  const match = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.exec(
    value ?? "",
  );
  return match ? Number.parseInt(`${match[1]}${match[2]}`, 16) : null;
}

function isStrictlyOlderThanWindow(liveRecord, oldestTurn) {
  const liveStartedAt = comparableTimestamp(liveRecord?.turnStartedAt);
  const oldestStartedAt = comparableTimestamp(oldestTurn?.startedAt);
  if (liveStartedAt !== null && oldestStartedAt !== null) {
    return liveStartedAt < oldestStartedAt;
  }
  const liveIdTime = uuidV7Timestamp(liveRecord?.turnId);
  const oldestIdTime = uuidV7Timestamp(oldestTurn?.id);
  return (
    liveIdTime !== null &&
    oldestIdTime !== null &&
    liveIdTime < oldestIdTime
  );
}

function cursorDigest(encodedPayload) {
  return sha256(Buffer.from(encodedPayload, "utf8"), "base64url");
}

function encodeCursor(state) {
  const encodedPayload = Buffer.from(stableJson(state), "utf8").toString("base64url");
  return `v1.${encodedPayload}.${cursorDigest(encodedPayload)}`;
}

function invalidCursor(message = "cursor is malformed or unsupported.") {
  throw new ValidationError(message);
}

function decodeCursor(cursor) {
  const match = CURSOR_PATTERN.exec(cursor ?? "");
  if (!match) {
    return invalidCursor();
  }

  const [, encodedPayload, providedDigest] = match;
  const expectedDigest = cursorDigest(encodedPayload);
  const provided = Buffer.from(providedDigest, "utf8");
  const expected = Buffer.from(expectedDigest, "utf8");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return invalidCursor();
  }

  let state;
  try {
    const decoded = Buffer.from(encodedPayload, "base64url");
    if (decoded.toString("base64url") !== encodedPayload) {
      return invalidCursor();
    }
    state = JSON.parse(decoded.toString("utf8"));
  } catch {
    return invalidCursor();
  }

  const allowedKeys = new Set([
    "v",
    "threadId",
    "snapshotId",
    "maxBytes",
    "nativeCursor",
    "turnIndex",
    "fragment",
  ]);
  if (
    !state ||
    typeof state !== "object" ||
    Array.isArray(state) ||
    Object.keys(state).some((key) => !allowedKeys.has(key)) ||
    state.v !== CURSOR_VERSION ||
    typeof state.threadId !== "string" ||
    typeof state.snapshotId !== "string" ||
    !Number.isInteger(state.maxBytes) ||
    state.maxBytes < MIN_THREAD_PAGE_BYTES ||
    state.maxBytes > MAX_THREAD_PAGE_BYTES ||
    (state.nativeCursor !== null && typeof state.nativeCursor !== "string") ||
    !Number.isInteger(state.turnIndex) ||
    state.turnIndex < 0 ||
    (state.fragment !== null &&
      (!state.fragment ||
        typeof state.fragment !== "object" ||
        Array.isArray(state.fragment) ||
        Object.keys(state.fragment).some(
          (key) =>
            !["turnId", "offset", "totalBytes", "sha256", "afterCursor"].includes(key),
        ) ||
        typeof state.fragment.turnId !== "string" ||
        !Number.isInteger(state.fragment.offset) ||
        state.fragment.offset < 0 ||
        !Number.isInteger(state.fragment.totalBytes) ||
        state.fragment.totalBytes <= 0 ||
        state.fragment.offset >= state.fragment.totalBytes ||
        !/^[a-f0-9]{64}$/.test(state.fragment.sha256 ?? "") ||
        (state.fragment.afterCursor !== null &&
          typeof state.fragment.afterCursor !== "string")))
  ) {
    return invalidCursor();
  }
  return state;
}

function validateRequestedMaxBytes(value) {
  const resolved = value ?? DEFAULT_THREAD_PAGE_BYTES;
  if (
    !Number.isInteger(resolved) ||
    resolved < MIN_THREAD_PAGE_BYTES ||
    resolved > MAX_THREAD_PAGE_BYTES
  ) {
    throw new ValidationError(
      `maxBytes must be between ${MIN_THREAD_PAGE_BYTES} and ${MAX_THREAD_PAGE_BYTES}.`,
    );
  }
  return resolved;
}

async function readSnapshot(appServerClient, thread) {
  const threadId = thread?.id;
  const turnResult = await appServerClient.request("thread/turns/list", {
    threadId,
    limit: 1,
    sortDirection: "desc",
    itemsView: "full",
  });
  const head = Array.isArray(turnResult?.data) ? turnResult.data[0] ?? null : null;
  const snapshotPayload = {
    threadId,
    head,
    threadUpdatedAt: thread?.updatedAt ?? null,
    threadRecencyAt: thread?.recencyAt ?? null,
    turnsBackwardsCursor: turnResult?.backwardsCursor ?? null,
    turnsNextCursor: turnResult?.nextCursor ?? null,
  };
  return {
    version: CURSOR_VERSION,
    id: sha256(Buffer.from(stableJson(snapshotPayload), "utf8")),
    threadId,
    headTurnId: head?.id ?? null,
  };
}

async function assertSnapshot(appServerClient, thread, expected) {
  const current = await readSnapshot(appServerClient, thread);
  if (current.id !== expected.id) {
    throw new ValidationError(
      "cursor is stale because the persisted transcript changed; restart pagination without a cursor.",
    );
  }
}

function finalizeMeasured(output, measureEnvelope = measureToolResultEnvelopeBytes) {
  let previous = -1;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const measured = measureEnvelope(output, { isModern: true });
    if (measured === previous && output.responseBytes === measured) {
      return measured;
    }
    previous = measured;
    output.responseBytes = measured;
  }
  return measureEnvelope(output, { isModern: true });
}

function pageOutput({
  responseBase,
  thread,
  turns,
  snapshot,
  maxBytes,
  startTurnIndex,
  hasMore,
  nextCursor,
  turnFragment = undefined,
}) {
  const fragmentCompleted =
    Boolean(turnFragment) && turnFragment.byteEnd === turnFragment.totalBytes;
  const endTurnIndex =
    startTurnIndex + turns.length + (fragmentCompleted ? 1 : 0);
  const output = {
    ...responseBase,
    thread: {
      ...compactThread(thread),
      turns,
    },
    hasMore,
    nextCursor,
    snapshot,
    range: {
      order: "chronological",
      startTurnIndex,
      endTurnIndex,
      completeTurnCount: turns.length,
      ...(turnFragment ? { fragmentTurnIndex: turnFragment.turnIndex } : {}),
    },
    maxBytes,
    responseByteBasis: TOOL_RESULT_BYTE_BASIS,
    responseBytes: 0,
    ...(turnFragment ? { turnFragment } : {}),
  };
  finalizeMeasured(output);
  return output;
}

function nextState(state, changes) {
  return {
    v: CURSOR_VERSION,
    threadId: state.threadId,
    snapshotId: state.snapshotId,
    maxBytes: state.maxBytes,
    nativeCursor: state.nativeCursor,
    turnIndex: state.turnIndex,
    fragment: null,
    ...changes,
  };
}

function continuationCursor(state, hasMore) {
  return hasMore ? encodeCursor(state) : null;
}

function fragmentMetadata(turn, turnIndex, bytes, byteStart, byteEnd) {
  return {
    encoding: "base64url-json-utf8",
    turnIndex,
    turnId: turn?.id ?? null,
    byteStart,
    byteEnd,
    totalBytes: bytes.length,
    sha256: sha256(bytes),
    data: bytes.subarray(byteStart, byteEnd).toString("base64url"),
  };
}

function fragmentPage({
  responseBase,
  thread,
  snapshot,
  state,
  turn,
  afterCursor,
}) {
  const bytes = Buffer.from(JSON.stringify(turn), "utf8");
  const digest = sha256(bytes);
  const stored = state.fragment;
  if (
    stored &&
    (stored.turnId !== (turn?.id ?? null) ||
      stored.totalBytes !== bytes.length ||
      stored.sha256 !== digest ||
      stored.afterCursor !== afterCursor)
  ) {
    throw new ValidationError(
      "cursor is stale because the paged turn changed; restart pagination without a cursor.",
    );
  }
  const byteStart = stored?.offset ?? 0;
  if (byteStart >= bytes.length) {
    return invalidCursor();
  }

  let low = byteStart + 1;
  let high = bytes.length;
  let best = null;
  while (low <= high) {
    const byteEnd = Math.floor((low + high) / 2);
    const fragment = fragmentMetadata(turn, state.turnIndex, bytes, byteStart, byteEnd);
    const fragmentDone = byteEnd === bytes.length;
    const hasMore = !fragmentDone || afterCursor !== null;
    const stateAfter = fragmentDone
      ? nextState(state, {
          nativeCursor: afterCursor,
          turnIndex: state.turnIndex + 1,
          fragment: null,
        })
      : nextState(state, {
          fragment: {
            turnId: turn?.id ?? null,
            offset: byteEnd,
            totalBytes: bytes.length,
            sha256: digest,
            afterCursor,
          },
        });
    const output = pageOutput({
      responseBase,
      thread,
      turns: [],
      snapshot,
      maxBytes: state.maxBytes,
      startTurnIndex: state.turnIndex,
      hasMore,
      nextCursor: continuationCursor(stateAfter, hasMore),
      turnFragment: fragment,
    });
    if (output.responseBytes <= state.maxBytes) {
      best = output;
      low = byteEnd + 1;
    } else {
      high = byteEnd - 1;
    }
  }

  if (!best) {
    throw new ValidationError(
      `maxBytes ${state.maxBytes} is too small for the bounded thread page metadata.`,
    );
  }
  return best;
}

export async function readThreadPage({
  appServerClient,
  thread,
  cursor = undefined,
  maxBytes = undefined,
  responseBase = {},
}) {
  const threadId = thread?.id;
  if (!threadId) {
    throw new ValidationError("A matching persisted thread is required for pagination.");
  }

  const suppliedState = cursor === undefined ? null : decodeCursor(cursor);
  if (suppliedState && suppliedState.threadId !== threadId) {
    throw new ValidationError("cursor belongs to a different thread.");
  }
  if (
    suppliedState &&
    maxBytes !== undefined &&
    maxBytes !== suppliedState.maxBytes
  ) {
    throw new ValidationError("maxBytes must match the value bound into cursor.");
  }

  const budget = suppliedState?.maxBytes ?? validateRequestedMaxBytes(maxBytes);
  const snapshot = await readSnapshot(appServerClient, thread);
  if (suppliedState && suppliedState.snapshotId !== snapshot.id) {
    throw new ValidationError(
      "cursor is stale because the persisted transcript changed; restart pagination without a cursor.",
    );
  }
  const state =
    suppliedState ??
    {
      v: CURSOR_VERSION,
      threadId,
      snapshotId: snapshot.id,
      maxBytes: budget,
      nativeCursor: null,
      turnIndex: 0,
      fragment: null,
    };

  let limit = state.fragment ? 1 : INITIAL_TURN_LIMIT;
  while (true) {
    const result = await appServerClient.request("thread/turns/list", {
      threadId,
      ...(state.nativeCursor === null ? {} : { cursor: state.nativeCursor }),
      limit,
      sortDirection: "asc",
      itemsView: "full",
    });
    const turns = Array.isArray(result?.data) ? result.data : [];
    const nativeNextCursor = result?.nextCursor ?? null;

    if (turns.length === 0) {
      if (nativeNextCursor !== null || state.fragment) {
        throw new ValidationError("The app-server returned an inconsistent turn page.");
      }
      const output = pageOutput({
        responseBase,
        thread,
        turns: [],
        snapshot,
        maxBytes: budget,
        startTurnIndex: state.turnIndex,
        hasMore: false,
        nextCursor: null,
      });
      if (output.responseBytes > budget) {
        throw new ValidationError(`maxBytes ${budget} is too small for thread metadata.`);
      }
      await assertSnapshot(appServerClient, thread, snapshot);
      return output;
    }

    if (turns.length === 1 && (limit === 1 || state.fragment)) {
      const output = fragmentPage({
        responseBase,
        thread,
        snapshot,
        state,
        turn: turns[0],
        afterCursor: nativeNextCursor,
      });
      const wholeTurnCandidate = state.fragment
        ? null
        : pageOutput({
            responseBase,
            thread,
            turns,
            snapshot,
            maxBytes: budget,
            startTurnIndex: state.turnIndex,
            hasMore: nativeNextCursor !== null,
            nextCursor: continuationCursor(
              nextState(state, {
                nativeCursor: nativeNextCursor,
                turnIndex: state.turnIndex + 1,
              }),
              nativeNextCursor !== null,
            ),
          });
      const selected = wholeTurnCandidate?.responseBytes <= budget ? wholeTurnCandidate : output;
      await assertSnapshot(appServerClient, thread, snapshot);
      return selected;
    }

    const hasMore = nativeNextCursor !== null;
    const stateAfter = nextState(state, {
      nativeCursor: nativeNextCursor,
      turnIndex: state.turnIndex + turns.length,
    });
    const output = pageOutput({
      responseBase,
      thread,
      turns,
      snapshot,
      maxBytes: budget,
      startTurnIndex: state.turnIndex,
      hasMore,
      nextCursor: continuationCursor(stateAfter, hasMore),
    });
    if (output.responseBytes <= budget) {
      await assertSnapshot(appServerClient, thread, snapshot);
      return output;
    }

    limit = Math.max(1, Math.floor(Math.min(limit, turns.length) / 2));
  }
}

export async function readPersistedStatus({
  appServerClient,
  thread,
  liveRecord = null,
  activeTurnId = null,
}) {
  const threadId = thread?.id;
  if (!threadId) {
    throw new ValidationError("A matching persisted thread is required for status.");
  }
  let latestAgentMessage = null;
  let liveRepresented = !liveRecord?.complete || !liveRecord?.text;
  let activeTurnTerminal = activeTurnId === null;
  let activeTurnFound = activeTurnId === null;
  let liveTurnFound = liveRepresented || typeof liveRecord?.turnId !== "string";
  let metadataCursor = null;
  let exhausted = false;
  const turns = [];
  const seenTurnIds = new Set();
  let inspectedItemCount = 0;
  const hydratedTurnIds = new Set();

  const hydrateTurn = async (turn, backwardsCursor) => {
    if (typeof backwardsCursor !== "string" || backwardsCursor.length === 0) {
      throw new ValidationError(
        `The app-server did not return an anchor for completed turn ${turn.id}.`,
      );
    }
    const fullResult = await appServerClient.request("thread/turns/list", {
      threadId,
      cursor: backwardsCursor,
      limit: 1,
      sortDirection: "asc",
      itemsView: "full",
    });
    const fullTurns = Array.isArray(fullResult?.data) ? fullResult.data : [];
    if (fullTurns.length !== 1 || fullTurns[0]?.id !== turn.id) {
      throw new ValidationError(
        `The app-server returned a mismatched full turn for status anchor ${turn.id}.`,
      );
    }
    hydratedTurnIds.add(turn.id);
    inspectedItemCount += Array.isArray(fullTurns[0]?.items)
      ? fullTurns[0].items.length
      : 0;
    return fullTurns[0];
  };

  for (let index = 0; index < STATUS_TURN_LIMIT; index += 1) {
    const turnResult = await appServerClient.request("thread/turns/list", {
      threadId,
      ...(metadataCursor === null ? {} : { cursor: metadataCursor }),
      limit: 1,
      sortDirection: "desc",
      itemsView: "notLoaded",
    });
    const page = Array.isArray(turnResult?.data) ? turnResult.data : [];
    if (page.length === 0) {
      if (turnResult?.nextCursor != null) {
        throw new ValidationError("The app-server returned an inconsistent status page.");
      }
      exhausted = true;
      break;
    }
    if (page.length !== 1 || typeof page[0]?.id !== "string") {
      throw new ValidationError("The app-server returned an invalid bounded status turn.");
    }
    const turn = page[0];
    if (seenTurnIds.has(turn.id)) {
      throw new ValidationError("The app-server repeated a turn during bounded status traversal.");
    }
    seenTurnIds.add(turn.id);
    turns.push(turn);

    const turnStatus =
      typeof turn?.status === "string" ? turn.status : turn?.status?.type;
    if (turn.id === activeTurnId) {
      activeTurnFound = true;
      activeTurnTerminal = ["completed", "interrupted", "failed"].includes(
        turnStatus,
      );
    }

    const exactLiveTurn = turn.id === liveRecord?.turnId;
    if (exactLiveTurn) {
      liveTurnFound = true;
      if (!liveRepresented && ["interrupted", "failed"].includes(turnStatus)) {
        // A completed item notification is not a valid final when authoritative
        // turn metadata says that its turn did not complete successfully.
        liveRepresented = true;
      }
    }

    if (
      turnStatus === "completed" &&
      (!latestAgentMessage || (exactLiveTurn && !liveRepresented))
    ) {
      const fullTurn = await hydrateTurn(turn, turnResult?.backwardsCursor);
      const inspected = inspectPersistedThread({ id: threadId, turns: [fullTurn] });
      if (!latestAgentMessage && inspected.latestAgentMessage) {
        latestAgentMessage = inspected.latestAgentMessage;
      }
      if (!liveRepresented && exactLiveTurn) {
        liveRepresented = containsCompletedAgentMessage(
          { id: threadId, turns: [fullTurn] },
          liveRecord,
        ) || Boolean(inspected.latestAgentMessage);
        if (
          !liveRepresented &&
          latestAgentMessage &&
          latestAgentMessage.turnId !== turn.id
        ) {
          liveRepresented = true;
        }
      }
    }

    metadataCursor = turnResult?.nextCursor ?? null;
    exhausted = metadataCursor === null;
    const activeResolved = activeTurnId === null || activeTurnFound;
    const liveResolved = liveRepresented || liveTurnFound;
    if (latestAgentMessage && activeResolved && liveResolved) {
      break;
    }
    if (exhausted) {
      break;
    }
  }

  if (!liveRepresented && !liveTurnFound && latestAgentMessage) {
    const liveTurnId = liveRecord?.turnId;
    const absentButAuthoritativelyOlder =
      typeof liveTurnId === "string" &&
      liveTurnId !== activeTurnId &&
      turns.length === STATUS_TURN_LIMIT &&
      isStrictlyOlderThanWindow(liveRecord, turns.at(-1));
    if (absentButAuthoritativelyOlder) {
      liveRepresented = true;
    }
  }

  return {
    latestAgentMessage,
    liveRepresented,
    activeTurnTerminal,
    inspectedTurnCount: turns.length,
    inspectedItemCount,
    inspectedCompletedTurnCount: hydratedTurnIds.size,
    bounded: true,
  };
}

function utf8Prefix(value, maxBytes) {
  const text = String(value ?? "");
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }
  let low = 0;
  let high = text.length;
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = text.slice(0, middle);
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function utf8Tail(value, maxBytes) {
  const text = String(value ?? "");
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }
  let low = 0;
  let high = text.length;
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = text.slice(text.length - middle);
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function compactStatusValue(value, maxPreviewBytes = 16_384) {
  const serialized = JSON.stringify(value) ?? "null";
  return {
    truncated: true,
    originalBytes: Buffer.byteLength(serialized, "utf8"),
    preview: utf8Prefix(serialized, maxPreviewBytes),
  };
}

function compactPendingRequest(request) {
  const serialized = JSON.stringify(request) ?? "null";
  return {
    requestKey: request?.requestKey ?? null,
    requestId: request?.requestId ?? null,
    method: request?.method ?? null,
    threadId: request?.threadId ?? null,
    turnId: request?.turnId ?? null,
    receivedAt: request?.receivedAt ?? null,
    params: {
      truncated: true,
      originalBytes: Buffer.byteLength(serialized, "utf8"),
      ...(Array.isArray(request?.params?.availableDecisions)
        ? { availableDecisions: request.params.availableDecisions }
        : {}),
      preview: utf8Prefix(JSON.stringify(request?.params ?? null), 4_096),
    },
  };
}

function pendingRequestIdentity(request) {
  return {
    requestKey: request?.requestKey ?? null,
    requestId: request?.requestId ?? null,
    method: request?.method ?? null,
    threadId: request?.threadId ?? null,
    turnId: request?.turnId ?? null,
    receivedAt: request?.receivedAt ?? null,
    params: {
      truncated: true,
      ...(Array.isArray(request?.params?.availableDecisions)
        ? { availableDecisions: request.params.availableDecisions }
        : {}),
    },
  };
}

export function boundStatusResult(
  output,
  maxBytes = MAX_THREAD_PAGE_BYTES,
  { measureEnvelope = measureToolResultEnvelopeBytes } = {},
) {
  const bounded = {
    ...output,
    events: Array.isArray(output?.events) ? [...output.events] : [],
    responseByteBasis: TOOL_RESULT_BYTE_BASIS,
    responseBytes: 0,
  };
  const originalEventCount = bounded.events.length;
  finalizeMeasured(bounded, measureEnvelope);
  if (bounded.responseBytes > maxBytes && originalEventCount > 0) {
    const originalEvents = bounded.events;
    let low = 0;
    let high = originalEventCount;
    let retained = 0;
    while (low <= high) {
      const candidate = Math.floor((low + high) / 2);
      bounded.events = originalEvents.slice(originalEventCount - candidate);
      bounded.eventsTruncated = originalEventCount - candidate;
      finalizeMeasured(bounded, measureEnvelope);
      if (bounded.responseBytes <= maxBytes) {
        retained = candidate;
        low = candidate + 1;
      } else {
        high = candidate - 1;
      }
    }
    bounded.events = originalEvents.slice(originalEventCount - retained);
    bounded.eventsTruncated = originalEventCount - retained;
    finalizeMeasured(bounded, measureEnvelope);
  }

  if (bounded.responseBytes > maxBytes && Array.isArray(bounded.pendingRequests)) {
    let compacted = 0;
    bounded.pendingRequests = bounded.pendingRequests.map((request) => {
      const serializedBytes = Buffer.byteLength(JSON.stringify(request) ?? "null", "utf8");
      if (serializedBytes <= 8_192) {
        return request;
      }
      compacted += 1;
      return compactPendingRequest(request);
    });
    if (compacted > 0) {
      bounded.pendingRequestDetailsTruncated = compacted;
      finalizeMeasured(bounded, measureEnvelope);
    }
  }


  if (
    bounded.responseBytes > maxBytes &&
    Array.isArray(bounded.pendingRequests) &&
    bounded.pendingRequests.length > 0
  ) {
    bounded.pendingRequests = bounded.pendingRequests.map(pendingRequestIdentity);
    bounded.pendingRequestDetailsTruncated = bounded.pendingRequests.length;
    finalizeMeasured(bounded, measureEnvelope);
  }

  for (const [field, metadataField] of [
    ["latestDiff", "latestDiffTruncated"],
    ["latestError", "latestErrorTruncated"],
  ]) {
    if (bounded.responseBytes <= maxBytes || bounded[field] == null) {
      continue;
    }
    const compacted = compactStatusValue(bounded[field]);
    bounded[field] = compacted;
    bounded[metadataField] = {
      originalBytes: compacted.originalBytes,
      previewBytes: Buffer.byteLength(compacted.preview, "utf8"),
    };
    finalizeMeasured(bounded, measureEnvelope);
  }

  if (
    bounded.responseBytes > maxBytes &&
    typeof bounded.latestAgentMessage === "string" &&
    bounded.latestAgentMessage.length > 0
  ) {
    const original = bounded.latestAgentMessage;
    const originalBytes = Buffer.byteLength(original, "utf8");
    let targetBytes = Math.min(originalBytes, Math.max(16_384, Math.floor(maxBytes / 2)));
    while (targetBytes >= 16_384) {
      bounded.latestAgentMessage = utf8Tail(original, targetBytes);
      bounded.latestAgentMessageTruncated = {
        originalBytes,
        returnedBytes: Buffer.byteLength(bounded.latestAgentMessage, "utf8"),
        retained: "tail",
      };
      finalizeMeasured(bounded, measureEnvelope);
      if (bounded.responseBytes <= maxBytes) {
        break;
      }
      targetBytes = Math.floor(targetBytes / 2);
    }
  }
  if (
    bounded.responseBytes > maxBytes &&
    Array.isArray(bounded.pendingRequests) &&
    bounded.pendingRequests.length > 0
  ) {
    const total = bounded.pendingRequests.length;
    let retained = total;
    while (bounded.responseBytes > maxBytes && retained > 0) {
      retained = Math.floor(retained / 2);
      bounded.pendingRequests = bounded.pendingRequests.slice(0, retained);
      bounded.pendingRequestsTotal = total;
      bounded.pendingRequestsReturned = retained;
      bounded.pendingRequestsTruncated = total - retained;
      finalizeMeasured(bounded, measureEnvelope);
    }
  }
  if (bounded.responseBytes > maxBytes) {
    throw new ValidationError(
      `The compact status result is ${bounded.responseBytes} bytes; the maximum is ${maxBytes} bytes.`,
    );
  }
  return bounded;
}
