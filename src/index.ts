#!/usr/bin/env node

import fs from "fs/promises";
import { DATA_ROOT, INBOX_DIR, MCP_PORT, X_POLL_INTERVAL_MS, PROCESS_API_URL } from "./config.js";
import { pollBookmarks, loadAuth } from "./ingestion/x-bookmarks.js";
import { watchScreenshots } from "./ingestion/screenshots.js";
import { startProcessingLoop } from "./processing/processor.js";
import { startMcpServer } from "./mcp/server.js";
import { startTunnel } from "./tunnel.js";

async function main() {
  console.log(`[bookmark-brain] data root: ${DATA_ROOT}`);

  // Ensure data directories exist
  await fs.mkdir(DATA_ROOT, { recursive: true });
  await fs.mkdir(INBOX_DIR, { recursive: true });

  // 1. Start MCP server (always on)
  startMcpServer();

  // 2. Start tunnel (if configured)
  const tunnelProc = await startTunnel();

  // 3. Start screenshot watcher
  watchScreenshots();

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
    console.log("[bookmark-brain] X bookmarks disabled (complete OAuth flow or set X_BEARER_TOKEN + X_USER_ID)");
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

  // Clean shutdown
  const shutdown = () => {
    console.log("\n[bookmark-brain] shutting down...");
    tunnelProc?.kill();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[bookmark-brain] fatal:", err);
  process.exit(1);
});
