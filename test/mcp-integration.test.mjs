import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDirectory, "..");
const entrypoint = path.join(projectRoot, "src", "index.mjs");
const mockServer = path.join(currentDirectory, "mock-codex-app-server.mjs");

class JsonLineClient {
  constructor(child) {
    this.child = child;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = [];

    const output = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });
    output.on("line", (line) => {
      const message = JSON.parse(line);
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(`${message.error.code}: ${message.error.message}`),
        );
      } else {
        pending.resolve(message.result);
      }
    });

    const errors = readline.createInterface({
      input: child.stderr,
      crlfDelay: Infinity,
    });
    errors.on("line", (line) => this.stderr.push(line));

    child.on("exit", (code, signal) => {
      const error = new Error(
        `MCP process exited: code=${String(code)} signal=${String(signal)} stderr=${this.stderr.join("\n")}`,
      );
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
    });
  }

  request(method, params = {}) {
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}. Stderr: ${this.stderr.join("\n")}`));
      }, 5_000);
      timer.unref?.();

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });

    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return promise;
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async close() {
    this.child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill("SIGKILL");
        resolve();
      }, 2_000);
      timer.unref?.();
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

test("MCP server starts, monitors, and approves Codex tasks", async (t) => {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), "codex-supervisor-mcp-"));
  t.after(async () => {
    await fs.rm(repository, { recursive: true, force: true });
  });

  const child = spawn(process.execPath, [entrypoint], {
    env: {
      ...process.env,
      CODEX_BIN: process.execPath,
      CODEX_APP_SERVER_ARGS: JSON.stringify([mockServer]),
      CODEX_ALLOWED_ROOTS: repository,
      CODEX_ALLOW_NETWORK: "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = new JsonLineClient(child);
  t.after(async () => {
    await client.close();
  });

  const discovery = await client.request("server/discover", {
    _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": {
        name: "test-client",
        version: "1.0.0",
      },
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  });
  assert.ok(discovery.supportedVersions.includes("2026-07-28"));
  assert.ok(discovery.capabilities.tools);

  const initialized = await client.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: {
      name: "test-client",
      version: "1.0.0",
    },
  });
  assert.equal(initialized.protocolVersion, "2025-11-25");
  client.notify("notifications/initialized");

  const listed = await client.request("tools/list");
  const startTool = listed.tools.find((tool) => tool.name === "codex_start");
  assert.ok(startTool);
  assert.deepEqual(
    startTool.inputSchema.properties.approvalPolicy.enum,
    ["on-request", "untrusted"],
  );
  assert.equal(
    startTool.inputSchema.properties.approvalPolicy.default,
    "on-request",
  );
  assert.ok(listed.tools.some((tool) => tool.name === "codex_resolve_approval"));

  const startedResult = await client.request("tools/call", {
    name: "codex_start",
    arguments: {
      cwd: repository,
      prompt: "create a normal mock change",
    },
  });
  assert.equal(startedResult.isError, false);
  const started = startedResult.structuredContent;
  assert.match(started.threadId, /^thread-/);
  assert.match(started.turnId, /^turn-/);

  const completedResult = await client.request("tools/call", {
    name: "codex_wait",
    arguments: {
      threadId: started.threadId,
      afterSequence: started.eventCursor,
      timeoutMs: 2_000,
    },
  });
  const completed = completedResult.structuredContent;
  assert.equal(completed.reason, "completed");
  assert.match(completed.latestAgentMessage, /Completed: create a normal mock change/);

  const sentResult = await client.request("tools/call", {
    name: "codex_send",
    arguments: {
      threadId: started.threadId,
      prompt: "run a command that needs approval",
    },
  });
  const sent = sentResult.structuredContent;

  const approvalWaitResult = await client.request("tools/call", {
    name: "codex_wait",
    arguments: {
      threadId: started.threadId,
      afterSequence: sent.eventCursor,
      timeoutMs: 2_000,
    },
  });
  const approvalWait = approvalWaitResult.structuredContent;
  assert.equal(approvalWait.reason, "request");
  assert.equal(approvalWait.pendingRequests.length, 1);

  const requestKey = approvalWait.pendingRequests[0].requestKey;
  const approvedResult = await client.request("tools/call", {
    name: "codex_resolve_approval",
    arguments: {
      requestKey,
      decision: "accept",
    },
  });
  const approved = approvedResult.structuredContent;
  assert.equal(approved.resolved, true);

  const finalResult = await client.request("tools/call", {
    name: "codex_wait",
    arguments: {
      threadId: started.threadId,
      afterSequence: approved.eventCursor,
      timeoutMs: 2_000,
    },
  });
  const final = finalResult.structuredContent;
  assert.equal(final.reason, "completed");
  assert.match(final.latestDiff.preview ?? final.latestDiff, /needs approval/);
});
