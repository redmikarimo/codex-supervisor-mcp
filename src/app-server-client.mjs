import { spawn } from "node:child_process";
import { once } from "node:events";
import readline from "node:readline";

import { AppServerError } from "./errors.mjs";
import { EventStore } from "./event-store.mjs";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_STDERR_LINES = 100;
const UNSAFE_WINDOWS_SHIM_PATTERN = /\.(?:cmd|bat|ps1)$/i;

export function assertSafeAppServerCommand(command) {
  if (typeof command !== "string" || !command.trim()) {
    throw new Error("CODEX_BIN must name a native executable.");
  }
  if (UNSAFE_WINDOWS_SHIM_PATTERN.test(command.trim())) {
    throw new Error(
      "CODEX_BIN must be a native executable, not a .cmd, .bat, or .ps1 shell shim.",
    );
  }
  return command;
}

export function sanitizeAppServerEnvironment(environment) {
  const sanitized = {};
  for (const [name, value] of Object.entries(environment ?? {})) {
    const upperName = name.toUpperCase();
    if (upperName.startsWith("BIOTELE_") || upperName.startsWith("CODEX_REMOTE_")) {
      continue;
    }
    sanitized[name] = value;
  }
  return sanitized;
}

function parseAppServerArgs() {
  const raw = process.env.CODEX_APP_SERVER_ARGS;
  if (!raw) {
    const serverName = process.env.CODEX_SUPERVISOR_MCP_NAME || "codex-supervisor";
    if (!/^[A-Za-z0-9_-]+$/.test(serverName)) {
      throw new Error(
        "CODEX_SUPERVISOR_MCP_NAME may contain only letters, numbers, underscores, and hyphens.",
      );
    }
    return [
      "-c",
      `mcp_servers.${serverName}.enabled=false`,
      "app-server",
    ];
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("CODEX_APP_SERVER_ARGS must be a JSON array of strings.");
  }

  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error("CODEX_APP_SERVER_ARGS must be a JSON array of strings.");
  }
  return parsed;
}

function processFailureMessage(code, signal) {
  return `Codex app-server exited unexpectedly (code=${String(code)}, signal=${String(signal)}). Inspect the local agent logs for details.`;
}

export class AppServerClient {
  constructor({
    command = process.env.CODEX_BIN || "codex",
    args = parseAppServerArgs(),
    env = process.env,
    eventStore = new EventStore(),
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  } = {}) {
    this.command = assertSafeAppServerCommand(command);
    this.args = args;
    this.env = sanitizeAppServerEnvironment(env);
    this.eventStore = eventStore;
    this.requestTimeoutMs = requestTimeoutMs;

    this.child = null;
    this.reader = null;
    this.state = "stopped";
    this.startPromise = null;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.stderrLines = [];
    this.loadedThreads = new Set();
  }

  async start() {
    if (this.state === "ready") {
      return;
    }
    if (this.startPromise) {
      return await this.startPromise;
    }

    this.startPromise = this.#startProcess();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async #startProcess() {
    this.state = "starting";

    const child = spawn(this.command, this.args, {
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    this.child = child;

    child.on("error", (error) => {
      this.state = "failed";
      this.#rejectAll(error);
    });

    child.on("exit", (code, signal) => {
      const wasStopping = this.state === "stopping" || this.state === "stopped";
      this.state = "stopped";
      this.loadedThreads.clear();

      if (!wasStopping) {
        const error = new AppServerError(
          processFailureMessage(code, signal),
        );
        this.#rejectAll(error);
      }
    });

    this.reader = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });
    this.reader.on("line", (line) => this.#handleLine(line));

    const stderrReader = readline.createInterface({
      input: child.stderr,
      crlfDelay: Infinity,
    });
    stderrReader.on("line", (line) => {
      this.stderrLines.push(line);
      if (this.stderrLines.length > MAX_STDERR_LINES) {
        this.stderrLines.splice(0, this.stderrLines.length - MAX_STDERR_LINES);
      }
      if (process.env.CODEX_SUPERVISOR_DEBUG === "1") {
        process.stderr.write(`[codex app-server] ${line}\n`);
      }
    });

    await new Promise((resolve, reject) => {
      const onSpawn = () => {
        cleanup();
        resolve();
      };
      const onError = (error) => {
        cleanup();
        reject(
          new AppServerError(
            "Unable to start the configured Codex app-server. Verify the native CODEX_BIN path and Codex authentication in the local agent environment.",
            { data: { causeCode: error.code ?? null } },
          ),
        );
      };
      const cleanup = () => {
        child.off("spawn", onSpawn);
        child.off("error", onError);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });

    try {
      await this.#requestRaw(
        "initialize",
        {
          clientInfo: {
            name: "codex_supervisor_mcp",
            title: "Codex Supervisor MCP",
            version: "1.0.0",
          },
          capabilities: {
            experimentalApi: false,
          },
        },
        20_000,
      );
      await this.#write({ method: "initialized", params: {} });
      this.state = "ready";
    } catch (error) {
      this.state = "failed";
      child.kill();
      throw error;
    }
  }

  async request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    await this.start();
    const result = await this.#requestRaw(method, params, timeoutMs);

    if (
      (method === "thread/start" || method === "thread/resume" || method === "thread/fork") &&
      result?.thread?.id
    ) {
      this.loadedThreads.add(result.thread.id);
    }
    if (method === "turn/start" && params?.threadId && result?.turn?.id) {
      this.eventStore.recordTurnStart(params.threadId, result.turn);
    }

    return result;
  }

  async notify(method, params = {}) {
    await this.start();
    await this.#write({ method, params });
  }

  async resolveServerRequest(requestKey, result) {
    await this.start();
    const request = this.eventStore.getPendingRequest(requestKey);
    if (!request) {
      throw new AppServerError(`No pending Codex server request exists for requestKey "${requestKey}".`);
    }

    await this.#write({
      id: request.requestId,
      result,
    });
    this.eventStore.removePendingRequest(requestKey);
    return request;
  }

  async stop() {
    if (!this.child || this.state === "stopped") {
      this.state = "stopped";
      return;
    }

    this.state = "stopping";
    const child = this.child;
    child.kill("SIGTERM");

    const timeout = new Promise((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      timer.unref?.();
    });
    await Promise.race([once(child, "exit").catch(() => undefined), timeout]);

    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }

    this.reader?.close();
    this.state = "stopped";
  }

  describe() {
    return {
      state: this.state,
      pid: this.child?.pid ?? null,
      loadedThreadCount: this.loadedThreads.size,
      stderrLineCount: this.stderrLines.length,
    };
  }

  async #requestRaw(method, params, timeoutMs) {
    const id = this.nextRequestId++;
    const responsePromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new AppServerError(`Codex app-server request timed out after ${timeoutMs} ms: ${method}`, {
            method,
          }),
        );
      }, timeoutMs);
      timer.unref?.();

      this.pending.set(id, {
        method,
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });

    try {
      await this.#write({ method, id, params });
    } catch (error) {
      const pending = this.pending.get(id);
      this.pending.delete(id);
      pending?.reject(error);
    }

    return await responsePromise;
  }

  async #write(message) {
    const child = this.child;
    if (!child?.stdin || child.stdin.destroyed || !child.stdin.writable) {
      throw new AppServerError("Codex app-server stdin is not writable.");
    }

    const line = `${JSON.stringify(message)}\n`;
    if (!child.stdin.write(line)) {
      await once(child.stdin, "drain");
    }
  }

  #handleLine(line) {
    if (line.trim() === "") {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.stderrLines.push(`Invalid JSON from app-server: ${line.slice(0, 500)}`);
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, "id") && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        this.stderrLines.push(`Unexpected app-server response id: ${JSON.stringify(message.id)}`);
        return;
      }
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(
          new AppServerError(message.error.message || `Codex request failed: ${pending.method}`, {
            code: message.error.code,
            data: message.error.data,
            method: pending.method,
          }),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method && Object.prototype.hasOwnProperty.call(message, "id")) {
      this.eventStore.addPendingRequest(message);
      return;
    }

    if (message.method) {
      this.eventStore.record(message.method, message.params ?? {});
      return;
    }

    this.stderrLines.push(`Unknown app-server message: ${line.slice(0, 500)}`);
  }

  #rejectAll(error) {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
