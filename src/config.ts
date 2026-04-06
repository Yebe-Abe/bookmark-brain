import path from "path";
import os from "os";

/** Root directory for all bookmark-brain data. Override with BOOKMARK_BRAIN_ROOT env var. */
export const DATA_ROOT =
  process.env.BOOKMARK_BRAIN_ROOT || path.join(os.homedir(), ".bookmark-brain");

export const ITEMS_DIR = path.join(DATA_ROOT, "items");
export const TAGS_DIR = path.join(DATA_ROOT, "tags");
export const STATE_DIR = path.join(DATA_ROOT, "state");
export const INBOX_DIR = path.join(DATA_ROOT, "inbox");

/** MCP HTTP server port. */
export const MCP_PORT = Number(process.env.MCP_PORT || 9876);

/** How often to poll X bookmarks (ms). */
export const X_POLL_INTERVAL_MS = 60_000;

/** How often the processing loop checks for unprocessed items (ms). */
export const PROCESS_INTERVAL_MS = 5_000;

/**
 * Remote processing server URL. If set, items are sent here for Claude processing
 * instead of calling the Claude API directly. This lets users skip needing their own API key.
 */
export const PROCESS_API_URL = process.env.BOOKMARK_BRAIN_API_URL || null;
