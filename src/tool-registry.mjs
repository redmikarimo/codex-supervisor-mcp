import {
  APPROVAL_POLICIES,
  DEFAULT_APPROVAL_POLICY,
  normalizeApprovalPolicy,
} from "./approval-policy.mjs";
import {
  DEFAULT_SANDBOX_MODE,
  SANDBOX_MODES,
  normalizeSandboxMode,
} from "./sandbox-mode.mjs";
import {
  DEFAULT_THREAD_PAGE_BYTES,
  MAX_THREAD_PAGE_BYTES,
  MIN_THREAD_PAGE_BYTES,
} from "./thread-pagination.mjs";
import {
  assertAllowedKeys,
  optionalBoolean,
  optionalEnum,
  optionalInteger,
  optionalString,
  requireObject,
  requireRequestKey,
  requireString,
} from "./validation.mjs";

const APPROVAL_DECISIONS = ["accept", "acceptForSession", "decline", "cancel"];

const taskOptionsSchema = {
  model: {
    type: "string",
    description: "Optional Codex model id. Omit to use the configured default.",
  },
  effort: {
    type: "string",
    description: "Optional reasoning effort accepted by the selected model.",
  },
  sandboxMode: {
    type: "string",
    enum: SANDBOX_MODES,
    default: DEFAULT_SANDBOX_MODE,
    description: "read-only prevents edits; workspace-write permits writes only in the repository. Legacy camelCase aliases remain accepted.",
  },
  networkAccess: {
    type: "boolean",
    default: false,
    description: "Requires CODEX_ALLOW_NETWORK=1 on the MCP server.",
  },
  approvalPolicy: {
    type: "string",
    enum: APPROVAL_POLICIES,
    default: DEFAULT_APPROVAL_POLICY,
    description: "Controls when Codex asks before command execution or file changes.",
  },
};

function annotations({
  readOnlyHint,
  destructiveHint,
  idempotentHint = false,
  openWorldHint = false,
}) {
  return {
    readOnlyHint,
    destructiveHint,
    idempotentHint,
    openWorldHint,
  };
}

export const TOOL_DEFINITIONS = [
  {
    name: "codex_start",
    title: "Start Codex task",
    description:
      "Start a new Codex app-server thread and immediately begin a turn in an allowed local repository. Return threadId, turnId, and an event cursor for codex_wait or codex_status.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        cwd: {
          type: "string",
          description: "Existing repository directory inside CODEX_ALLOWED_ROOTS.",
        },
        prompt: {
          type: "string",
          description: "Complete implementation or investigation request for Codex.",
        },
        ...taskOptionsSchema,
      },
      required: ["cwd", "prompt"],
    },
    annotations: annotations({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    }),
  },
  {
    name: "codex_send",
    title: "Send new Codex turn",
    description:
      "Resume an authorized Codex thread when necessary and start a new turn. Use only when no turn is active; use codex_steer for an in-flight turn.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        threadId: { type: "string", description: "Codex thread id." },
        prompt: { type: "string", description: "New user instruction." },
        cwd: {
          type: "string",
          description: "Optional allowed repository directory override.",
        },
        ...taskOptionsSchema,
      },
      required: ["threadId", "prompt"],
    },
    annotations: annotations({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    }),
  },
  {
    name: "codex_steer",
    title: "Steer active Codex turn",
    description:
      "Append guidance to the currently active turn without creating another turn. Supply expectedTurnId when available to prevent steering the wrong turn.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        threadId: { type: "string", description: "Codex thread id." },
        prompt: { type: "string", description: "Additional in-flight guidance." },
        expectedTurnId: {
          type: "string",
          description: "Optional active turn id returned by codex_start or codex_send.",
        },
      },
      required: ["threadId", "prompt"],
    },
    annotations: annotations({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    }),
  },
  {
    name: "codex_status",
    title: "Read Codex status",
    description:
      "Read a bounded thread snapshot, current turn state, pending approvals, latest persisted agent message, latest diff, and recent streamed events. includeTurns returns the first bounded transcript page.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        threadId: { type: "string", description: "Codex thread id." },
        afterSequence: {
          type: "integer",
          minimum: 0,
          default: 0,
          description: "Return events newer than this cursor.",
        },
        maxEvents: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          default: 50,
        },
        includeTurns: {
          type: "boolean",
          default: false,
          description: "Include the first bounded persisted transcript page.",
        },
      },
      required: ["threadId"],
    },
    annotations: annotations({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    }),
  },
  {
    name: "codex_wait",
    title: "Wait for Codex progress",
    description:
      "Long-poll an active turn until it completes, fails, requests approval, is interrupted, or reaches the timeout. Continue with the returned eventCursor.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        threadId: { type: "string", description: "Codex thread id." },
        afterSequence: {
          type: "integer",
          minimum: 0,
          default: 0,
          description: "Cursor returned by the preceding Codex tool call.",
        },
        timeoutMs: {
          type: "integer",
          minimum: 100,
          maximum: 55000,
          default: 30000,
        },
        maxEvents: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          default: 100,
        },
      },
      required: ["threadId"],
    },
    annotations: annotations({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    }),
  },
  {
    name: "codex_interrupt",
    title: "Interrupt Codex turn",
    description: "Request cancellation of an active Codex turn.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        threadId: { type: "string", description: "Codex thread id." },
        turnId: {
          type: "string",
          description: "Optional turn id; defaults to the active turn known by this bridge.",
        },
      },
      required: ["threadId"],
    },
    annotations: annotations({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    }),
  },
  {
    name: "codex_list_threads",
    title: "List Codex threads",
    description:
      "List persisted Codex threads whose working directories are inside CODEX_ALLOWED_ROOTS. Results outside those roots are filtered.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
        cursor: { type: "string", description: "Optional pagination cursor." },
        searchTerm: { type: "string", description: "Optional thread search text." },
        cwd: {
          type: "string",
          description: "Optional exact allowed working-directory filter.",
        },
      },
    },
    annotations: annotations({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    }),
  },
  {
    name: "codex_read_thread",
    title: "Read Codex thread",
    description:
      "Read a persisted authorized Codex thread. Large transcripts are returned in stable chronological pages below the relay result limit.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        threadId: { type: "string", description: "Codex thread id." },
        includeTurns: {
          type: "boolean",
          default: false,
          description: "Include a bounded chronological transcript page. Omit for the compact thread view.",
        },
        cursor: {
          type: "string",
          description: "Opaque nextCursor from the preceding page.",
        },
        maxBytes: {
          type: "integer",
          minimum: MIN_THREAD_PAGE_BYTES,
          maximum: MAX_THREAD_PAGE_BYTES,
          default: DEFAULT_THREAD_PAGE_BYTES,
          description: "Maximum UTF-8 bytes for the final compact MCP result envelope.",
        },
      },
      required: ["threadId"],
    },
    annotations: annotations({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    }),
  },
  {
    name: "codex_list_approvals",
    title: "List Codex approvals",
    description:
      "List pending app-server requests. This release resolves command-execution and file-change approval requests; unsupported request types remain visible.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        threadId: {
          type: "string",
          description: "Optional authorized thread filter.",
        },
      },
    },
    annotations: annotations({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    }),
  },
  {
    name: "codex_resolve_approval",
    title: "Resolve Codex approval",
    description:
      "Explicitly accept, accept for the session, decline, or cancel a pending Codex command-execution or file-change approval.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        requestKey: {
          type: "string",
          description: "Opaque requestKey returned by codex_status or codex_list_approvals.",
        },
        decision: {
          type: "string",
          enum: APPROVAL_DECISIONS,
        },
      },
      required: ["requestKey", "decision"],
    },
    annotations: annotations({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    }),
  },
];

function parseTaskOptions(input) {
  return {
    model: optionalString(input.model, "model", { maxLength: 128 }),
    effort: optionalString(input.effort, "effort", { maxLength: 64 }),
    sandboxMode: normalizeSandboxMode(input.sandboxMode),
    networkAccess: optionalBoolean(input.networkAccess, "networkAccess", false),
    approvalPolicy: normalizeApprovalPolicy(input.approvalPolicy),
  };
}

function threadId(value) {
  return requireString(value, "threadId", { minLength: 1, maxLength: 512 });
}

export function createToolRegistry(service) {
  const handlers = {
    async codex_start(rawArguments) {
      const input = requireObject(rawArguments ?? {}, "arguments");
      assertAllowedKeys(
        input,
        [
          "cwd",
          "prompt",
          "model",
          "effort",
          "sandboxMode",
          "networkAccess",
          "approvalPolicy",
        ],
      );
      return await service.startTask({
        cwd: requireString(input.cwd, "cwd", { maxLength: 16_384 }),
        prompt: requireString(input.prompt, "prompt"),
        ...parseTaskOptions(input),
      });
    },

    async codex_send(rawArguments) {
      const input = requireObject(rawArguments ?? {}, "arguments");
      assertAllowedKeys(
        input,
        [
          "threadId",
          "prompt",
          "cwd",
          "model",
          "effort",
          "sandboxMode",
          "networkAccess",
          "approvalPolicy",
        ],
      );
      return await service.send({
        threadId: threadId(input.threadId),
        prompt: requireString(input.prompt, "prompt"),
        cwd: optionalString(input.cwd, "cwd", { maxLength: 16_384 }),
        ...parseTaskOptions(input),
      });
    },

    async codex_steer(rawArguments) {
      const input = requireObject(rawArguments ?? {}, "arguments");
      assertAllowedKeys(input, ["threadId", "prompt", "expectedTurnId"]);
      return await service.steer({
        threadId: threadId(input.threadId),
        prompt: requireString(input.prompt, "prompt"),
        expectedTurnId: optionalString(input.expectedTurnId, "expectedTurnId", {
          maxLength: 512,
        }),
      });
    },

    async codex_status(rawArguments) {
      const input = requireObject(rawArguments ?? {}, "arguments");
      assertAllowedKeys(input, ["threadId", "afterSequence", "maxEvents", "includeTurns"]);
      return await service.status({
        threadId: threadId(input.threadId),
        afterSequence: optionalInteger(input.afterSequence, "afterSequence", {
          minimum: 0,
          defaultValue: 0,
        }),
        maxEvents: optionalInteger(input.maxEvents, "maxEvents", {
          minimum: 1,
          maximum: 200,
          defaultValue: 50,
        }),
        includeTurns: optionalBoolean(input.includeTurns, "includeTurns", false),
      });
    },

    async codex_wait(rawArguments, { signal } = {}) {
      const input = requireObject(rawArguments ?? {}, "arguments");
      assertAllowedKeys(input, ["threadId", "afterSequence", "timeoutMs", "maxEvents"]);
      return await service.wait({
        threadId: threadId(input.threadId),
        afterSequence: optionalInteger(input.afterSequence, "afterSequence", {
          minimum: 0,
          defaultValue: 0,
        }),
        timeoutMs: optionalInteger(input.timeoutMs, "timeoutMs", {
          minimum: 100,
          maximum: 55_000,
          defaultValue: 30_000,
        }),
        maxEvents: optionalInteger(input.maxEvents, "maxEvents", {
          minimum: 1,
          maximum: 200,
          defaultValue: 100,
        }),
        signal,
      });
    },

    async codex_interrupt(rawArguments) {
      const input = requireObject(rawArguments ?? {}, "arguments");
      assertAllowedKeys(input, ["threadId", "turnId"]);
      return await service.interrupt({
        threadId: threadId(input.threadId),
        turnId: optionalString(input.turnId, "turnId", { maxLength: 512 }),
      });
    },

    async codex_list_threads(rawArguments) {
      const input = requireObject(rawArguments ?? {}, "arguments");
      assertAllowedKeys(input, ["limit", "cursor", "searchTerm", "cwd"]);
      return await service.listThreads({
        limit: optionalInteger(input.limit, "limit", {
          minimum: 1,
          maximum: 100,
          defaultValue: 50,
        }),
        cursor: optionalString(input.cursor, "cursor", { maxLength: 4_096 }),
        searchTerm: optionalString(input.searchTerm, "searchTerm", {
          maxLength: 1_024,
        }),
        cwd: optionalString(input.cwd, "cwd", { maxLength: 16_384 }),
      });
    },

    async codex_read_thread(rawArguments) {
      const input = requireObject(rawArguments ?? {}, "arguments");
      assertAllowedKeys(input, ["threadId", "includeTurns", "cursor", "maxBytes"]);
      return await service.readThread({
        threadId: threadId(input.threadId),
        includeTurns: optionalBoolean(input.includeTurns, "includeTurns", false),
        cursor: optionalString(input.cursor, "cursor", { maxLength: 16_384 }),
        maxBytes: optionalInteger(input.maxBytes, "maxBytes", {
          minimum: MIN_THREAD_PAGE_BYTES,
          maximum: MAX_THREAD_PAGE_BYTES,
        }),
      });
    },

    async codex_list_approvals(rawArguments) {
      const input = requireObject(rawArguments ?? {}, "arguments");
      assertAllowedKeys(input, ["threadId"]);
      return await service.listPendingRequests({
        threadId: input.threadId === undefined ? undefined : threadId(input.threadId),
      });
    },

    async codex_resolve_approval(rawArguments) {
      const input = requireObject(rawArguments ?? {}, "arguments");
      assertAllowedKeys(input, ["requestKey", "decision"]);
      return await service.resolveApproval({
        requestKey: requireRequestKey(input.requestKey),
        decision: optionalEnum(input.decision, "decision", APPROVAL_DECISIONS),
      });
    },
  };

  return {
    definitions: TOOL_DEFINITIONS,

    has(name) {
      return Object.prototype.hasOwnProperty.call(handlers, name);
    },

    async call(name, rawArguments, context = {}) {
      const handler = handlers[name];
      if (!handler) {
        throw new Error(`Unknown tool: ${name}`);
      }
      return await handler(rawArguments, context);
    },
  };
}
