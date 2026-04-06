import { spawn, type ChildProcess } from "child_process";
import fs from "fs/promises";
import path from "path";
import { MCP_PORT, STATE_DIR, PROCESS_API_URL } from "./config.js";

const TUNNEL_STATE_FILE = path.join(STATE_DIR, "tunnel.json");

interface TunnelState {
  tunnelToken: string;
  hostname: string;
  mcpEndpoint: string;
}

async function loadTunnelState(): Promise<TunnelState | null> {
  try {
    const text = await fs.readFile(TUNNEL_STATE_FILE, "utf8");
    return JSON.parse(text) as TunnelState;
  } catch {
    return null;
  }
}

async function saveTunnelState(state: TunnelState): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(TUNNEL_STATE_FILE, JSON.stringify(state, null, 2) + "\n", "utf8");
}

async function hasCloudflared(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("cloudflared", ["--version"], { stdio: "pipe" });
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  });
}

/**
 * Provision a named tunnel via the server.
 * Server creates the tunnel + DNS record, returns a token the client uses to run it.
 */
async function provisionTunnel(userId: string): Promise<TunnelState> {
  if (!PROCESS_API_URL) {
    throw new Error("BOOKMARK_BRAIN_API_URL required for tunnel provisioning");
  }

  const res = await fetch(`${PROCESS_API_URL}/api/tunnel/provision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId }),
  });

  if (!res.ok) {
    throw new Error(`Tunnel provisioning failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as { tunnelToken: string; hostname: string; mcpEndpoint: string };
  const state: TunnelState = {
    tunnelToken: data.tunnelToken,
    hostname: data.hostname,
    mcpEndpoint: data.mcpEndpoint,
  };

  await saveTunnelState(state);
  return state;
}

/**
 * Run the tunnel using a token from the server.
 * `cloudflared tunnel run --token <token>` — no local cloudflared login needed.
 */
function runTokenTunnel(token: string): ChildProcess {
  console.log(`[tunnel] starting named tunnel...`);
  const proc = spawn("cloudflared", ["tunnel", "run", "--token", token], {
    stdio: "inherit",
  });
  proc.on("error", (err) => console.error("[tunnel] error:", err.message));
  proc.on("close", (code) => console.log(`[tunnel] exited with code ${code}`));
  return proc;
}

/**
 * Quick tunnel fallback — no server needed, but URL changes each restart.
 */
function runQuickTunnel(): ChildProcess {
  console.log(`[tunnel] starting quick tunnel → http://127.0.0.1:${MCP_PORT}`);
  const proc = spawn("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${MCP_PORT}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let urlLogged = false;
  proc.stderr?.on("data", (data: Buffer) => {
    const line = data.toString();
    if (!urlLogged) {
      const match = line.match(/https:\/\/[^\s]+\.trycloudflare\.com/);
      if (match) {
        console.log(`[tunnel] quick tunnel: ${match[0]}/mcp`);
        urlLogged = true;
      }
    }
  });

  proc.on("error", (err) => console.error("[tunnel] error:", err.message));
  proc.on("close", (code) => console.log(`[tunnel] exited with code ${code}`));
  return proc;
}

/**
 * Start the Cloudflare tunnel.
 *
 * TUNNEL_MODE:
 * - "named": stable URL via server-provisioned tunnel (requires BOOKMARK_BRAIN_API_URL)
 * - "quick": ephemeral URL, zero setup
 * - "off": no tunnel (default)
 */
export async function startTunnel(): Promise<ChildProcess | null> {
  const mode = process.env.TUNNEL_MODE || "off";

  if (mode === "off") {
    console.log("[tunnel] disabled (set TUNNEL_MODE=named or TUNNEL_MODE=quick)");
    return null;
  }

  if (!(await hasCloudflared())) {
    console.log("[tunnel] cloudflared not found — install: brew install cloudflared");
    return null;
  }

  if (mode === "quick") {
    return runQuickTunnel();
  }

  // Named tunnel mode — get or create via server
  let state = await loadTunnelState();

  if (!state) {
    const userId = process.env.BOOKMARK_BRAIN_USER_ID;
    if (!userId) {
      console.log("[tunnel] no tunnel credentials found. Set BOOKMARK_BRAIN_USER_ID and BOOKMARK_BRAIN_API_URL to provision one.");
      return null;
    }

    console.log("[tunnel] provisioning named tunnel via server...");
    state = await provisionTunnel(userId);
    console.log(`[tunnel] provisioned: ${state.mcpEndpoint}`);
  }

  console.log(`[tunnel] MCP endpoint: ${state.mcpEndpoint}`);
  return runTokenTunnel(state.tunnelToken);
}
