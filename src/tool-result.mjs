export const MAX_INLINE_CONTENT_BYTES = 16 * 1024;

function serializedOutput(output) {
  return JSON.stringify(output, null, 2) ?? "null";
}

export function completeToolResult(
  output,
  { isModern = false, isError = false } = {},
) {
  const serialized = serializedOutput(output);
  const serializedBytes = Buffer.byteLength(serialized, "utf8");
  const text =
    serializedBytes <= MAX_INLINE_CONTENT_BYTES
      ? serialized
      : `Structured result available (${serializedBytes} bytes).`;

  return {
    ...(isModern ? { resultType: "complete" } : {}),
    content: [{ type: "text", text }],
    structuredContent: output,
    isError,
  };
}

export function measureCompleteToolResultEnvelopeBytes(result) {
  return Buffer.byteLength(JSON.stringify({ result }), "utf8");
}

export function measureToolResultEnvelopeBytes(
  output,
  options = {},
) {
  return measureCompleteToolResultEnvelopeBytes(
    completeToolResult(output, options),
  );
}
