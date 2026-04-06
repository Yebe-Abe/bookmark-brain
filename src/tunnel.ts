import { spawn, type ChildProcess } from "child_process";
import fs from "fs/promises";
import path from "path";
import { MCP_PORT, STATE_DIR, PROCESS_API_URL } from "./config.js";

const TUNNEL_STATE_FILE = path.join(STATE_DIR, "tunnel.json");
const AUTH_FILE = path.join(STATE_DIR, "x-auth.json");

interface TunnelState {
  tunnelToken: string;
  hostname: string;
  mcpEndpoint: string;
}

interface AuthState {
  apiKey?: string;
  userId?: string;
  subdomain?: string;
}

async function loadTunnelState(): Promise<TunnelState | null> {
  try { return JSON.parse(await fs.readFile(TUNNEL_STATE_FILE, "utf8")); }
  catch { return null; }
}

async function saveTunnelState(state: TunnelState): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(TUNNEL_STATE_FILE, JSON.stringify(state, null, 2) + "\n", "utf8");
}

async function loadAuth(): Promise<AuthState | null> {
  try { return JSON.parse(await fs.readFile(AUTH_FILE, "utf8")); }
  catch { return null; }
}

async function hasCloudflared(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("cloudflared", ["--version"], { stdio: "pipe" });
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  });
}

async function provisionTunnel(auth: AuthState): Promise<TunnelState> {
  const res = await fetch(`${PROCESS_API_URL}/api/tunnel/provision`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${auth.apiKey}`,
      "X-User-Id": auth.userId!,
    },
    body: JSON.stringify({ userId: auth.userId }),
  });

  if (!res.ok) {
    throw new Error(`Tunnel provisioning failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as TunnelState;
  await saveTunnelState(data);
  return data;
}

function runTokenTunnel(token: string, hostname: string): ChildProcess {
  console.log(`[tunnel] connecting ${hostname}...`);
  const proc = spawn("cloudflared", ["tunnel", "run", "--token", token], {
    stdio: "inherit",
  });
  proc.on("error", (err) => console.error("[tunnel] error:", err.message));
  proc.on("close", (code) => console.log(`[tunnel] exited with code ${code}`));
  return proc;
}

/**
 * Start the Cloudflare tunnel.
 *
 * Automatic: if the user is logged in and cloudflared is installed,
 * the tunnel is provisioned and started with no extra config needed.
 *
 * Set TUNNEL_MODE=off to disable.
 */
export async function startTunnel(): Promise<ChildProcess | null> {
  if (process.env.TUNNEL_MODE === "off") {
    return null;
  }

  const auth = await loadAuth();
  if (!auth?.apiKey || !auth?.userId) {
    console.log("[tunnel] not logged in — skipping tunnel (run: bookmark-brain login)");
    return null;
  }

  if (!(await hasCloudflared())) {
    console.log("[tunnel] cloudflared not found — install with: brew install cloudflared");
    console.log("[tunnel] MCP server is still available locally at http://127.0.0.1:9876/mcp");
    return null;
  }

  // Use existing tunnel or provision a new one
  let state = await loadTunnelState();

  if (!state) {
    console.log("[tunnel] provisioning tunnel via server...");
    try {
      state = await provisionTunnel(auth);
      console.log(`[tunnel] provisioned: ${state.mcpEndpoint}`);
    } catch (err) {
      console.error("[tunnel] provisioning failed:", (err as Error).message);
      console.log("[tunnel] MCP server is still available locally at http://127.0.0.1:9876/mcp");
      return null;
    }
  }

  console.log(`[tunnel] MCP endpoint: ${state.mcpEndpoint}`);
  return runTokenTunnel(state.tunnelToken, state.hostname);
}
