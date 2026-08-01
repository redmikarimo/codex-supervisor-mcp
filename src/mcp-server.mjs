import readline from "node:readline";

import { sanitizeErrorData, sanitizeErrorText } from "./error-sanitization.mjs";
import { AppServerError, SecurityError, ValidationError } from "./errors.mjs";

const SERVER_NAME = "codex-supervisor-mcp";
const SERVER_TITLE = "Codex Supervisor MCP";
const SERVER_VERSION = "1.2.4";
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const LATEST_LEGACY_PROTOCOL_VERSION = "2025-11-25";
const LEGACY_PROTOCOL_VERSIONS = new Set([LATEST_LEGACY_PROTOCOL_VERSION]);
const SUPPORTED_PROTOCOL_VERSIONS = [
  MODERN_PROTOCOL_VERSION,
  LATEST_LEGACY_PROTOCOL_VERSION,
];

const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo";

const SERVER_INSTRUCTIONS =
  "Use codex_start to create work, then codex_wait with the returned eventCursor until completion or an approval request. Inspect every pending request before codex_resolve_approval; do not approve commands or file changes unless they match the user's request. Use codex_steer only for an active turn and codex_send only after the prior turn is idle. Repository paths are restricted by CODEX_ALLOWED_ROOTS; network access is off unless the server explicitly enables it.";

function requestKey(id) {
  return `${typeof id}:${JSON.stringify(id)}`;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function modernProtocolVersion(message) {
  return message?.params?._meta?.[PROTOCOL_VERSION_KEY] ?? null;
}

function jsonRpcError(id, code, message, data = undefined) {
  const error = { code, message: sanitizeErrorText(message) };
  if (data !== undefined) {
    error.data = sanitizeErrorData(data);
  }
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error,
  };
}

function completeToolResult(output, isModern, isError = false) {
  const text = JSON.stringify(output, null, 2);
  return {
    ...(isModern ? { resultType: "complete" } : {}),
    content: [{ type: "text", text }],
    structuredContent: output,
    isError,
  };
}

function toolErrorResult(error, isModern) {
  const output = {
    error: {
      type: sanitizeErrorText(error?.name || "Error", 128),
      message: sanitizeErrorText(error?.message || String(error)),
      ...(error instanceof AppServerError
        ? {
            code: sanitizeErrorData(error.code ?? null),
            method: sanitizeErrorText(error.method ?? "", 256) || null,
            data: sanitizeErrorData(error.data ?? null),
          }
        : {}),
    },
  };
  return completeToolResult(output, isModern, true);
}

export class McpStdioServer {
  constructor({ service, toolRegistry, input = process.stdin, output = process.stdout } = {}) {
    this.service = service;
    this.toolRegistry = toolRegistry;
    this.input = input;
    this.output = output;
    this.reader = null;
    this.legacyNegotiated = false;
    this.legacyReady = false;
    this.inFlight = new Map();
    this.activeRequestIds = new Set();
    this.closed = false;
    this.writeChain = Promise.resolve();
  }

  async run() {
    this.reader = readline.createInterface({
      input: this.input,
      crlfDelay: Infinity,
    });

    this.reader.on("line", (line) => {
      void this.#handleLine(line);
    });

    await new Promise((resolve) => {
      this.reader.once("close", resolve);
    });

    await this.close();
  }

  async close() {
    if (this.closed) {
      return;
    }
    this.closed = true;

    for (const controller of this.inFlight.values()) {
      controller.abort();
    }
    this.inFlight.clear();
    this.activeRequestIds.clear();
    await this.service.close();
  }

  async #handleLine(line) {
    if (line.trim() === "") {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      await this.#send(jsonRpcError(null, -32700, "Parse error"));
      return;
    }

    if (Array.isArray(message) || !isObject(message)) {
      await this.#send(jsonRpcError(null, -32600, "Invalid Request"));
      return;
    }

    if (!message.method || typeof message.method !== "string") {
      if (Object.prototype.hasOwnProperty.call(message, "id")) {
        await this.#send(jsonRpcError(message.id, -32600, "Invalid Request"));
      }
      return;
    }

    if (!Object.prototype.hasOwnProperty.call(message, "id")) {
      await this.#handleNotification(message);
      return;
    }

    await this.#handleRequest(message);
  }

  async #handleNotification(message) {
    if (message.method === "notifications/initialized") {
      this.legacyReady = true;
      return;
    }

    if (message.method === "notifications/cancelled") {
      const cancelledId = message.params?.requestId;
      if (cancelledId !== undefined) {
        this.inFlight.get(requestKey(cancelledId))?.abort();
      }
      return;
    }
  }

  async #handleRequest(message) {
    const key = requestKey(message.id);
    if (this.activeRequestIds.has(key)) {
      await this.#send(
        jsonRpcError(message.id, -32600, "Duplicate active JSON-RPC request id."),
      );
      return;
    }

    this.activeRequestIds.add(key);
    try {
      await this.#dispatchRequest(message);
    } finally {
      this.activeRequestIds.delete(key);
    }
  }

  async #dispatchRequest(message) {
    const { id, method } = message;
    const requestedVersion = modernProtocolVersion(message);
    const isModern = requestedVersion !== null;

    if (
      isModern &&
      requestedVersion !== MODERN_PROTOCOL_VERSION &&
      method !== "initialize"
    ) {
      await this.#send(
        jsonRpcError(id, -32022, "Unsupported protocol version", {
          supported: SUPPORTED_PROTOCOL_VERSIONS,
          requested: requestedVersion,
        }),
      );
      return;
    }

    if (method === "server/discover") {
      await this.#send({
        jsonrpc: "2.0",
        id,
        result: {
          resultType: "complete",
          supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
          capabilities: {
            tools: {},
          },
          _meta: {
            [SERVER_INFO_KEY]: {
              name: SERVER_NAME,
              title: SERVER_TITLE,
              version: SERVER_VERSION,
            },
          },
          instructions: SERVER_INSTRUCTIONS,
          ttlMs: 3_600_000,
          cacheScope: "public",
        },
      });
      return;
    }

    if (method === "initialize") {
      const requestedLegacyVersion = message.params?.protocolVersion;
      const negotiatedVersion = LEGACY_PROTOCOL_VERSIONS.has(requestedLegacyVersion)
        ? requestedLegacyVersion
        : LATEST_LEGACY_PROTOCOL_VERSION;

      this.legacyNegotiated = true;
      await this.#send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: negotiatedVersion,
          capabilities: {
            tools: {
              listChanged: false,
            },
          },
          serverInfo: {
            name: SERVER_NAME,
            title: SERVER_TITLE,
            version: SERVER_VERSION,
          },
          instructions: SERVER_INSTRUCTIONS,
        },
      });
      return;
    }

    if (!isModern && !this.legacyNegotiated && !this.legacyReady) {
      await this.#send(jsonRpcError(id, -32002, "Server not initialized"));
      return;
    }

    if (method === "ping") {
      await this.#send({
        jsonrpc: "2.0",
        id,
        result: {},
      });
      return;
    }

    if (method === "tools/list") {
      await this.#send({
        jsonrpc: "2.0",
        id,
        result: {
          ...(isModern ? { resultType: "complete" } : {}),
          tools: this.toolRegistry.definitions,
          ...(isModern ? { ttlMs: 3_600_000, cacheScope: "public" } : {}),
        },
      });
      return;
    }

    if (method === "tools/call") {
      await this.#handleToolCall(message, isModern);
      return;
    }

    await this.#send(jsonRpcError(id, -32601, `Method not found: ${method}`));
  }

  async #handleToolCall(message, isModern) {
    const { id } = message;
    const params = message.params;
    if (!isObject(params) || typeof params.name !== "string") {
      await this.#send(jsonRpcError(id, -32602, "tools/call requires a tool name."));
      return;
    }

    if (!this.toolRegistry.has(params.name)) {
      await this.#send(jsonRpcError(id, -32602, `Unknown tool: ${params.name}`));
      return;
    }

    const controller = new AbortController();
    const key = requestKey(id);
    this.inFlight.set(key, controller);

    try {
      const output = await this.toolRegistry.call(params.name, params.arguments ?? {}, {
        signal: controller.signal,
      });
      await this.#send({
        jsonrpc: "2.0",
        id,
        result: completeToolResult(output, isModern),
      });
    } catch (error) {
      if (error instanceof ValidationError) {
        await this.#send(
          jsonRpcError(id, -32602, error.message, error.details),
        );
      } else if (error?.name === "AbortError") {
        await this.#send(jsonRpcError(id, -32800, "Request cancelled"));
      } else if (error instanceof AppServerError || error instanceof SecurityError) {
        await this.#send({
          jsonrpc: "2.0",
          id,
          result: toolErrorResult(error, isModern),
        });
      } else {
        const wrapped = new Error(error?.message || String(error));
        wrapped.name = error?.name || "Error";
        await this.#send({
          jsonrpc: "2.0",
          id,
          result: toolErrorResult(wrapped, isModern),
        });
      }
    } finally {
      this.inFlight.delete(key);
    }
  }

  async #send(message) {
    const line = `${JSON.stringify(message)}\n`;
    this.writeChain = this.writeChain.then(
      () =>
        new Promise((resolve, reject) => {
          if (this.output.destroyed || !this.output.writable) {
            reject(new Error("MCP output stream is not writable."));
            return;
          }

          const accepted = this.output.write(line, (error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });

          if (!accepted) {
            this.output.once("drain", resolve);
          }
        }),
    );
    return await this.writeChain;
  }
}
