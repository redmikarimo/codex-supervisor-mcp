import { createHash } from "node:crypto";

export const MAX_RECONCILED_AGENT_TEXT = 200_000;

function statusType(value) {
  if (typeof value === "string") {
    return value;
  }
  return typeof value?.type === "string" ? value.type : null;
}

function hashField(hash, value) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    encoded = JSON.stringify(String(value));
  }
  if (encoded === undefined) {
    encoded = "undefined";
  }
  hash.update(String(Buffer.byteLength(encoded, "utf8")));
  hash.update(":");
  hash.update(encoded);
  hash.update(";");
}

function isCompleteAgentMessage(item) {
  if (
    item?.type !== "agentMessage" ||
    typeof item.text !== "string" ||
    item.text.trim().length === 0
  ) {
    return false;
  }

  const phase = item.phase ?? null;
  if (phase !== null && phase !== "final_answer") {
    return false;
  }

  const itemStatus = statusType(item.status);
  return itemStatus === null || itemStatus === "completed";
}

export function fingerprintAgentMessage(text) {
  return createHash("sha256")
    .update(normalizeAgentMessageText(text), "utf8")
    .digest("hex");
}

export function normalizeAgentMessageText(text) {
  return typeof text === "string"
    ? text.slice(-MAX_RECONCILED_AGENT_TEXT)
    : "";
}

export function fingerprintPersistedThread(thread) {
  const hash = createHash("sha256");
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];

  hashField(hash, thread?.id ?? null);
  hashField(hash, thread?.updatedAt ?? null);
  hashField(hash, thread?.recencyAt ?? null);
  hashField(hash, thread?.eventCursor ?? thread?.cursor ?? null);
  hashField(hash, statusType(thread?.status));
  hashField(hash, turns.length);

  for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
    const turn = turns[turnIndex];
    const items = Array.isArray(turn?.items) ? turn.items : [];
    hashField(hash, turnIndex);
    hashField(hash, turn?.id ?? null);
    hashField(hash, statusType(turn?.status));
    hashField(hash, turn?.startedAt ?? null);
    hashField(hash, turn?.completedAt ?? null);
    hashField(hash, items.length);

    for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
      const item = items[itemIndex];
      hashField(hash, itemIndex);
      hashField(hash, item?.type ?? null);
      hashField(hash, item?.id ?? null);
      hashField(hash, item?.phase ?? null);
      hashField(hash, statusType(item?.status));
      if (item?.type === "agentMessage") {
        hashField(hash, typeof item.text === "string" ? item.text : null);
      }
    }
  }

  return hash.digest("hex");
}

export function inspectPersistedThread(thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  let latestAgentMessage = null;

  for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
    const turn = turns[turnIndex];
    if (statusType(turn?.status) !== "completed") {
      continue;
    }

    const turnId = turn?.id ?? null;

    const items = Array.isArray(turn?.items) ? turn.items : [];
    for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
      const item = items[itemIndex];
      if (!isCompleteAgentMessage(item)) {
        continue;
      }

      const text = normalizeAgentMessageText(item.text);
      latestAgentMessage = {
        text,
        turnId,
        itemId: item.id ?? null,
        turnIndex,
        itemIndex,
        phase: item.phase ?? null,
        completedAt: turn?.completedAt ?? null,
      };
    }
  }

  return {
    latestAgentMessage,
  };
}

export function isPersistedTurnCompleted(thread, turnId) {
  if (turnId === null || turnId === undefined) {
    return false;
  }

  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  return turns.some(
    (turn) => turn?.id === turnId && statusType(turn?.status) === "completed",
  );
}

export function containsCompletedAgentMessage(thread, { turnId = null, text } = {}) {
  const normalizedText = normalizeAgentMessageText(text);
  if (!normalizedText) {
    return false;
  }

  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  for (const turn of turns) {
    if (
      statusType(turn?.status) !== "completed" ||
      (turnId !== null && turn?.id !== turnId)
    ) {
      continue;
    }

    const items = Array.isArray(turn?.items) ? turn.items : [];
    for (const item of items) {
      if (
        isCompleteAgentMessage(item) &&
        normalizeAgentMessageText(item.text) === normalizedText
      ) {
        return true;
      }
    }
  }

  return false;
}

export function selectLatestPersistedAgentMessage(thread) {
  return inspectPersistedThread(thread).latestAgentMessage;
}

export class PersistedThreadStatusCache {
  constructor({ maxEntries = 256 } = {}) {
    const resolvedMaxEntries = Number.isInteger(maxEntries) ? maxEntries : 256;
    this.maxEntries = Math.max(1, Math.min(resolvedMaxEntries, 1_000));
    this.entries = new Map();
  }

  reconcile(thread) {
    const threadId = thread?.id;
    const fingerprint = fingerprintPersistedThread(thread);
    const cached = threadId ? this.entries.get(threadId) : null;
    if (cached?.fingerprint === fingerprint) {
      this.entries.delete(threadId);
      this.entries.set(threadId, cached);
      return { ...cached, changed: false };
    }

    const inspected = inspectPersistedThread(thread);
    const entry = {
      fingerprint,
      ...inspected,
    };
    if (threadId) {
      this.entries.delete(threadId);
      this.entries.set(threadId, entry);
      while (this.entries.size > this.maxEntries) {
        this.entries.delete(this.entries.keys().next().value);
      }
    }
    return { ...entry, changed: true };
  }

  delete(threadId) {
    this.entries.delete(threadId);
  }

  clear() {
    this.entries.clear();
  }
}
