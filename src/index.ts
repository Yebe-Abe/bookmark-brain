#!/usr/bin/env node

import fs from "fs/promises";
import { DATA_ROOT, X_POLL_INTERVAL_MS, PROCESS_API_URL } from "./config.js";
import { pollBookmarks, loadAuth } from "./ingestion/x-bookmarks.js";
import { processAll, startProcessingLoop } from "./processing/processor.js";
import { login } from "./auth.js";
import { installSchedule, removeSchedule, showSchedule } from "./schedule.js";

const args = process.argv.slice(2);
const command = args.find(a => !a.startsWith("-"));
const watch = args.includes("--watch");

if (command === "login") {
  login().catch((err) => { console.error(err); process.exit(1); });
} else if (command === "schedule") {
  const timeArg = args[1];
  const run = !timeArg ? showSchedule : timeArg === "off" ? removeSchedule : () => installSchedule(timeArg);
  run().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
} else if (command === "help" || command === "--help") {
  console.log(`Usage: bookmark-brain [command] [options]

Commands:
  login            Sign in with X (opens browser)
  schedule <time>  Run daily at a time (e.g. 7am, 2:30pm)
  schedule off     Stop scheduled runs
  schedule         Show current schedule
  (none)           Pull new bookmarks, process, save as markdown, exit

Options:
  --watch          Keep running — poll for new bookmarks every 60s`);
} else {
  main().catch((err) => { console.error("[bookmark-brain] fatal:", err); process.exit(1); });
}

async function main() {
  await fs.mkdir(DATA_ROOT, { recursive: true });

  const auth = await loadAuth();
  const hasLegacyAuth = process.env.X_BEARER_TOKEN && process.env.X_USER_ID;

  if (!auth && !hasLegacyAuth) {
    console.log("Not logged in. Run: bookmark-brain login");
    process.exit(1);
  }

  const hasProcessing = PROCESS_API_URL || process.env.ANTHROPIC_API_KEY;
  const label = auth ? `@${auth!.username}` : "bearer token";

  if (watch) {
    // --watch: poll forever
    console.log(`[bookmark-brain] watching as ${label} (every ${X_POLL_INTERVAL_MS / 1000}s)`);

    const poll = async () => {
      try {
        const n = await pollBookmarks();
        if (n > 0) console.log(`[bookmark-brain] ${n} new bookmark(s)`);
      } catch (err) {
        console.error("[bookmark-brain] poll error:", (err as Error).message);
      }
    };

    await poll();

    if (hasProcessing) {
      startProcessingLoop();
    }

    setInterval(poll, X_POLL_INTERVAL_MS);

    const shutdown = () => { console.log("\n[bookmark-brain] stopped"); process.exit(0); };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } else {
    // Default: one-shot sync
    console.log(`[bookmark-brain] syncing as ${label}...`);

    const count = await pollBookmarks();
    console.log(`[bookmark-brain] ${count} new bookmark(s)`);

    if (hasProcessing && count > 0) {
      await processAll();
    }

    console.log("[bookmark-brain] done");
  }
}
