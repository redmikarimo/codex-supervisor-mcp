#!/usr/bin/env node

import { McpStdioServer } from "./mcp-server.mjs";
import { CodexSupervisorService } from "./supervisor-service.mjs";
import { createToolRegistry } from "./tool-registry.mjs";

async function main() {
  const service = await CodexSupervisorService.create();
  const toolRegistry = createToolRegistry(service);
  const server = new McpStdioServer({
    service,
    toolRegistry,
  });

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });

  await server.run();
}

main().catch((error) => {
  process.stderr.write(
    `codex-supervisor-mcp failed: ${error?.stack || error?.message || String(error)}\n`,
  );
  process.exitCode = 1;
});
