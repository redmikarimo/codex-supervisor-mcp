import { createHash, randomUUID } from "node:crypto";

export const RESULT_SUBMISSION_PROTOCOL = "base64url-json-chunked-v1";
export const DEFAULT_RESULT_CHUNK_BYTES = 32 * 1024;
export const DEFAULT_MAX_RESULT_BYTES = 2 * 1024 * 1024;
export const MIN_RESULT_BYTES = 4 * 1024;
export const DEFAULT_MAX_RESULT_CHUNKS = 64;
export const DEFAULT_MAX_BUFFERED_RESULT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_RESULT_UPLOADS = 256;
export const DEFAULT_RESULT_UPLOAD_TTL_MS = 2 * 60_000;

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

function sha256(value) {
  return createHash("sha256").update(value).digest("base64url");
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function canonicalBase64url(value) {
  if (typeof value !== "string" || !value || !BASE64URL_PATTERN.test(value)) {
    throw new Error("Result submission data must be canonical base64url text.");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new Error("Result submission data must be canonical base64url text.");
  }
  return decoded;
}

function assertPayloadShape(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Decoded result submission must be a JSON object.");
  }
  const hasResult = Object.prototype.hasOwnProperty.call(payload, "result");
  const hasError = Object.prototype.hasOwnProperty.call(payload, "error");
  if (hasResult === hasError) {
    throw new Error("Decoded result submission must contain exactly one of result or error.");
  }
  return payload;
}

export class ResultTooLargeError extends Error {
  constructor(actualBytes, maxBytes) {
    super(`Tool result is ${actualBytes} bytes; the relay limit is ${maxBytes} bytes.`);
    this.name = "ResultTooLargeError";
    this.actualBytes = actualBytes;
    this.maxBytes = maxBytes;
  }
}

export function resultSubmissionCapabilities({
  maxResultBytes = DEFAULT_MAX_RESULT_BYTES,
  chunkBytes = DEFAULT_RESULT_CHUNK_BYTES,
  maxChunks = DEFAULT_MAX_RESULT_CHUNKS,
} = {}) {
  const boundedResultBytes = Math.min(maxResultBytes, chunkBytes * maxChunks);
  return {
    preferredProtocol: RESULT_SUBMISSION_PROTOCOL,
    supportedProtocols: [RESULT_SUBMISSION_PROTOCOL],
    maxResultBytes: boundedResultBytes,
    chunkBytes,
    maxChunks,
  };
}

export function encodeResultSubmission(payload, {
  maxResultBytes = DEFAULT_MAX_RESULT_BYTES,
  chunkBytes = DEFAULT_RESULT_CHUNK_BYTES,
  maxChunks = DEFAULT_MAX_RESULT_CHUNKS,
  uploadId = randomUUID(),
} = {}) {
  positiveInteger(maxResultBytes, "maxResultBytes");
  positiveInteger(chunkBytes, "chunkBytes");
  positiveInteger(maxChunks, "maxChunks");
  assertPayloadShape(payload);
  if (!OPAQUE_ID_PATTERN.test(uploadId)) {
    throw new Error("uploadId must be an opaque 16-128 character identifier.");
  }

  const serialized = Buffer.from(JSON.stringify(payload), "utf8");
  if (serialized.length > maxResultBytes) {
    throw new ResultTooLargeError(serialized.length, maxResultBytes);
  }
  const chunkCount = Math.ceil(serialized.length / chunkBytes);
  if (chunkCount <= 0 || chunkCount > maxChunks) {
    throw new ResultTooLargeError(serialized.length, Math.min(maxResultBytes, chunkBytes * maxChunks));
  }

  const digest = sha256(serialized);
  const submissions = [];
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const start = chunkIndex * chunkBytes;
    const data = serialized.subarray(start, start + chunkBytes).toString("base64url");
    submissions.push({
      protocol: RESULT_SUBMISSION_PROTOCOL,
      uploadId,
      chunkIndex,
      chunkCount,
      totalBytes: serialized.length,
      sha256: digest,
      data,
    });
  }
  return {
    submissions,
    totalBytes: serialized.length,
    sha256: digest,
  };
}

export class ResultSubmissionAssembler {
  constructor({
    maxResultBytes = DEFAULT_MAX_RESULT_BYTES,
    chunkBytes = DEFAULT_RESULT_CHUNK_BYTES,
    maxChunks = DEFAULT_MAX_RESULT_CHUNKS,
    maxBufferedBytes = DEFAULT_MAX_BUFFERED_RESULT_BYTES,
    maxUploads = DEFAULT_MAX_RESULT_UPLOADS,
    ttlMs = DEFAULT_RESULT_UPLOAD_TTL_MS,
    now = () => Date.now(),
  } = {}) {
    this.maxResultBytes = positiveInteger(maxResultBytes, "maxResultBytes");
    this.chunkBytes = positiveInteger(chunkBytes, "chunkBytes");
    this.maxChunks = positiveInteger(maxChunks, "maxChunks");
    this.maxBufferedBytes = positiveInteger(maxBufferedBytes, "maxBufferedBytes");
    this.maxUploads = positiveInteger(maxUploads, "maxUploads");
    this.ttlMs = positiveInteger(ttlMs, "ttlMs");
    this.now = now;
    this.entries = new Map();
    this.receipts = new Map();
    this.bufferedBytes = 0;
  }

  accept({ jobId, leaseId, submission, assertLease }) {
    this.#reap();
    const decoded = this.#validateSubmission(submission);
    const key = this.#key(jobId, leaseId, submission.uploadId);
    const receipt = this.receipts.get(key);
    if (receipt) {
      const exactFinalRetry =
        submission.chunkIndex === submission.chunkCount - 1 &&
        receipt.chunkCount === submission.chunkCount &&
        receipt.totalBytes === submission.totalBytes &&
        receipt.sha256 === submission.sha256 &&
        receipt.finalChunkSha256 === sha256(decoded);
      if (!exactFinalRetry) {
        throw new Error("Committed result submission metadata does not match.");
      }
      return { complete: true, duplicate: true, committed: true, payload: null };
    }

    if (typeof assertLease !== "function") {
      throw new Error("A current relay job lease is required for result uploads.");
    }
    assertLease();

    let entry = this.entries.get(key);
    if (!entry) {
      if (submission.chunkIndex !== 0) {
        throw new Error("Result chunks must be submitted sequentially.");
      }
      if (this.entries.size >= this.maxUploads) {
        throw new Error("Relay result upload entry limit is full.");
      }
      if (this.bufferedBytes + decoded.length > this.maxBufferedBytes) {
        throw new Error("Relay result upload buffer is full.");
      }
      entry = {
        createdAt: this.now(),
        chunkCount: submission.chunkCount,
        totalBytes: submission.totalBytes,
        sha256: submission.sha256,
        chunks: [],
        nextIndex: 0,
        receivedBytes: 0,
        readyPayload: null,
        finalChunkSha256: null,
      };
      this.entries.set(key, entry);
    } else if (
      entry.chunkCount !== submission.chunkCount ||
      entry.totalBytes !== submission.totalBytes ||
      entry.sha256 !== submission.sha256
    ) {
      throw new Error("Result submission metadata changed during upload.");
    }

    if (submission.chunkIndex < entry.nextIndex) {
      const previous = entry.chunks[submission.chunkIndex];
      if (!previous || !previous.equals(decoded)) {
        throw new Error("A duplicate result chunk conflicts with the accepted chunk.");
      }
      if (entry.readyPayload && submission.chunkIndex === entry.chunkCount - 1) {
        return {
          complete: true,
          duplicate: true,
          committed: false,
          payload: entry.readyPayload,
        };
      }
      return { complete: false, duplicate: true, committed: false, payload: null };
    }
    if (submission.chunkIndex !== entry.nextIndex) {
      throw new Error("Result chunks must be submitted sequentially.");
    }
    if (this.bufferedBytes + decoded.length > this.maxBufferedBytes) {
      throw new Error("Relay result upload buffer is full.");
    }

    entry.chunks.push(decoded);
    entry.nextIndex += 1;
    entry.receivedBytes += decoded.length;
    this.bufferedBytes += decoded.length;

    if (entry.nextIndex < entry.chunkCount) {
      return { complete: false, duplicate: false, committed: false, payload: null };
    }

    try {
      const serialized = Buffer.concat(entry.chunks);
      if (serialized.length !== entry.totalBytes || entry.receivedBytes !== entry.totalBytes) {
        throw new Error("Result submission length does not match its metadata.");
      }
      if (sha256(serialized) !== entry.sha256) {
        throw new Error("Result submission digest does not match its metadata.");
      }

      let payload;
      try {
        payload = JSON.parse(serialized.toString("utf8"));
      } catch {
        throw new Error("Decoded result submission is not valid JSON.");
      }
      assertPayloadShape(payload);
      entry.readyPayload = payload;
      entry.finalChunkSha256 = sha256(decoded);
      return { complete: true, duplicate: false, committed: false, payload };
    } catch (error) {
      this.#deleteEntry(key);
      throw error;
    }
  }

  commit({ jobId, leaseId, uploadId }) {
    const key = this.#key(jobId, leaseId, uploadId);
    const entry = this.entries.get(key);
    if (!entry?.readyPayload || !entry.finalChunkSha256) {
      throw new Error("Result submission is not ready to commit.");
    }
    this.receipts.set(key, {
      expiresAt: this.now() + this.ttlMs,
      chunkCount: entry.chunkCount,
      totalBytes: entry.totalBytes,
      sha256: entry.sha256,
      finalChunkSha256: entry.finalChunkSha256,
    });
    this.#deleteEntry(key);
  }

  #validateSubmission(submission) {
    if (!submission || typeof submission !== "object" || Array.isArray(submission)) {
      throw new Error("Result submission envelope is required.");
    }
    if (submission.protocol !== RESULT_SUBMISSION_PROTOCOL) {
      throw new Error("Unsupported result submission protocol.");
    }
    if (!OPAQUE_ID_PATTERN.test(submission.uploadId ?? "")) {
      throw new Error("Result submission uploadId is invalid.");
    }
    if (!Number.isSafeInteger(submission.chunkIndex) || submission.chunkIndex < 0) {
      throw new Error("Result submission chunkIndex is invalid.");
    }
    if (
      !Number.isSafeInteger(submission.chunkCount) ||
      submission.chunkCount <= 0 ||
      submission.chunkCount > this.maxChunks ||
      submission.chunkIndex >= submission.chunkCount
    ) {
      throw new Error("Result submission chunkCount is invalid.");
    }
    if (
      !Number.isSafeInteger(submission.totalBytes) ||
      submission.totalBytes <= 0 ||
      submission.totalBytes > this.maxResultBytes
    ) {
      throw new Error("Result submission totalBytes is invalid.");
    }
    if (!DIGEST_PATTERN.test(submission.sha256 ?? "")) {
      throw new Error("Result submission sha256 is invalid.");
    }
    const decoded = canonicalBase64url(submission.data);
    if (decoded.length <= 0 || decoded.length > this.chunkBytes) {
      throw new Error("Result submission chunk exceeds the configured size.");
    }
    return decoded;
  }

  #key(jobId, leaseId, uploadId) {
    if (typeof jobId !== "string" || typeof leaseId !== "string") {
      throw new Error("Result submission job and lease identifiers are required.");
    }
    return `${jobId}:${leaseId}:${uploadId}`;
  }

  #deleteEntry(key) {
    const entry = this.entries.get(key);
    if (!entry) {
      return;
    }
    this.entries.delete(key);
    this.bufferedBytes -= entry.receivedBytes;
  }

  #reap() {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.createdAt + this.ttlMs <= now) {
        this.#deleteEntry(key);
      }
    }
    for (const [key, receipt] of this.receipts) {
      if (receipt.expiresAt <= now) {
        this.receipts.delete(key);
      }
    }
  }
}
