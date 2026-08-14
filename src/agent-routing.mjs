export const CODEX_AGENT_ROUTE = "codex";
export const REEVES_AGENT_ROUTE = "reeves";
export const REEVES_AGENT_KEY_ID = "reeves-android-1";

const emptyInputSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {},
});

function annotations({ readOnlyHint, destructiveHint, idempotentHint, openWorldHint }) {
  return {
    readOnlyHint,
    destructiveHint,
    idempotentHint,
    openWorldHint,
  };
}

const readOnlyAnnotations = annotations({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

const deviceActionAnnotations = annotations({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
});

const coordinate = (description) => ({
  type: "integer",
  minimum: 0,
  description,
});

const gestureDuration = (defaultValue) => ({
  type: "integer",
  minimum: 1,
  maximum: 10_000,
  default: defaultValue,
  description: "Gesture duration in milliseconds.",
});

const sequenceActionSchemas = [
  {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { const: "tap" },
      x: coordinate("Horizontal screen coordinate in pixels."),
      y: coordinate("Vertical screen coordinate in pixels."),
      durationMs: gestureDuration(60),
    },
    required: ["type", "x", "y"],
  },
  {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { const: "swipe" },
      startX: coordinate("Starting horizontal pixel coordinate."),
      startY: coordinate("Starting vertical pixel coordinate."),
      endX: coordinate("Ending horizontal pixel coordinate."),
      endY: coordinate("Ending vertical pixel coordinate."),
      durationMs: gestureDuration(350),
    },
    required: ["type", "startX", "startY", "endX", "endY"],
  },
  {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { const: "type" },
      text: { type: "string", minLength: 1, maxLength: 16_384 },
    },
    required: ["type", "text"],
  },
  ...["back", "home", "recents", "screenshot"].map((type) => ({
    type: "object",
    additionalProperties: false,
    properties: { type: { const: type } },
    required: ["type"],
  })),
  {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { const: "wait" },
      ms: { type: "integer", minimum: 1, maximum: 10_000 },
    },
    required: ["type", "ms"],
  },
];

export const REEVES_TOOL_DEFINITIONS = Object.freeze([
  {
    name: "reeves_status",
    title: "Read Reeves status",
    description:
      "Read the Reeves Android agent and accessibility-service status without changing device state.",
    inputSchema: emptyInputSchema,
    annotations: readOnlyAnnotations,
  },
  {
    name: "reeves_tap",
    title: "Tap Android screen",
    description: "Tap one absolute screen coordinate on the Reeves Android device.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        x: { type: "integer", minimum: 0, description: "Horizontal screen coordinate in pixels." },
        y: { type: "integer", minimum: 0, description: "Vertical screen coordinate in pixels." },
      },
      required: ["x", "y"],
    },
    annotations: deviceActionAnnotations,
  },
  {
    name: "reeves_swipe",
    title: "Swipe Android screen",
    description: "Swipe between two absolute screen coordinates on the Reeves Android device.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        startX: { type: "integer", minimum: 0, description: "Starting horizontal pixel coordinate." },
        startY: { type: "integer", minimum: 0, description: "Starting vertical pixel coordinate." },
        endX: { type: "integer", minimum: 0, description: "Ending horizontal pixel coordinate." },
        endY: { type: "integer", minimum: 0, description: "Ending vertical pixel coordinate." },
        durationMs: {
          type: "integer",
          minimum: 1,
          maximum: 10_000,
          default: 350,
          description: "Gesture duration in milliseconds.",
        },
      },
      required: ["startX", "startY", "endX", "endY"],
    },
    annotations: deviceActionAnnotations,
  },
  {
    name: "reeves_type",
    title: "Type on Android device",
    description: "Insert text through the focused control on the Reeves Android device.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        text: {
          type: "string",
          minLength: 1,
          maxLength: 16_384,
          description: "Text to insert into the currently focused editable control.",
        },
      },
      required: ["text"],
    },
    annotations: deviceActionAnnotations,
  },
  {
    name: "reeves_back",
    title: "Press Android Back",
    description: "Invoke the Android Back global action on the Reeves device.",
    inputSchema: emptyInputSchema,
    annotations: deviceActionAnnotations,
  },
  {
    name: "reeves_home",
    title: "Press Android Home",
    description: "Invoke the Android Home global action on the Reeves device.",
    inputSchema: emptyInputSchema,
    annotations: deviceActionAnnotations,
  },
  {
    name: "reeves_recents",
    title: "Open Android Recents",
    description: "Invoke the Android Recents global action on the Reeves device.",
    inputSchema: emptyInputSchema,
    annotations: deviceActionAnnotations,
  },
  {
    name: "reeves_sequence",
    title: "Run Android action sequence",
    description:
      "Execute an ordered batch of Android actions locally in one relay round trip, returning indexed results and one final screenshot by default.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        actions: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: { oneOf: sequenceActionSchemas },
          description: "Ordered actions to execute locally on the Reeves Android device.",
        },
        screenshotBefore: { type: "boolean", default: false },
        screenshotAfter: { type: "boolean", default: true },
        stopOnError: { type: "boolean", default: true },
        perActionTimeoutMs: {
          type: "integer",
          minimum: 100,
          maximum: 30_000,
          default: 5_000,
        },
        overallTimeoutMs: {
          type: "integer",
          minimum: 1_000,
          maximum: 120_000,
          default: 60_000,
        },
      },
      required: ["actions"],
    },
    annotations: deviceActionAnnotations,
  },
  {
    name: "reeves_screenshot",
    title: "Capture Android screenshot",
    description:
      "Capture the current Reeves Android display and return its pixels as an MCP image content block with dimensions and capture metadata, without changing device state.",
    inputSchema: emptyInputSchema,
    annotations: readOnlyAnnotations,
  },
]);

export function routeForToolName(toolName) {
  if (typeof toolName !== "string") {
    throw new TypeError("Relay job toolName must be a string.");
  }
  if (toolName.startsWith("codex_")) {
    return CODEX_AGENT_ROUTE;
  }
  if (toolName.startsWith("reeves_")) {
    return REEVES_AGENT_ROUTE;
  }
  throw new TypeError(`Relay job tool namespace is not routable: ${toolName}`);
}

export function routeForAgentKeyId(keyId) {
  return keyId === REEVES_AGENT_KEY_ID ? REEVES_AGENT_ROUTE : CODEX_AGENT_ROUTE;
}

export function isAgentRoute(value) {
  return value === CODEX_AGENT_ROUTE || value === REEVES_AGENT_ROUTE;
}
