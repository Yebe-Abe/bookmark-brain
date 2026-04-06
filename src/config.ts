import fs from "fs";
import path from "path";
import os from "os";

// Load dotfile (~/.bookmark-brain/config) before anything else
const CONFIG_PATH = path.join(os.homedir(), ".bookmark-brain", "config");
try {
  const lines = fs.readFileSync(CONFIG_PATH, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    // Don't override existing env vars
    if (!process.env[key]) process.env[key] = val;
  }
} catch {}

export const DATA_ROOT =
  process.env.BOOKMARK_BRAIN_ROOT || path.join(os.homedir(), ".bookmark-brain");

export const ITEMS_DIR = path.join(DATA_ROOT, "items");
export const TAGS_DIR = path.join(DATA_ROOT, "tags");
export const STATE_DIR = path.join(DATA_ROOT, "state");
export const INBOX_DIR = path.join(DATA_ROOT, "inbox");

export const MCP_PORT = Number(process.env.MCP_PORT || 9876);
export const X_POLL_INTERVAL_MS = 60_000;
export const PROCESS_INTERVAL_MS = 5_000;
export const SCREENSHOT_POLL_INTERVAL_MS = 60_000;

export const PROCESS_API_URL = process.env.BOOKMARK_BRAIN_API_URL || null;
