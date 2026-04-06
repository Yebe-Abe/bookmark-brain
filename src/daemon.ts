import fs from "fs/promises";
import path from "path";
import os from "os";
import { execSync } from "child_process";

const PLIST_NAME = "com.bookmark-brain.daemon";
const PLIST_PATH = path.join(os.homedir(), "Library", "LaunchAgents", `${PLIST_NAME}.plist`);
const LOG_DIR = path.join(os.homedir(), ".bookmark-brain", "logs");

function getNodePath(): string {
  try { return execSync("which node", { encoding: "utf8" }).trim(); }
  catch { return "/usr/local/bin/node"; }
}

function getScriptPath(): string {
  // Resolve the actual dist/index.js location relative to this file
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "index.js");
}

function buildPlist(nodePath: string, scriptPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${scriptPath}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${path.join(LOG_DIR, "stdout.log")}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(LOG_DIR, "stderr.log")}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>`;
}

export async function installDaemon(): Promise<void> {
  if (process.platform !== "darwin") {
    console.log("[daemon] launchd is macOS only. On Linux, use systemd or run in a tmux/screen session.");
    console.log("[daemon] example: node dist/index.js &");
    return;
  }

  const nodePath = getNodePath();
  const scriptPath = getScriptPath();

  // Ensure dirs exist
  await fs.mkdir(path.dirname(PLIST_PATH), { recursive: true });
  await fs.mkdir(LOG_DIR, { recursive: true });

  // Unload existing if present
  try { execSync(`launchctl unload ${PLIST_PATH} 2>/dev/null`); } catch {}

  // Write plist
  const plist = buildPlist(nodePath, scriptPath);
  await fs.writeFile(PLIST_PATH, plist, "utf8");

  // Load it
  execSync(`launchctl load ${PLIST_PATH}`);

  console.log("[daemon] installed and started");
  console.log(`[daemon] plist: ${PLIST_PATH}`);
  console.log(`[daemon] logs:  ${LOG_DIR}/stdout.log`);
  console.log("[daemon] runs at login, restarts if it crashes");
}

export async function uninstallDaemon(): Promise<void> {
  if (process.platform !== "darwin") {
    console.log("[daemon] launchd is macOS only.");
    return;
  }

  try { execSync(`launchctl unload ${PLIST_PATH} 2>/dev/null`); } catch {}

  try {
    await fs.unlink(PLIST_PATH);
    console.log("[daemon] stopped and uninstalled");
  } catch {
    console.log("[daemon] not installed");
  }
}

export async function daemonStatus(): Promise<void> {
  if (process.platform !== "darwin") {
    console.log("[daemon] launchd is macOS only.");
    return;
  }

  try {
    const output = execSync(`launchctl list ${PLIST_NAME} 2>&1`, { encoding: "utf8" });
    console.log("[daemon] running");
    console.log(output);
  } catch {
    console.log("[daemon] not running");
  }

  console.log(`\nLogs: tail -f ${LOG_DIR}/stdout.log`);
}
