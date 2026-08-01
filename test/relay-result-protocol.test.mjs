import assert from "node:assert/strict";
import test from "node:test";

import {
  RESULT_SUBMISSION_PROTOCOL,
  ResultSubmissionAssembler,
  ResultTooLargeError,
  encodeResultSubmission,
} from "../src/relay-result-protocol.mjs";

const JOB = "job-123";
const LEASE = "lease-123";

function acceptAll(assembler, encoded, overrides = {}) {
  let outcome;
  for (const submission of encoded.submissions) {
    outcome = assembler.accept({
      jobId: JOB,
      leaseId: LEASE,
      submission,
      assertLease() {},
      ...overrides,
    });
  }
  return outcome;
}

test("chunked result submissions round-trip large WAF-sensitive Unicode payloads", () => {
  const sensitive =
    "powershell.exe -ExecutionPolicy Bypass <script>alert(1)</script> SELECT * FROM secrets; ☃";
  const payload = {
    result: {
      content: [{ type: "text", text: sensitive.repeat(1_000) }],
      structuredContent: { status: "completed", note: "結果 🔐" },
      isError: false,
    },
  };
  const encoded = encodeResultSubmission(payload, {
    maxResultBytes: 256 * 1024,
    chunkBytes: 2 * 1024,
    uploadId: "upload-roundtrip-1234",
  });
  assert.ok(encoded.submissions.length > 1);
  for (const submission of encoded.submissions) {
    const wire = JSON.stringify({ jobId: JOB, leaseId: LEASE, submission });
    assert.equal(submission.protocol, RESULT_SUBMISSION_PROTOCOL);
    assert.equal(wire.includes("ExecutionPolicy"), false);
    assert.equal(wire.includes("<script>"), false);
    assert.ok(Buffer.byteLength(wire) < 4 * 1024);
  }

  const assembler = new ResultSubmissionAssembler({
    maxResultBytes: 256 * 1024,
    chunkBytes: 2 * 1024,
  });
  const outcome = acceptAll(assembler, encoded);
  assert.equal(outcome.complete, true);
  assert.equal(outcome.committed, false);
  assert.deepEqual(outcome.payload, payload);

  let leaseChecked = false;
  const uncommittedRetry = assembler.accept({
    jobId: JOB,
    leaseId: LEASE,
    submission: encoded.submissions.at(-1),
    assertLease() {
      leaseChecked = true;
    },
  });
  assert.equal(uncommittedRetry.complete, true);
  assert.equal(uncommittedRetry.duplicate, true);
  assert.equal(uncommittedRetry.committed, false);
  assert.deepEqual(uncommittedRetry.payload, payload);
  assert.equal(leaseChecked, true);

  assembler.commit({ jobId: JOB, leaseId: LEASE, uploadId: "upload-roundtrip-1234" });
  leaseChecked = false;
  const committedRetry = assembler.accept({
    jobId: JOB,
    leaseId: LEASE,
    submission: encoded.submissions.at(-1),
    assertLease() {
      leaseChecked = true;
    },
  });
  assert.deepEqual(committedRetry, {
    complete: true,
    duplicate: true,
    committed: true,
    payload: null,
  });
  assert.equal(leaseChecked, false);
});

test("result encoder rejects oversized or ambiguous payloads", () => {
  assert.throws(
    () => encodeResultSubmission({ result: "x".repeat(2_000) }, { maxResultBytes: 100 }),
    ResultTooLargeError,
  );
  assert.throws(
    () => encodeResultSubmission({ result: {}, error: {} }),
    /exactly one of result or error/,
  );
  assert.throws(() => encodeResultSubmission({}), /exactly one of result or error/);
});

test("assembler rejects malformed, out-of-order, and conflicting chunks", () => {
  const encoded = encodeResultSubmission(
    { result: { text: "x".repeat(200) } },
    { chunkBytes: 64, uploadId: "upload-validation-1234" },
  );
  const assembler = new ResultSubmissionAssembler({ chunkBytes: 64 });

  assert.throws(
    () => assembler.accept({
      jobId: JOB,
      leaseId: LEASE,
      submission: { ...encoded.submissions[0], data: `${encoded.submissions[0].data}=` },
      assertLease() {},
    }),
    /canonical base64url/,
  );
  assert.throws(
    () => assembler.accept({
      jobId: JOB,
      leaseId: LEASE,
      submission: encoded.submissions[1],
      assertLease() {},
    }),
    /sequentially/,
  );
  assert.equal(assembler.entries.size, 0);

  assembler.accept({
    jobId: JOB,
    leaseId: LEASE,
    submission: encoded.submissions[0],
    assertLease() {},
  });
  const conflicting = {
    ...encoded.submissions[0],
    data: Buffer.alloc(64, 0x41).toString("base64url"),
  };
  assert.throws(
    () => assembler.accept({
      jobId: JOB,
      leaseId: LEASE,
      submission: conflicting,
      assertLease() {},
    }),
    /conflicts/,
  );
});

test("assembler validates the completed length and digest", () => {
  const encoded = encodeResultSubmission(
    { result: { ok: true } },
    { chunkBytes: 1_024, uploadId: "upload-integrity-1234" },
  );
  const wrongLength = {
    ...encoded.submissions[0],
    totalBytes: encoded.submissions[0].totalBytes + 1,
  };
  assert.throws(
    () => new ResultSubmissionAssembler().accept({
      jobId: JOB,
      leaseId: LEASE,
      submission: wrongLength,
      assertLease() {},
    }),
    /length/,
  );

  const wrongDigest = {
    ...encoded.submissions[0],
    sha256: "A".repeat(43),
  };
  assert.throws(
    () => new ResultSubmissionAssembler().accept({
      jobId: JOB,
      leaseId: LEASE,
      submission: wrongDigest,
      assertLease() {},
    }),
    /digest/,
  );
});

test("assembler checks the lease before buffering and reaps stale uploads", () => {
  let now = 1_000;
  const encoded = encodeResultSubmission(
    { result: { text: "x".repeat(200) } },
    { chunkBytes: 64, uploadId: "upload-expiry-12345" },
  );
  const assembler = new ResultSubmissionAssembler({
    chunkBytes: 64,
    ttlMs: 100,
    now: () => now,
  });
  assert.throws(
    () => assembler.accept({
      jobId: JOB,
      leaseId: LEASE,
      submission: encoded.submissions[0],
      assertLease() {
        throw new Error("stale lease");
      },
    }),
    /stale lease/,
  );
  assert.equal(assembler.bufferedBytes, 0);

  assembler.accept({
    jobId: JOB,
    leaseId: LEASE,
    submission: encoded.submissions[0],
    assertLease() {},
  });
  assert.ok(assembler.bufferedBytes > 0);
  now += 101;
  assert.throws(
    () => assembler.accept({
      jobId: JOB,
      leaseId: LEASE,
      submission: encoded.submissions[1],
      assertLease() {},
    }),
    /sequentially/,
  );
  assert.equal(assembler.bufferedBytes, 0);
});

test("assembler enforces the aggregate buffer limit", () => {
  const first = encodeResultSubmission(
    { result: { text: "a".repeat(200) } },
    { chunkBytes: 64, uploadId: "upload-buffer-one1" },
  );
  const second = encodeResultSubmission(
    { result: { text: "b".repeat(200) } },
    { chunkBytes: 64, uploadId: "upload-buffer-two2" },
  );
  const assembler = new ResultSubmissionAssembler({
    chunkBytes: 64,
    maxBufferedBytes: 100,
  });
  assembler.accept({
    jobId: JOB,
    leaseId: LEASE,
    submission: first.submissions[0],
    assertLease() {},
  });
  assert.throws(
    () => assembler.accept({
      jobId: JOB,
      leaseId: LEASE,
      submission: second.submissions[0],
      assertLease() {},
    }),
    /buffer is full/,
  );
  assert.equal(assembler.entries.size, 1);
});

test("assembler bounds active upload entries", () => {
  const first = encodeResultSubmission(
    { result: { text: "a".repeat(200) } },
    { chunkBytes: 64, uploadId: "upload-entry-limit1" },
  );
  const second = encodeResultSubmission(
    { result: { text: "b".repeat(200) } },
    { chunkBytes: 64, uploadId: "upload-entry-limit2" },
  );
  const assembler = new ResultSubmissionAssembler({ chunkBytes: 64, maxUploads: 1 });
  assembler.accept({
    jobId: JOB,
    leaseId: LEASE,
    submission: first.submissions[0],
    assertLease() {},
  });
  assert.throws(
    () => assembler.accept({
      jobId: JOB,
      leaseId: LEASE,
      submission: second.submissions[0],
      assertLease() {},
    }),
    /entry limit is full/,
  );
  assert.equal(assembler.entries.size, 1);
});
