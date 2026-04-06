#!/usr/bin/env node

import fs from "fs/promises";
import path from "path";
import { DATA_ROOT, INBOX_DIR, STATE_DIR, X_POLL_INTERVAL_MS, PROCESS_API_URL } from "./config.js";
import { pollBookmarks, loadAuth } from "./ingestion/x-bookmarks.js";
import { startScreenshots } from "./ingestion/screenshots.js";
import { startProcessingLoop } from "./processing/processor.js";
import { startMcpServer } from "./mcp/server.js";
import { startTunnel } from "./tunnel.js";
import { login } from "./auth.js";
import { installDaemon, uninstallDaemon, daemonStatus } from "./daemon.js";

const command = process.argv[2];
const commands: Record<string, () => Promise<void>> = {
  login: () => login(),
  config: () => printConfig(),
  start: () => installDaemon(),
  stop: () => uninstallDaemon(),
  status: () => daemonStatus(),
};

if (command && commands[command]) {
  commands[command]!().catch((err) => { console.error(err); process.exit(1); });
} else if (command === "help" || command === "--help") {
  console.log(`Usage: bookmark-brain <command>

Commands:
  login    Sign in with X (opens browser)
  start    Install and start background daemon
  stop     Stop and uninstall background daemon
  status   Check if daemon is running
  config   Print MCP config for Claude
  (none)   Run in foreground (for debugging)`);
} else {
  main().catch((err) => { console.error("[bookmark-brain] fatal:", err); process.exit(1); });
}

/**
 * Print the MCP config JSON block for Claude Desktop/Code.
 */
async function printConfig(): Promise<void> {
  const authFile = path.join(STATE_DIR, "x-auth.json");
  const tunnelFile = path.join(STATE_DIR, "tunnel.json");

  let mcpToken = "";
  let mcpUrl = "http://127.0.0.1:9876/mcp";

  try {
    const auth = JSON.parse(await fs.readFile(authFile, "utf8"));
    mcpToken = auth.mcpToken || "";
  } catch {}

  try {
    const tunnel = JSON.parse(await fs.readFile(tunnelFile, "utf8"));
    if (tunnel.mcpEndpoint) mcpUrl = tunnel.mcpEndpoint;
  } catch {}

  if (!mcpToken) {
    console.log("Not logged in yet. Run: bookmark-brain login");
    process.exit(1);
  }

  const config = {
    mcpServers: {
      "bookmark-brain": {
        url: mcpUrl,
        headers: {
          Authorization: `Bearer ${mcpToken}`,
        },
      },
    },
  };

  console.log("Add this to your Claude Desktop or Claude Code MCP config:\n");
  console.log(JSON.stringify(config, null, 2));

  console.log("\nClaude Desktop: ~/Library/Application Support/Claude/claude_desktop_config.json");
  console.log("Claude Code:    claude mcp add-json bookmark-brain '" + JSON.stringify(config.mcpServers["bookmark-brain"]) + "'");
}

async function main() {
  console.log(`[bookmark-brain] data root: ${DATA_ROOT}`);

  await fs.mkdir(DATA_ROOT, { recursive: true });
  await fs.mkdir(INBOX_DIR, { recursive: true });

  // 1. Start MCP server (always on)
  startMcpServer();

  // 2. Start tunnel (if configured)
  const tunnelProc = await startTunnel();

  // 3. Start screenshot ingestion (osxphotos + inbox watcher)
  await startScreenshots();

  // 4. Start X bookmarks polling
  const auth = await loadAuth();
  const hasLegacyAuth = process.env.X_BEARER_TOKEN && process.env.X_USER_ID;

  if (auth || hasLegacyAuth) {
    const label = auth ? `@${auth.username}` : "bearer token";
    console.log(`[bookmark-brain] X bookmarks polling as ${label} (every ${X_POLL_INTERVAL_MS / 1000}s)`);

    const count = await pollBookmarks().catch((err) => {
      console.error("[bookmark-brain] initial poll failed:", err.message);
      return 0;
    });
    if (count > 0) console.log(`[bookmark-brain] initial poll: ${count} new bookmark(s)`);

    setInterval(async () => {
      try {
        const n = await pollBookmarks();
        if (n > 0) console.log(`[bookmark-brain] polled ${n} new bookmark(s)`);
      } catch (err) {
        console.error("[bookmark-brain] poll error:", (err as Error).message);
      }
    }, X_POLL_INTERVAL_MS);
  } else {
    console.log("[bookmark-brain] X bookmarks disabled (run: bookmark-brain login)");
  }

  // 5. Start processing loop
  if (PROCESS_API_URL) {
    console.log(`[bookmark-brain] processing via ${PROCESS_API_URL}`);
    startProcessingLoop();
  } else if (process.env.ANTHROPIC_API_KEY) {
    console.log("[bookmark-brain] processing locally via Claude API");
    startProcessingLoop();
  } else {
    console.log("[bookmark-brain] processing disabled (set BOOKMARK_BRAIN_API_URL or ANTHROPIC_API_KEY)");
  }

  console.log("[bookmark-brain] running");

  const shutdown = () => {
    console.log("\n[bookmark-brain] shutting down...");
    tunnelProc?.kill();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
