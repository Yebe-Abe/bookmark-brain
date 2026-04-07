#!/usr/bin/env node

import fs from "fs/promises";
import path from "path";
import { DATA_ROOT, INBOX_DIR, STATE_DIR, X_POLL_INTERVAL_MS, PROCESS_API_URL, SCREENSHOTS_ENABLED } from "./config.js";
import { pollBookmarks, loadAuth } from "./ingestion/x-bookmarks.js";
import { startProcessingLoop } from "./processing/processor.js";
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
 * Print the MCP config for Claude Desktop / Claude Code.
 * Uses stdio transport — Claude spawns the process directly.
 */
async function printConfig(): Promise<void> {
  const { execSync } = await import("child_process");

  // Resolve absolute paths so Claude Desktop doesn't depend on shell PATH
  let nodePath = process.execPath; // absolute path to current node binary
  const stdioServer = path.resolve(path.dirname(new URL(import.meta.url).pathname), "mcp", "stdio.js");

  // On macOS, also try `which node` in case they're using a version manager
  if (process.platform === "darwin") {
    try {
      const which = execSync("which node", { encoding: "utf8" }).trim();
      if (which) nodePath = which;
    } catch {}
  }

  const entry = { command: nodePath, args: [stdioServer] };

  // Auto-install into Claude Desktop config if on macOS
  if (process.platform === "darwin") {
    const desktopConfig = path.join(
      process.env.HOME || "",
      "Library", "Application Support", "Claude", "claude_desktop_config.json"
    );

    try {
      let config: Record<string, unknown> = {};
      try {
        config = JSON.parse(await fs.readFile(desktopConfig, "utf8"));
      } catch {}

      const servers = (config.mcpServers || {}) as Record<string, unknown>;
      servers["bookmark-brain"] = entry;
      config.mcpServers = servers;

      await fs.mkdir(path.dirname(desktopConfig), { recursive: true });
      await fs.writeFile(desktopConfig, JSON.stringify(config, null, 2) + "\n", "utf8");
      console.log(`\n  Claude Desktop: installed (restart Claude Desktop to pick it up)`);
    } catch {
      console.log(`\n  Claude Desktop — add to ${desktopConfig}:\n`);
      console.log(JSON.stringify({ mcpServers: { "bookmark-brain": entry } }, null, 2));
    }
  }

  console.log(`\n  Claude Code — run this command:\n`);
  console.log(`    claude mcp add-json bookmark-brain '${JSON.stringify(entry)}'\n`);
}

async function main() {
  console.log(`[bookmark-brain] data root: ${DATA_ROOT}`);

  await fs.mkdir(DATA_ROOT, { recursive: true });
  await fs.mkdir(INBOX_DIR, { recursive: true });

  // 1. Start screenshot ingestion (osxphotos + inbox watcher)
  if (SCREENSHOTS_ENABLED) {
    const { startScreenshots } = await import("./ingestion/screenshots.js");
    await startScreenshots();
  } else {
    console.log("[bookmark-brain] screenshots disabled (SCREENSHOTS=false)");
  }

  // 2. Start X bookmarks polling
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

  // 3. Start processing loop
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
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
