import assert from "node:assert/strict";
import test from "node:test";

import {
  CompletedJobCache,
  LocalRelayAgent,
  negotiatedResultLimits,
  parseRelayResponse,
  submitResult,
} from "../src/local-agent.mjs";
import {
  RESULT_SUBMISSION_PROTOCOL,
  ResultSubmissionAssembler,
} from "../src/relay-result-protocol.mjs";
import { AppServerError } from "../src/errors.mjs";
import { measureCompleteToolResultEnvelopeBytes } from "../src/tool-result.mjs";

const CAPABILITY = {
  preferredProtocol: RESULT_SUBMISSION_PROTOCOL,
  supportedProtocols: [RESULT_SUBMISSION_PROTOCOL],
  maxResultBytes: 256 * 1024,
  chunkBytes: 1_024,
  maxChunks: 64,
};

test("local agent preserves non-JSON relay HTTP failures", async () => {
  await assert.rejects(
    () => parseRelayResponse(new Response("Forbidden\n", { status: 403 }), "/agent/jobs/result"),
    (error) => {
      assert.equal(error.name, "Error");
      assert.match(error.message, /HTTP 403: Forbidden/);
      assert.doesNotMatch(error.message, /SyntaxError|Unexpected token/);
      return true;
    },
  );
});

test("local agent accepts empty success and rejects invalid success JSON", async () => {
  assert.equal(
    await parseRelayResponse(new Response(null, { status: 204 }), "/agent/jobs/claim"),
    null,
  );
  await assert.rejects(
    () => parseRelayResponse(new Response("not-json", { status: 200 }), "/agent/status"),
    /returned non-JSON data with HTTP 200/,
  );
});

test("local agent sanitizes AppServerError fields and structured data", async () => {
  const sentinel = ["app", "server", "secret"].join("-");
  const submissions = [];
  const agent = new LocalRelayAgent({
    service: { async close() {} },
    tools: {
      has() {
        return true;
      },
      async call() {
        throw new AppServerError(`BIOTELE_RELAY_AGENT_SECRET=${sentinel}`, {
          code: `token=${sentinel}`,
          method: `authorization=Bearer ${sentinel}`,
          data: {
            BIOTELE_RELAY_AGENT_SECRET: sentinel,
            "x-api-key": sentinel,
            nested: { password: sentinel },
            tokenCount: 3,
          },
        });
      },
    },
    pathPolicy: { async resolveCwd() {} },
    submit: async (_job, payload) => {
      submissions.push(payload);
    },
  });

  await agent.handleJob({
    id: "app-server-error-sanitization",
    leaseId: "app-server-error-sanitization-lease",
    deliveryCount: 1,
    toolName: "codex_status",
    arguments: {},
  });

  assert.equal(submissions.length, 1);
  const result = submissions[0].result;
  const serialized = JSON.stringify(result);
  assert.equal(result.isError, true);
  assert.doesNotMatch(serialized, new RegExp(sentinel));
  assert.match(serialized, /\[REDACTED\]/);
  assert.equal(result.structuredContent.error.data.tokenCount, 3);
  assert.equal(
    result.structuredContent.error.data.BIOTELE_RELAY_AGENT_SECRET,
    "[REDACTED]",
  );
  assert.equal(result.structuredContent.error.data["x-api-key"], "[REDACTED]");
});

test("local agent keeps a large structured result while using the shared compact text stub", async () => {
  const output = { transcript: "結果🔐".repeat(4_000) };
  const submissions = [];
  const agent = new LocalRelayAgent({
    service: { async close() {} },
    tools: {
      has() {
        return true;
      },
      async call() {
        return output;
      },
    },
    pathPolicy: { async resolveCwd() {} },
    submit: async (_job, payload) => submissions.push(payload),
  });

  await agent.handleJob(
    {
      id: "compact-large-result",
      leaseId: "compact-large-result-lease",
      deliveryCount: 1,
      toolName: "codex_read_thread",
      arguments: {},
    },
    CAPABILITY,
  );

  assert.equal(submissions.length, 1);
  const result = submissions[0].result;
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /^Structured result available \(\d+ bytes\)\.$/);
  assert.strictEqual(result.structuredContent, output);
  assert.ok(measureCompleteToolResultEnvelopeBytes(result) <= 64 * 1024);
});

test("result capability negotiation derives limits from the final clamped values", () => {
  assert.deepEqual(
    negotiatedResultLimits({
      ...CAPABILITY,
      maxResultBytes: 128 * 1024,
      chunkBytes: 64 * 1024,
      maxChunks: 2,
    }),
    {
      supportsChunked: true,
      maxResultBytes: 64 * 1024,
      chunkBytes: 32 * 1024,
      maxChunks: 2,
    },
  );
  assert.deepEqual(
    negotiatedResultLimits({
      ...CAPABILITY,
      maxResultBytes: 2 * 1024 * 1024,
      chunkBytes: 1_024,
      maxChunks: 1_000,
    }),
    {
      supportsChunked: true,
      maxResultBytes: 64 * 1024,
      chunkBytes: 1_024,
      maxChunks: 64,
    },
  );
  const malformed = negotiatedResultLimits({
    ...CAPABILITY,
    maxResultBytes: -1,
    chunkBytes: 0,
    maxChunks: -10,
  });
  assert.equal(malformed.maxResultBytes, 2 * 1024 * 1024);
  assert.equal(malformed.chunkBytes, 32 * 1024);
  assert.equal(malformed.maxChunks, 64);
  assert.throws(
    () => negotiatedResultLimits({ ...CAPABILITY, maxResultBytes: 1 }),
    /at least 4096 bytes/,
  );
});

test("local agent retries stable chunks without executing a tool twice", async () => {
  const assembler = new ResultSubmissionAssembler({
    maxResultBytes: CAPABILITY.maxResultBytes,
    chunkBytes: CAPABILITY.chunkBytes,
  });
  const attempts = new Map();
  const lostOnce = new Set([1]);
  let finalIndex = null;
  let toolCalls = 0;
  let committedPayload = null;

  const request = async (_path, body) => {
    const submission = body.submission;
    finalIndex = submission.chunkCount - 1;
    const previous = attempts.get(submission.chunkIndex);
    if (previous) {
      assert.equal(submission.uploadId, previous.uploadId);
      assert.equal(submission.data, previous.data);
    } else {
      attempts.set(submission.chunkIndex, submission);
    }
    const accepted = assembler.accept({
      jobId: body.jobId,
      leaseId: body.leaseId,
      submission,
      assertLease() {},
    });
    if (accepted.complete && !accepted.committed) {
      committedPayload = accepted.payload;
      assembler.commit({
        jobId: body.jobId,
        leaseId: body.leaseId,
        uploadId: submission.uploadId,
      });
    }
    if (lostOnce.delete(submission.chunkIndex) ||
        (submission.chunkIndex === finalIndex && !lostOnce.has("final-lost"))) {
      if (submission.chunkIndex === finalIndex) {
        lostOnce.add("final-lost");
      }
      const error = new Error("simulated lost response");
      error.transient = true;
      throw error;
    }
    return { accepted: true };
  };
  const completed = new CompletedJobCache({
    ttlMs: 60_000,
    maxEntries: 2,
    maxBytes: 512 * 1024,
  });
  const agent = new LocalRelayAgent({
    service: { async close() {} },
    tools: {
      has(name) {
        return name === "codex_status";
      },
      async call() {
        toolCalls += 1;
        return { events: "x".repeat(8_000) };
      },
    },
    pathPolicy: { async resolveCwd() {} },
    completed,
    submit: (job, payload, capability) => submitResult(job, payload, capability, {
      request,
      sleepFn: async () => {},
      retryDelays: [0, 0, 0],
    }),
  });
  await agent.handleJob(
    {
      id: "job-local-agent-1",
      leaseId: "lease-local-agent-1",
      leasedUntil: 1,
      resultDeadlineAt: 1,
      expiresAt: 1,
      resultBudgetMs: 30_000,
      deliveryCount: 1,
      toolName: "codex_status",
      arguments: {},
    },
    CAPABILITY,
  );

  assert.equal(toolCalls, 1);
  assert.ok(attempts.size > 1);
  assert.ok(finalIndex > 1);
  assert.equal(lostOnce.has("final-lost"), true);
  assert.equal(committedPayload.result.structuredContent.events.length, 8_000);
  assert.equal(completed.entries.size, 0);
});

for (const toolName of [
  "codex_start",
  "codex_send",
  "codex_steer",
  "codex_interrupt",
  "codex_resolve_approval",
]) {
  test(`fresh agents fail closed on ${toolName} redelivery without a cached outcome`, async () => {
    let toolCalls = 0;
    const submissions = [];
    const agent = new LocalRelayAgent({
      service: { async close() {} },
      tools: {
        has() {
          return true;
        },
        async call() {
          toolCalls += 1;
          return { shouldNotRun: true };
        },
      },
      pathPolicy: { async resolveCwd() {} },
      completed: new CompletedJobCache({ ttlMs: 60_000 }),
      submit: async (_job, payload) => {
        submissions.push(payload);
      },
    });
    await agent.handleJob(
      {
        id: `job-redelivered-${toolName}`,
        leaseId: `lease-redelivered-${toolName}`,
        resultBudgetMs: 30_000,
        deliveryCount: 2,
        toolName,
        arguments: {},
      },
      CAPABILITY,
    );
    assert.equal(toolCalls, 0);
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0].result.isError, true);
    assert.equal(
      submissions[0].result.structuredContent.error.type,
      "UnsafeRedelivery",
    );
  });
}

for (const resultBudgetMs of [0, 1, 2_000]) {
  test(`replay-sensitive work is not started with ${resultBudgetMs}ms result budget`, async () => {
    let toolCalls = 0;
    let resultRequests = 0;
    const agent = new LocalRelayAgent({
      service: { async close() {} },
      tools: {
        has() {
          return true;
        },
        async call() {
          toolCalls += 1;
          return { shouldNotRun: true };
        },
      },
      pathPolicy: { async resolveCwd() {} },
      completed: new CompletedJobCache({ ttlMs: 60_000 }),
      submit: (job, payload, capability) => submitResult(job, payload, capability, {
        request: async () => {
          resultRequests += 1;
          return { accepted: true };
        },
        sleepFn: async () => {},
      }),
    });
    await assert.rejects(
      () => agent.handleJob(
        {
          id: `job-short-budget-${resultBudgetMs}`,
          leaseId: `lease-short-budget-${resultBudgetMs}`,
          resultBudgetMs,
          deliveryCount: 1,
          toolName: "codex_start",
          arguments: {},
        },
        CAPABILITY,
      ),
      /result deadline expired/,
    );
    assert.equal(toolCalls, 0);
    assert.equal(resultRequests, 0);
  });
}

test("local agent stop aborts a pending poll and closes the service exactly once", async () => {
  let closeCount = 0;
  let pollStarted;
  const started = new Promise((resolve) => {
    pollStarted = resolve;
  });
  const agent = new LocalRelayAgent({
    service: {
      async close() {
        closeCount += 1;
      },
    },
    tools: {},
    pathPolicy: {},
    request: async (_path, _body, _timeoutMs, { signal }) => {
      pollStarted();
      return await new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) {
          onAbort();
        }
      });
    },
  });

  const running = agent.run();
  await started;
  await agent.stop();
  await running;
  await agent.stop();
  assert.equal(closeCount, 1);
  assert.equal(agent.activeJobs.size, 0);
});

test("local agent stop waits for active job submission before closing the service", async () => {
  const events = [];
  let releaseTool;
  let toolStarted;
  const started = new Promise((resolve) => {
    toolStarted = resolve;
  });
  const gate = new Promise((resolve) => {
    releaseTool = resolve;
  });
  const agent = new LocalRelayAgent({
    service: {
      async close() {
        events.push("close");
      },
    },
    tools: {
      has() {
        return true;
      },
      async call() {
        events.push("tool-start");
        toolStarted();
        await gate;
        events.push("tool-finish");
        return { ok: true };
      },
    },
    pathPolicy: { async resolveCwd() {} },
    submit: async () => {
      events.push("submit");
    },
  });
  const handling = agent.handleJob({
    id: "active-job",
    leaseId: "active-lease",
    deliveryCount: 1,
    toolName: "codex_status",
    arguments: {},
  }, {});
  await started;
  const stopping = agent.stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["tool-start"]);
  releaseTool();
  await Promise.all([handling, stopping]);
  assert.deepEqual(events, ["tool-start", "tool-finish", "submit", "close"]);
  assert.equal(agent.activeJobs.size, 0);
});

test("chunk submission adapts after HTTP 413 and legacy fallback stays one-shot", async () => {
  const uploadIds = new Set();
  const acceptedChunkSizes = [];
  const job = {
    id: "job-adaptive-1",
    leaseId: "lease-adaptive-1",
  };
  await submitResult(
    job,
    { result: { text: "x".repeat(10_000) } },
    { ...CAPABILITY, chunkBytes: 4_096 },
    {
      request: async (_path, body) => {
        const decodedBytes = Buffer.from(body.submission.data, "base64url").length;
        uploadIds.add(body.submission.uploadId);
        if (decodedBytes > 1_024) {
          const error = new Error("proxy body limit");
          error.statusCode = 413;
          error.transient = false;
          throw error;
        }
        acceptedChunkSizes.push(decodedBytes);
        return { accepted: true };
      },
      sleepFn: async () => {},
    },
  );
  assert.ok(uploadIds.size >= 3);
  assert.ok(acceptedChunkSizes.length > 1);
  assert.ok(acceptedChunkSizes.every((size) => size <= 1_024));

  const legacyBodies = [];
  await submitResult(
    job,
    { result: { ok: true } },
    undefined,
    {
      request: async (_path, body) => {
        legacyBodies.push(body);
        return { accepted: true };
      },
    },
  );
  assert.equal(legacyBodies.length, 1);
  assert.equal("submission" in legacyBodies[0], false);
  assert.deepEqual(legacyBodies[0].result, { ok: true });
});

test("completed result cache evicts by bytes and entries and expires", () => {
  let now = 1_000;
  const cache = new CompletedJobCache({
    ttlMs: 100,
    maxEntries: 2,
    maxBytes: 70,
    now: () => now,
  });
  assert.equal(cache.set("one", { text: "a".repeat(20) }), true);
  assert.equal(cache.set("two", { text: "b".repeat(20) }), true);
  assert.equal(cache.set("three", { text: "c".repeat(20) }), true);
  assert.equal(cache.get("one"), undefined);
  assert.deepEqual(cache.get("three"), { text: "c".repeat(20) });
  assert.ok(cache.bytes <= 70);
  now += 101;
  assert.equal(cache.get("three"), undefined);
  assert.equal(cache.bytes, 0);
});
