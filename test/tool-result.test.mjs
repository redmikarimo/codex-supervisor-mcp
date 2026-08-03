import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_INLINE_CONTENT_BYTES,
  completeToolResult,
  measureCompleteToolResultEnvelopeBytes,
  measureToolResultEnvelopeBytes,
} from "../src/tool-result.mjs";

test("small tool results retain their readable text and exact structured output", () => {
  const output = { ok: true, note: "small result" };
  const result = completeToolResult(output, { isModern: true });

  assert.equal(result.resultType, "complete");
  assert.equal(result.content[0].text, JSON.stringify(output, null, 2));
  assert.strictEqual(result.structuredContent, output);
  assert.equal(result.isError, false);
  assert.equal(
    measureToolResultEnvelopeBytes(output, { isModern: true }),
    Buffer.byteLength(JSON.stringify({ result }), "utf8"),
  );
});

test("large multibyte tool results use a compact text stub without altering structured content", () => {
  const output = { transcript: "結果🔐".repeat(MAX_INLINE_CONTENT_BYTES) };
  const prettyBytes = Buffer.byteLength(JSON.stringify(output, null, 2), "utf8");
  const result = completeToolResult(output);

  assert.match(
    result.content[0].text,
    new RegExp(`^Structured result available \\(${prettyBytes} bytes\\)\\.$`),
  );
  assert.strictEqual(result.structuredContent, output);
  assert.equal(result.content[0].text.includes(output.transcript.slice(0, 100)), false);
  assert.equal(
    measureCompleteToolResultEnvelopeBytes(result),
    measureToolResultEnvelopeBytes(output),
  );
  assert.ok(
    measureToolResultEnvelopeBytes(output) <
      Buffer.byteLength(
        JSON.stringify({
          result: {
            ...result,
            content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          },
        }),
        "utf8",
      ),
  );
});

test("error results preserve modern metadata and share the exact envelope estimator", () => {
  const output = { error: { type: "Example", message: "bounded" } };
  const result = completeToolResult(output, { isModern: true, isError: true });

  assert.equal(result.resultType, "complete");
  assert.equal(result.isError, true);
  assert.equal(
    measureToolResultEnvelopeBytes(output, { isModern: true, isError: true }),
    Buffer.byteLength(JSON.stringify({ result }), "utf8"),
  );
});
