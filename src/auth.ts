import { exec } from "child_process";
import fs from "fs/promises";
import path from "path";
import { STATE_DIR, PROCESS_API_URL } from "./config.js";

const AUTH_FILE = path.join(STATE_DIR, "x-auth.json");

/**
 * Interactive login flow. Opens browser, polls server, saves all credentials.
 */
export async function login(): Promise<void> {
  if (!PROCESS_API_URL) {
    console.error("Set BOOKMARK_BRAIN_API_URL to your server URL");
    process.exit(1);
  }

  console.log("[login] starting X OAuth flow...");
  const startRes = await fetch(`${PROCESS_API_URL}/auth/x/start`);
  if (!startRes.ok) {
    console.error("[login] failed:", await startRes.text());
    process.exit(1);
  }

  const { authorizeUrl, state } = (await startRes.json()) as { authorizeUrl: string; state: string };

  // Open browser
  const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  exec(`${openCmd} "${authorizeUrl}"`);
  console.log("[login] opened browser — authorize with X...");

  // Poll for completion
  const maxWait = 5 * 60_000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    await new Promise((r) => setTimeout(r, 2000));

    const res = await fetch(`${PROCESS_API_URL}/auth/x/status?state=${state}`);
    if (!res.ok) continue;

    const data = (await res.json()) as { status: string; [key: string]: unknown };

    if (data.status === "complete") {
      await fs.mkdir(STATE_DIR, { recursive: true });
      const { status: _, ...creds } = data;
      await fs.writeFile(AUTH_FILE, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });

      console.log(`[login] authenticated as @${data.username}`);
      console.log(`[login] API key and MCP token saved`);

      // Show MCP config hint if tunnel is set up
      if (data.subdomain) {
        console.log(`[login] your subdomain: ${data.subdomain}`);
      }

      return;
    }

    if (data.status === "expired") {
      console.error("[login] flow expired. Try again.");
      process.exit(1);
    }
  }

  console.error("[login] timed out.");
  process.exit(1);
}
