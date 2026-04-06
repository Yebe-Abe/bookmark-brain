import { exec } from "child_process";
import fs from "fs/promises";
import path from "path";
import { STATE_DIR, PROCESS_API_URL } from "./config.js";

const AUTH_FILE = path.join(STATE_DIR, "x-auth.json");

/**
 * Interactive login flow. Opens browser, polls server for tokens, saves them.
 */
export async function login(): Promise<void> {
  if (!PROCESS_API_URL) {
    console.error("Set BOOKMARK_BRAIN_API_URL to your server (e.g. https://your-app.up.railway.app)");
    process.exit(1);
  }

  // 1. Start the OAuth flow
  console.log("[login] starting X OAuth flow...");
  const startRes = await fetch(`${PROCESS_API_URL}/auth/x/start`);
  if (!startRes.ok) {
    console.error("[login] failed to start OAuth:", await startRes.text());
    process.exit(1);
  }

  const { authorizeUrl, state } = (await startRes.json()) as { authorizeUrl: string; state: string };

  // 2. Open browser
  console.log("[login] opening browser for X authorization...");
  const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  exec(`${openCmd} "${authorizeUrl}"`);
  console.log("[login] waiting for you to authorize in the browser...");

  // 3. Poll for completion
  const maxWait = 5 * 60 * 1000; // 5 minutes
  const pollInterval = 2000; // 2 seconds
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    await new Promise((r) => setTimeout(r, pollInterval));

    const statusRes = await fetch(`${PROCESS_API_URL}/auth/x/status?state=${state}`);
    if (!statusRes.ok) continue;

    const data = (await statusRes.json()) as { status: string; [key: string]: unknown };

    if (data.status === "complete") {
      // 4. Save tokens
      await fs.mkdir(STATE_DIR, { recursive: true });
      const { status: _, ...tokens } = data;
      await fs.writeFile(AUTH_FILE, JSON.stringify(tokens, null, 2) + "\n", { mode: 0o600 });
      console.log(`[login] authenticated as @${data.username}`);
      console.log(`[login] credentials saved to ${AUTH_FILE}`);
      return;
    }

    if (data.status === "expired") {
      console.error("[login] flow expired. Try again.");
      process.exit(1);
    }

    // status === "pending", keep polling
  }

  console.error("[login] timed out waiting for authorization.");
  process.exit(1);
}
